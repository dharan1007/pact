import { verifyProductionDeployment } from '../src/production-gate.js';

const baseUrl = process.env.PACT_PRODUCTION_URL;
const expectedReleaseSha = process.env.PACT_EXPECTED_RELEASE_SHA
  || process.env.GITHUB_SHA
  || process.env.VERCEL_GIT_COMMIT_SHA;

try {
  const result = await verifyProductionDeployment({ baseUrl, expectedReleaseSha });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error?.message || 'PACT_PRODUCTION_VERIFICATION_FAILED'}\n`);
  process.exitCode = 1;
}
