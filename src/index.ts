#!/usr/bin/env node
/**
 * src/index.ts — shogun CLI entrypoint
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
  shogun snapshot --file path/...     Update single test baseline

  shogun report                       Show last run report
  shogun report --run <timestamp>     Show specific run

  shogun lint                         Validate all YAML files
  shogun lint --file path/to/test.yaml

  shogun --version                    Print version
  shogun --help                       Print this message
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
