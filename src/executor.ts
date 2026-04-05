/**
 * src/executor.ts
 * Executes HTTP requests via curl (child_process.spawn).
 * Returns status, headers, body, and duration.
 */

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ShotgunRequest, ShotgunResponse, EnvVars } from './types.js';

export interface ExecutorOptions {
  timeout?: number;
  followRedirects?: boolean;
}

/**
 * Builds a ShotgunRequest from test definition + env, then executes it via curl.
 *
 * Performance notes:
 *  - Headers are passed as repeated -H args (no temp file write/unlink).
 *  - Request body is piped to curl's stdin (no temp file write/unlink).
 *  - Only one temp file remains: the response body output file, which is
 *    necessary to cleanly separate the response body from the header dump
 *    that curl writes to stdout via -D -.
 */
export async function executeRequest(
  req: ShotgunRequest,
  env: EnvVars,
  opts: ExecutorOptions = {},
): Promise<ShotgunResponse> {
  const timeout = opts.timeout ?? parseInt(env.TIMEOUT ?? '10', 10);
  const tmpId = randomBytes(6).toString('hex');
  const bodyOutFile = join(tmpdir(), `shotgun-body-${tmpId}.tmp`);

  // Build headers — passed directly as repeated -H args, no temp file.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...req.headers,
  };

  if (env.AUTH_TOKEN && !headers['Authorization']) {
    const token = env.AUTH_TOKEN;
    headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }

  // Build query string
  const url = buildUrl(req, env);

  // Build curl args — one -H per header, no @file indirection.
  const curlArgs: string[] = [
    '-s',                              // silent
    '--max-time', String(timeout),
    '-X', req.method,
  ];

  for (const [k, v] of Object.entries(headers)) {
    curlArgs.push('-H', `${k}: ${v}`);
  }

  curlArgs.push(
    '-o', bodyOutFile,
    '-D', '-',                         // dump response headers to stdout
    '-w', '\n__SHOTGUN_STATUS__%{http_code}__SHOTGUN_TIME__%{time_total}',
    ...(opts.followRedirects !== false ? ['-L'] : []),
    url,
  );

  // Request body — piped to stdin, no temp file.
  let requestBodyStr: string | null = null;
  if (req.body !== undefined && req.body !== null) {
    requestBodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    curlArgs.push('--data-binary', '@-');
  }

  const startTime = Date.now();

  try {
    const { stdout, stderr } = await spawnPromise('curl', curlArgs, requestBodyStr);

    const duration = Date.now() - startTime;

    // Parse stdout: response headers + sentinel line with status + time
    const sentinelMatch = stdout.match(/__SHOTGUN_STATUS__(\d+)__SHOTGUN_TIME__([\d.]+)/);
    const status = sentinelMatch ? parseInt(sentinelMatch[1], 10) : 0;

    // Parse response headers from stdout (everything before blank line)
    const responseHeaders = parseResponseHeaders(stdout);

    // Read response body from temp file
    let raw = '';
    if (existsSync(bodyOutFile)) {
      raw = readFileSync(bodyOutFile, 'utf8');
    }

    let body: unknown = raw;
    try {
      if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
        body = JSON.parse(raw);
      }
    } catch {
      // non-JSON body — keep as string
    }

    if (stderr && process.env.SHOTGUN_DEBUG) {
      console.error(`[executor] curl stderr: ${stderr}`);
    }

    return {
      status,
      headers: responseHeaders,
      body,
      raw,
      duration,
    };
  } finally {
    cleanup(bodyOutFile);
  }
}

function buildUrl(req: ShotgunRequest, _env: EnvVars): string {
  let url = req.url;
  const params = req.params;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    ).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  return url;
}

function parseResponseHeaders(stdout: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = stdout.split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9\-]+):\s*(.+)$/);
    if (m) {
      headers[m[1].toLowerCase()] = m[2].trim();
    }
  }
  return headers;
}

/**
 * Spawn a process and collect stdout/stderr.
 * If `stdinData` is provided it is written to the process's stdin then the
 * stream is closed — this is used to pipe request bodies to curl without
 * creating a temporary file.
 */
function spawnPromise(
  cmd: string,
  args: string[],
  stdinData: string | null = null,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => resolve({ stdout, stderr }));

    if (stdinData !== null) {
      proc.stdin.write(stdinData, 'utf8');
      proc.stdin.end();
    }
  });
}

function cleanup(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* ignore */ }
}

/**
 * Verify curl and jq are available on PATH. Called once at startup.
 */
export async function checkDependencies(): Promise<void> {
  for (const tool of ['curl', 'jq', 'diff']) {
    try {
      await spawnPromise('which', [tool]);
    } catch {
      throw new Error(`Required tool not found on PATH: ${tool}\nPlease install it and try again.`);
    }
  }
}
