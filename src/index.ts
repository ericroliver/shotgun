#!/usr/bin/env node
/**
 * src/index.ts — shogun CLI entrypoint
 */

import { run } from './commands/run.js';
import { snapshot } from './commands/snapshot.js';
import { report } from './commands/report.js';
import { lint } from './commands/lint.js';
import { spec } from './commands/spec.js';
import { coverage } from './commands/coverage.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const USAGE = `
shogun — shell-first API testing system

Usage:
  shogun run                          Run all tests (default env)
  shogun run --env QA                 Select environment
  shogun run --collection agents      Run one collection
  shogun run --tags smoke             Filter by tag (comma-separated)
  shogun run --suite smoke            Run a named suite
  shogun run --file path/to/test.yaml Run single test file
  shogun run --format json            JSON output (for CI)

  shogun snapshot                     Capture/update all baselines
  shogun snapshot --suite api-testapp-1  Snapshot with suite vars (workspace etc.)
  shogun snapshot --file path/...     Update single test baseline

  shogun report                       Show last run report
  shogun report --run <timestamp>     Show specific run

  shogun lint                         Validate all YAML files
  shogun lint --file path/to/test.yaml

  shogun spec                         List all API endpoints (live from spec)
  shogun spec --env local --endpoint /api/workspaces --method GET
  shogun spec --tag Agents            All endpoints in a tag group
  shogun spec --schema AgentDef       Resolve a named schema ($refs inlined)
  shogun spec --search checkpoint     Keyword search across summaries
  shogun spec --list                  Explicit list mode
  shogun spec --format json           JSON output (for scripting)
  shogun spec [spec-source]           Override spec URL or local file path

  shogun coverage                     API test coverage matrix
  shogun coverage --env local         Load env for live spec fetching
  shogun coverage --collection graph  Scope tests to one collection
  shogun coverage --suite smoke       Scope tests to a named suite
  shogun coverage --tag Agents        Scope spec to a tag group
  shogun coverage --uncovered         Show only uncovered endpoints
  shogun coverage --format json       JSON output (for scripting)

  shogun --version                    Print version
  shogun --help                       Print this message
`.trimStart();

interface ParsedArgs {
  env?: string;
  collection?: string;
  tags?: string[];
  suite?: string;
  file?: string;
  format?: 'pretty' | 'json' | 'tap' | 'markdown';
  run?: string;
  cwd?: string;
  // spec-specific
  specSource?: string;
  endpoint?: string;
  method?: string;
  tag?: string;
  schema?: string;
  search?: string;
  list?: boolean;
  // coverage-specific
  uncovered?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--env':        result.env = argv[++i]; break;
      case '--collection': result.collection = argv[++i]; break;
      case '--tags':       result.tags = argv[++i]!.split(',').map(t => t.trim()); break;
      case '--suite':      result.suite = argv[++i]; break;
      case '--file':       result.file = argv[++i]; break;
      case '--format':     result.format = argv[++i] as ParsedArgs['format']; break;
      case '--run':        result.run = argv[++i]; break;
      case '--cwd':        result.cwd = argv[++i]; break;
      // spec flags
      case '--endpoint':   result.endpoint = argv[++i]; break;
      case '--method':     result.method = argv[++i]; break;
      case '--tag':        result.tag = argv[++i]; break;
      case '--schema':     result.schema = argv[++i]; break;
      case '--search':     result.search = argv[++i]; break;
      case '--list':       result.list = true; break;
      case '--uncovered':  result.uncovered = true; break;
      default:
        // Bare positional (no -- prefix) — used as spec source override
        if (!arg.startsWith('--')) {
          result.specSource = arg;
        }
        break;
    }
  }
  return result;
}

async function main() {
  const [, , subcommand, ...rest] = process.argv;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (subcommand === '--version' || subcommand === '-v') {
    console.log(getVersion());
    process.exit(0);
  }

  const args = parseArgs(rest);

  if (args.cwd) {
    process.chdir(args.cwd);
  }

  switch (subcommand) {
    case 'run': {
      const exitCode = await run({ ...args, format: args.format as 'pretty' | 'json' | 'tap' | undefined });
      process.exit(exitCode);
      break;
    }
    case 'snapshot': {
      const exitCode = await snapshot(args);
      process.exit(exitCode);
      break;
    }
    case 'report': {
      await report({ ...args, format: args.format as 'pretty' | 'json' | 'tap' | undefined });
      process.exit(0);
      break;
    }
    case 'lint': {
      const exitCode = await lint(args);
      process.exit(exitCode);
      break;
    }
    case 'spec': {
      const exitCode = await spec({
        specSource: args.specSource,
        env: args.env,
        endpoint: args.endpoint,
        method: args.method,
        tag: args.tag,
        schema: args.schema,
        search: args.search,
        list: args.list,
        format: args.format as 'pretty' | 'json' | 'markdown' | undefined,
        cwd: args.cwd,
      });
      process.exit(exitCode);
      break;
    }
    case 'coverage': {
      const exitCode = await coverage({
        specSource: args.specSource,
        env: args.env,
        collection: args.collection,
        suite: args.suite,
        tag: args.tag,
        uncovered: args.uncovered,
        format: args.format as 'pretty' | 'json' | 'markdown' | undefined,
        cwd: args.cwd,
      });
      process.exit(exitCode);
      break;
    }
    default: {
      console.error(`Unknown subcommand: ${subcommand}`);
      process.stdout.write(USAGE);
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
