#!/usr/bin/env node
/**
 * src/index.ts — shotgun CLI entrypoint
 */

import { run } from './commands/run.js';
import { snapshot } from './commands/snapshot.js';
import { report } from './commands/report.js';
import { lint } from './commands/lint.js';
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
shotgun — shell-first API testing system

Usage:
  shotgun run                          Run all tests (default env)
  shotgun run --env QA                 Select environment
  shotgun run --collection agents      Run one collection
  shotgun run --tags smoke             Filter by tag (comma-separated)
  shotgun run --suite smoke            Run a named suite
  shotgun run --file path/to/test.yaml Run single test file
  shotgun run --format json            JSON output (for CI)

  shotgun snapshot                     Capture/update all baselines
  shotgun snapshot --file path/...     Update single test baseline

  shotgun report                       Show last run report
  shotgun report --run <timestamp>     Show specific run

  shotgun lint                         Validate all YAML files
  shotgun lint --file path/to/test.yaml

  shotgun --version                    Print version
  shotgun --help                       Print this message
`.trimStart();

interface ParsedArgs {
  env?: string;
  collection?: string;
  tags?: string[];
  suite?: string;
  file?: string;
  format?: 'pretty' | 'json' | 'tap';
  run?: string;
  cwd?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--env':        result.env = argv[++i]; break;
      case '--collection': result.collection = argv[++i]; break;
      case '--tags':       result.tags = argv[++i].split(',').map(t => t.trim()); break;
      case '--suite':      result.suite = argv[++i]; break;
      case '--file':       result.file = argv[++i]; break;
      case '--format':     result.format = argv[++i] as ParsedArgs['format']; break;
      case '--run':        result.run = argv[++i]; break;
      case '--cwd':        result.cwd = argv[++i]; break;
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
      const exitCode = await run(args);
      process.exit(exitCode);
      break;
    }
    case 'snapshot': {
      const exitCode = await snapshot(args);
      process.exit(exitCode);
      break;
    }
    case 'report': {
      await report(args);
      process.exit(0);
      break;
    }
    case 'lint': {
      const exitCode = await lint(args);
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
