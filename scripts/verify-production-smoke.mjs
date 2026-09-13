import { resolveSmokeConfig, runProductionTransactionSmoke } from '../src/production-smoke.js';

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`PACT_SMOKE_ENV_REQUIRED:${name}`);
  return value.trim();
}

try {
  const { adapter, intent } = resolveSmokeConfig(process.env);
  const result = await runProductionTransactionSmoke({
    baseUrl: required('PACT_PRODUCTION_URL'),
    adapter,
    intent,
    approvalSecret: required('PACT_APPROVAL_SECRET'),
    humanPrincipal: process.env.PACT_SMOKE_HUMAN_PRINCIPAL?.trim() || 'release:production-smoke',
    agentSession: process.env.PACT_SMOKE_AGENT_SESSION?.trim() || 'release:production-smoke'
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || 'PACT_PRODUCTION_SMOKE_FAILED'}\n`);
  process.exitCode = 1;
}
