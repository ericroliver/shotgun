/**
 * src/executor.ts
 * Executes HTTP requests via curl (child_process.spawn).
 * Returns status, headers, body, and duration.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BangerRequest, BangerResponse, EnvVars } from './types.js';

export interface ExecutorOptions {
  timeout?: number;
  followRedirects?: boolean;
}

/**
 * Builds a BangerRequest from test definition + env, then executes it via curl.
 */
export async function executeRequest(
  req: BangerRequest,
  env: EnvVars,
  opts: ExecutorOptions = {},
): Promise<BangerResponse> {
  const timeout = opts.timeout ?? parseInt(env.TIMEOUT ?? '10', 10);
  const tmpId = randomBytes(6).toString('hex');
  const bodyOutFile = join(tmpdir(), `banger-body-${tmpId}.tmp`);
  const headersFile = join(tmpdir(), `banger-headers-${tmpId}.tmp`);

  // Build headers temp file
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...req.headers,
  };

  if (env.AUTH_TOKEN && !headers['Authorization']) {
    const token = env.AUTH_TOKEN;
    headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }

  // Redact auth in logs
  const safeHeaders = { ...headers };
  if (safeHeaders['Authorization']) safeHeaders['Authorization'] = 'Bearer ***';

  // Write headers to temp file (one per line)
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(headersFile, headerLines, 'utf8');

  // Build query string
  const url = buildUrl(req, env);

  // Build curl args
  const curlArgs: string[] = [
    '-s',                              // silent
    '--max-time', String(timeout),
    '-X', req.method,
    '-H', '@' + headersFile,
    '-o', bodyOutFile,
    '-D', '-',                         // dump headers to stdout
    '-w', '\n__BANGER_STATUS__%{http_code}__BANGER_TIME__%{time_total}',
    ...(opts.followRedirects !== false ? ['-L'] : []),
    url,
  ];

  // Request body
  let bodyTmp: string | null = null;
  if (req.body !== undefined && req.body !== null) {
    bodyTmp = join(tmpdir(), `banger-reqbody-${tmpId}.tmp`);
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    writeFileSync(bodyTmp, bodyStr, 'utf8');
    curlArgs.push('--data-binary', `@${bodyTmp}`);
  }

  const startTime = Date.now();

  try {
    const { stdout, stderr } = await spawnPromise('curl', curlArgs);

    const duration = Date.now() - startTime;

    // Parse stdout: response headers + sentinel line with status + time
    const sentinelMatch = stdout.match(/__BANGER_STATUS__(\d+)__BANGER_TIME__([\d.]+)/);
    const status = sentinelMatch ? parseInt(sentinelMatch[1], 10) : 0;

    // Parse response headers from stdout (everything before blank line)
    const responseHeaders = parseResponseHeaders(stdout);

    // Read body from file
    let raw = '';
    if (existsSync(bodyOutFile)) {
      raw = (await import('node:fs')).readFileSync(bodyOutFile, 'utf8');
    }

    let body: unknown = raw;
    try {
      if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
        body = JSON.parse(raw);
      }
    } catch {
      // non-JSON body — keep as string
    }

    if (stderr && process.env.BANGER_DEBUG) {
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
    cleanup(headersFile);
    if (bodyTmp) cleanup(bodyTmp);
  }
}

function buildUrl(req: BangerRequest, _env: EnvVars): string {
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

function spawnPromise(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => resolve({ stdout, stderr }));
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
