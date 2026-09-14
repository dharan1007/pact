import { readFileSync } from 'node:fs';
import { createReleaseLock } from '../src/release-lock.js';
import { diffReleaseLocks } from '../src/release-diff.js';
import { evaluateDrift } from '../src/release-drift.js';
import { evaluateGate } from '../src/release-gate.js';

const fail = code => { throw new Error(code); };

const COMMANDS = {
  capture: {
    usage: 'capture --descriptor <file> [--now <ms>]',
    flags: ['--descriptor', '--now']
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

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS[command]) fail('PACT_RELEASE_CLI_UNKNOWN_COMMAND');
  const spec = COMMANDS[command];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!spec.flags.includes(flag)) fail(`PACT_RELEASE_CLI_UNKNOWN_FLAG:${flag}`);
    const value = rest[index + 1];
    if (value == null || value.startsWith('--')) fail(`PACT_RELEASE_CLI_FLAG_VALUE_REQUIRED:${flag}`);
    if (Object.prototype.hasOwnProperty.call(options, flag)) fail(`PACT_RELEASE_CLI_DUPLICATE_FLAG:${flag}`);
    options[flag] = value;
    index += 1;
  }
  for (const flag of spec.flags.filter(entry => !['--now', '--policy', '--pinned', '--observed'].includes(entry))) {
    if (options[flag] == null) fail(`PACT_RELEASE_CLI_FLAG_REQUIRED:${flag}`);
  }
  return { command, options };
}

function readJson(path, code) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(code);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${code}_INVALID_JSON`);
  }
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
