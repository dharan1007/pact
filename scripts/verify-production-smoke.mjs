import { runProductionTransactionSmoke } from '../src/production-smoke.js';

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`PACT_SMOKE_ENV_REQUIRED:${name}`);
  return value.trim();
}

function parseIntent(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('PACT_SMOKE_INTENT_JSON_INVALID'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PACT_SMOKE_INTENT_JSON_INVALID');
  return parsed;
}

try {
  if (required('PACT_RUNTIME_MODE') !== 'rest-json') throw new Error('PACT_SMOKE_REQUIRES_REST_JSON_RUNTIME');
  const result = await runProductionTransactionSmoke({
    baseUrl: required('PACT_PRODUCTION_URL'),
    adapter: {
      id: required('PACT_REST_ADAPTER_ID'),
      version: process.env.PACT_REST_ADAPTER_VERSION?.trim() || '1.0.0'
    },
    intent: parseIntent(required('PACT_SMOKE_INTENT_JSON')),
    approvalSecret: required('PACT_APPROVAL_SECRET'),
    humanPrincipal: process.env.PACT_SMOKE_HUMAN_PRINCIPAL?.trim() || 'release:production-smoke',
    agentSession: process.env.PACT_SMOKE_AGENT_SESSION?.trim() || 'release:production-smoke'
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || 'PACT_PRODUCTION_SMOKE_FAILED'}\n`);
  process.exitCode = 1;
}
