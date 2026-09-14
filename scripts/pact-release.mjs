import { readFileSync } from 'node:fs';
import { createReleaseLock } from '../src/release-lock.js';
import { diffReleaseLocks } from '../src/release-diff.js';
import { evaluateDrift } from '../src/release-drift.js';
import { evaluateGate } from '../src/release-gate.js';
import {
  discoverGit,
  discoverPackage,
  discoverMcpServer,
  discoverOpenaiModel,
  discoverAnthropicModel,
  composeDescriptor
} from '../src/release-discover.js';

const fail = code => { throw new Error(code); };

const COMMANDS = {
  capture: {
    usage: 'capture --descriptor <file|-> [--now <ms>]',
    flags: ['--descriptor', '--now']
  },
  discover: {
    usage: 'discover --agent <name> --environment <env> [--git] [--package-root <dir>] [--mcp <url>]... [--openai-model <id>] [--anthropic-model <id>]',
    flags: ['--agent', '--environment', '--git', '--package-root', '--mcp', '--openai-model', '--anthropic-model']
  },
  diff: {
    usage: 'diff --before <lock-file> --after <lock-file>',
    flags: ['--before', '--after']
  },
  drift: {
    usage: 'drift --pinned <lock-file> --observed <descriptor-file>',
    flags: ['--pinned', '--observed']
  },
  gate: {
    usage: 'gate --before <lock-file> --after <lock-file> [--policy <file>] [--pinned <lock-file> --observed <descriptor-file>]',
    flags: ['--before', '--after', '--policy', '--pinned', '--observed']
  }
};

function usage() {
  const lines = ['usage: pact-release <command> [options]', 'commands:'];
  for (const [name, command] of Object.entries(COMMANDS)) lines.push(`  ${name} ${command.usage}`);
  lines.push('gate exits 0 on ALLOW/WARN and 1 on BLOCK; all other failures exit 2.');
  return lines.join('\n');
}

const VALUELESS_FLAGS = new Set(['--git']);
const REPEATABLE_FLAGS = new Set(['--mcp']);
const OPTIONAL_FLAGS = new Set(['--now', '--policy', '--pinned', '--observed', '--git', '--package-root', '--mcp', '--openai-model', '--anthropic-model']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS[command]) fail('PACT_RELEASE_CLI_UNKNOWN_COMMAND');
  const spec = COMMANDS[command];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!spec.flags.includes(flag)) fail(`PACT_RELEASE_CLI_UNKNOWN_FLAG:${flag}`);
    if (VALUELESS_FLAGS.has(flag)) {
      if (Object.prototype.hasOwnProperty.call(options, flag)) fail(`PACT_RELEASE_CLI_DUPLICATE_FLAG:${flag}`);
      options[flag] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value == null || value.startsWith('--')) fail(`PACT_RELEASE_CLI_FLAG_VALUE_REQUIRED:${flag}`);
    if (REPEATABLE_FLAGS.has(flag)) {
      options[flag] = [...(options[flag] ?? []), value];
    } else {
      if (Object.prototype.hasOwnProperty.call(options, flag)) fail(`PACT_RELEASE_CLI_DUPLICATE_FLAG:${flag}`);
      options[flag] = value;
    }
    index += 1;
  }
  for (const flag of spec.flags.filter(entry => !OPTIONAL_FLAGS.has(entry))) {
    if (options[flag] == null) fail(`PACT_RELEASE_CLI_FLAG_REQUIRED:${flag}`);
  }
  return { command, options };
}

function readJson(path, code) {
  let text;
  try {
    text = readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch {
    fail(code);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${code}_INVALID_JSON`);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') fail(`PACT_RELEASE_CLI_ENV_REQUIRED:${name}`);
  return value;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'capture') {
    const descriptor = readJson(options['--descriptor'], 'PACT_RELEASE_CLI_DESCRIPTOR_UNREADABLE');
    const now = options['--now'] == null ? undefined : Number(options['--now']);
    if (now !== undefined && (!Number.isSafeInteger(now) || now < 0)) fail('PACT_RELEASE_CLI_NOW_INVALID');
    emit(await createReleaseLock(descriptor, now === undefined ? {} : { now: () => now }));
    return 0;
  }
  if (command === 'discover') {
    const discoveries = [];
    if (options['--git']) discoveries.push(discoverGit({}));
    if (options['--package-root'] != null) discoveries.push(discoverPackage({ root: options['--package-root'] }));
    for (const url of options['--mcp'] ?? []) discoveries.push(await discoverMcpServer({ url }));
    if (options['--openai-model'] != null) {
      discoveries.push(await discoverOpenaiModel({
        apiKey: requiredEnv('OPENAI_API_KEY'),
        model: options['--openai-model']
      }));
    }
    if (options['--anthropic-model'] != null) {
      discoveries.push(await discoverAnthropicModel({
        apiKey: requiredEnv('ANTHROPIC_API_KEY'),
        model: options['--anthropic-model']
      }));
    }
    if (discoveries.length === 0) fail('PACT_RELEASE_CLI_DISCOVER_SOURCE_REQUIRED');
    const { descriptor, provenance } = composeDescriptor({
      agent: options['--agent'],
      environment: options['--environment'],
      discoveries
    });
    process.stderr.write(`discovered: ${JSON.stringify(provenance)}\n`);
    emit(descriptor);
    return 0;
  }
  if (command === 'diff') {
    emit(await diffReleaseLocks(
      readJson(options['--before'], 'PACT_RELEASE_CLI_BEFORE_UNREADABLE'),
      readJson(options['--after'], 'PACT_RELEASE_CLI_AFTER_UNREADABLE')
    ));
    return 0;
  }
  if (command === 'drift') {
    emit(await evaluateDrift(
      readJson(options['--pinned'], 'PACT_RELEASE_CLI_PINNED_UNREADABLE'),
      readJson(options['--observed'], 'PACT_RELEASE_CLI_OBSERVED_UNREADABLE')
    ));
    return 0;
  }
  const diff = await diffReleaseLocks(
    readJson(options['--before'], 'PACT_RELEASE_CLI_BEFORE_UNREADABLE'),
    readJson(options['--after'], 'PACT_RELEASE_CLI_AFTER_UNREADABLE')
  );
  let drift = null;
  if (options['--pinned'] != null || options['--observed'] != null) {
    if (options['--pinned'] == null || options['--observed'] == null) fail('PACT_RELEASE_CLI_DRIFT_PAIR_REQUIRED');
    drift = await evaluateDrift(
      readJson(options['--pinned'], 'PACT_RELEASE_CLI_PINNED_UNREADABLE'),
      readJson(options['--observed'], 'PACT_RELEASE_CLI_OBSERVED_UNREADABLE')
    );
  }
  const policy = options['--policy'] == null ? {} : readJson(options['--policy'], 'PACT_RELEASE_CLI_POLICY_UNREADABLE');
  const gate = evaluateGate({ diff, drift, policy });
  emit(gate);
  return gate.decision === 'BLOCK' ? 1 : 0;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    process.stderr.write(`${error?.message || 'PACT_RELEASE_CLI_FAILED'}\n${usage()}\n`);
    process.exitCode = 2;
  }
}
