import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const fail = code => { throw new Error(code); };
const EXPECTED_REPOSITORY = 'https://github.com/dharan1007/pact';
const EXPECTED_BUILD_CONTRACT = 'pact-release-v1';
const REQUIRED_STATIC_FILES = [
  'release-provenance.json',
  'release-manifest.json',
  'sdk/rest-resource.js',
  'sdk/server-runtime.js',
  'sdk/agent-bridge.js'
];

function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

async function jsonFile(file, code) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { fail(code); }
  try { return JSON.parse(text); } catch { fail(code); }
}

async function findPactFunction(functionsDir) {
  const queue = [functionsDir];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      const normalized = child.split(path.sep).join('/');
      if (normalized.endsWith('/api/pact.func')) return child;
      queue.push(child);
    }
  }
  return null;
}

export async function verifyPrebuiltArtifact({
  outputDir = process.env.PACT_PREBUILT_DIR || path.join(process.cwd(), '.vercel', 'output'),
  expectedSha = process.env.PACT_SOURCE_COMMIT
} = {}) {
  if (!validSha(expectedSha)) fail('PACT_PREBUILT_EXPECTED_SHA_INVALID');

  const config = await jsonFile(path.join(outputDir, 'config.json'), 'PACT_PREBUILT_CONFIG_INVALID');
  if (config?.version !== 3) fail('PACT_PREBUILT_CONFIG_VERSION_INVALID');

  const staticDir = path.join(outputDir, 'static');
  const provenance = await jsonFile(path.join(staticDir, 'release-provenance.json'), 'PACT_PREBUILT_PROVENANCE_MISSING');
  if (provenance?.schema !== 1) fail('PACT_PREBUILT_PROVENANCE_SCHEMA_INVALID');
  if (provenance?.sourceCommit !== expectedSha) fail('PACT_PREBUILT_SOURCE_SHA_MISMATCH');
  if (provenance?.sourceRepository !== EXPECTED_REPOSITORY) fail('PACT_PREBUILT_SOURCE_REPOSITORY_MISMATCH');
  if (provenance?.buildContract !== EXPECTED_BUILD_CONTRACT) fail('PACT_PREBUILT_BUILD_CONTRACT_MISMATCH');

  const manifest = await jsonFile(path.join(staticDir, 'release-manifest.json'), 'PACT_PREBUILT_MANIFEST_MISSING');
  if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object') {
    fail('PACT_PREBUILT_MANIFEST_INVALID');
  }
  for (const required of REQUIRED_STATIC_FILES) {
    if (required === 'release-manifest.json') continue;
    if (typeof manifest.files[required] !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.files[required])) {
      fail(`PACT_PREBUILT_REQUIRED_STATIC_FILE_MISSING:${required}`);
    }
  }

  const pactFunction = await findPactFunction(path.join(outputDir, 'functions'));
  if (!pactFunction) fail('PACT_PREBUILT_PACT_FUNCTION_MISSING');
  const functionConfig = await jsonFile(path.join(pactFunction, '.vc-config.json'), 'PACT_PREBUILT_PACT_FUNCTION_CONFIG_MISSING');
  if (typeof functionConfig?.runtime !== 'string' || !functionConfig.runtime.startsWith('nodejs')) {
    fail('PACT_PREBUILT_PACT_FUNCTION_RUNTIME_INVALID');
  }

  return {
    sourceCommit: expectedSha,
    buildContract: provenance.buildContract,
    functionPath: path.relative(outputDir, pactFunction).split(path.sep).join('/')
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const result = await verifyPrebuiltArtifact();
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    console.error(error?.message || 'PACT_PREBUILT_VERIFICATION_FAILED');
    process.exitCode = 1;
  }
}
