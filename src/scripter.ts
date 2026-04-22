/**
 * src/scripter.ts
 * Executes inline TypeScript pre/post scripts from test definitions.
 * Scripts receive a ShogunContext and run via tsx eval.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type {
  ShogunContext,
  ShogunRequest,
  ShogunResponse,
  EnvVars,
  ShogunAssertionError as ShogunAssertionErrorType,
} from './types.js';
import { ShogunAssertionError } from './types.js';

export interface ScriptRunResult {
  passed: boolean;
  error?: string;
  logs: string[];
  /** Mutations applied to the request (from pre-script) */
  requestMutations?: Partial<ShogunRequest>;
  /** Mutations applied to shared vars (from any script) */
  varMutations?: Record<string, unknown>;
}

export type SharedVars = Record<string, unknown>;

/**
 * Runs a pre or post script in a sandboxed context.
 * Uses a JSON message-passing channel over stdout to return mutations and logs.
 */
export async function runScript(
  scriptSource: string,
  ctx: {
    env: EnvVars;
    vars: SharedVars;
    request: ShogunRequest;
    response?: ShogunResponse;
    scriptsDir: string;
  },
): Promise<ScriptRunResult> {
  const tmpId = randomBytes(6).toString('hex');
  const scriptFile = join(tmpdir(), `shogun-script-${tmpId}.mts`);

  // Load available shared scripts
  const sharedScripts = loadSharedScriptImports(ctx.scriptsDir);

  const wrapper = buildScriptWrapper(scriptSource, ctx, sharedScripts);
  writeFileSync(scriptFile, wrapper, 'utf8');

  try {
    const result = await executeScript(scriptFile);
    return result;
  } finally {
    cleanup(scriptFile);
  }
}

function buildScriptWrapper(
  source: string,
  ctx: {
    env: EnvVars;
    vars: SharedVars;
    request: ShogunRequest;
    response?: ShogunResponse;
    scriptsDir: string;
  },
  sharedScripts: Record<string, string>,
): string {
  const sharedImports = Object.entries(sharedScripts)
    .map(([name, path]) => `import * as _script_${name} from ${JSON.stringify(path)};`)
    .join('\n');

  const scriptNames = Object.keys(sharedScripts)
    .map(name => `${name}: _script_${name}`)
    .join(', ');

  // Serialize context data for injection
  const ctxData = JSON.stringify({
    env: ctx.env,
    vars: ctx.vars,
    request: ctx.request,
    response: ctx.response ?? null,
  });

  return `
${sharedImports}

// ---- shogun script runtime ----

const __ctxData = ${ctxData};

const __logs: string[] = [];
const __mutations: Record<string, unknown> = {};

const ctx = {
  env: __ctxData.env as Record<string, string>,
  vars: __ctxData.vars as Record<string, unknown>,
  request: __ctxData.request as Record<string, unknown>,
  response: __ctxData.response as Record<string, unknown> | null,
  scripts: { ${scriptNames} },

  assert(condition: boolean, message: string): void {
    if (!condition) {
      const err = new Error(message);
      err.name = 'ShogunAssertionError';
      throw err;
    }
  },

  log(message: string): void {
    __logs.push(String(message));
    process.stderr.write('[script] ' + String(message) + '\\n');
  },

  http: {
    async get(path: string, opts?: Record<string, unknown>) {
      return __httpCall('GET', path, undefined, opts);
    },
    async post(path: string, body: unknown, opts?: Record<string, unknown>) {
      return __httpCall('POST', path, body, opts);
    },
    async put(path: string, body: unknown, opts?: Record<string, unknown>) {
      return __httpCall('PUT', path, body, opts);
    },
    async patch(path: string, body: unknown, opts?: Record<string, unknown>) {
      return __httpCall('PATCH', path, body, opts);
    },
    async delete(path: string, opts?: Record<string, unknown>) {
      return __httpCall('DELETE', path, undefined, opts);
    },
  },
};

async function __httpCall(method: string, path: string, body?: unknown, _opts?: unknown) {
  const baseUrl = ctx.env.BASE_URL ?? '';
  const url = path.startsWith('http') ? path : baseUrl + path;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (ctx.env.AUTH_TOKEN) {
    const t = ctx.env.AUTH_TOKEN;
    headers['Authorization'] = t.startsWith('Bearer ') ? t : 'Bearer ' + t;
  }

  // Always log the outgoing request so failures show full context
  ctx.log(\`\${method} \${url}\`);
  if (body !== undefined) {
    ctx.log(\`  request body: \${JSON.stringify(body)}\`);
  }
  const safeHeaders = { ...headers };
  if (safeHeaders['Authorization']) {
    safeHeaders['Authorization'] = safeHeaders['Authorization'].replace(/(Bearer\\s+)(.{4}).*/, '$1$2…');
  }
  ctx.log(\`  request headers: \${JSON.stringify(safeHeaders)}\`);

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep string */ }

  // Log status; for non-2xx also dump the response body so failures are self-diagnosable
  ctx.log(\`  → \${res.status}\`);
  if (res.status < 200 || res.status >= 300) {
    const snippet = text.length > 500 ? text.slice(0, 500) + '…' : text;
    ctx.log(\`  response body: \${snippet}\`);
  }

  return { status: res.status, body: parsed, raw: text, headers: Object.fromEntries(res.headers.entries()), duration: 0 };
}

// ---- user script ----

async function __runUserScript() {
  ${source}
}

await __runUserScript();

// ---- output mutations and logs via stdout JSON ----
const __output = {
  request: ctx.request,
  vars: ctx.vars,
  logs: __logs,
};
process.stdout.write(JSON.stringify(__output) + '\\n');
`;
}

async function executeScript(scriptFile: string): Promise<ScriptRunResult> {
  const logs: string[] = [];

  return new Promise((resolve) => {
    // Use tsx to execute the TypeScript script
    const proc = spawn('npx', ['tsx', scriptFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      // Collect [script] log lines
      for (const line of text.split('\n')) {
        if (line.startsWith('[script] ')) {
          logs.push(line.slice(9));
        }
      }
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        // Check if it's an assertion error
        const assertMatch = stderr.match(/ShogunAssertionError: (.+)/);
        const errorMsg = assertMatch
          ? assertMatch[1]
          : stderr.trim() || `Script exited with code ${code}`;

        resolve({ passed: false, error: errorMsg, logs });
        return;
      }

      // Parse JSON output from last line of stdout
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];

      try {
        const output = JSON.parse(lastLine) as {
          request?: Partial<ShogunRequest>;
          vars?: Record<string, unknown>;
          logs?: string[];
        };
        resolve({
          passed: true,
          logs: [...logs, ...(output.logs ?? [])],
          requestMutations: output.request,
          varMutations: output.vars,
        });
      } catch {
        resolve({ passed: true, logs });
      }
    });

    proc.on('error', (err) => {
      resolve({ passed: false, error: `Failed to spawn tsx: ${err.message}`, logs });
    });
  });
}

function loadSharedScriptImports(scriptsDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(scriptsDir)) return result;

  const files = readdirSync(scriptsDir).filter(f => f.endsWith('.ts'));
  for (const file of files) {
    const name = file.replace('.ts', '');
    result[name] = join(scriptsDir, file);
  }
  return result;
}

function cleanup(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* ignore */ }
}
