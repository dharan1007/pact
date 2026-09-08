const fail = code => { throw new Error(code); };

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('PACT_PRODUCTION_INVALID_URL'); }
  if (url.protocol !== 'https:') fail('PACT_PRODUCTION_REQUIRES_HTTPS');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeSha(value, code) {
  if (typeof value !== 'string') fail(code);
  const sha = value.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sha)) fail(code);
  return sha;
}

async function readJson(response, unavailableCode, invalidCode) {
  if (!response?.ok) fail(unavailableCode);
  let text;
  try { text = await response.text(); } catch { fail(unavailableCode); }
  let value;
  try { value = JSON.parse(text); } catch { fail(invalidCode); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(invalidCode);
  return value;
}

function header(response, name) {
  if (!response?.headers || typeof response.headers.get !== 'function') return '';
  const value = response.headers.get(name);
  return value == null ? '' : String(value).trim();
}

export async function verifyProductionDeployment({
  baseUrl,
  expectedReleaseSha,
  fetchImpl = globalThis.fetch,
  expectedRepository = 'https://github.com/dharan1007/pact'
} = {}) {
  if (typeof fetchImpl !== 'function') fail('PACT_PRODUCTION_FETCH_REQUIRED');
  const base = normalizeBaseUrl(baseUrl);
  const expectedSha = normalizeSha(expectedReleaseSha, 'PACT_PRODUCTION_EXPECTED_RELEASE_REQUIRED');

  let provenanceResponse;
  try {
    provenanceResponse = await fetchImpl(`${base}/release-provenance.json`, {
      method: 'GET',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' }
    });
  } catch (cause) {
    throw new Error('PACT_PRODUCTION_PROVENANCE_UNAVAILABLE', { cause });
  }
  const provenance = await readJson(
    provenanceResponse,
    'PACT_PRODUCTION_PROVENANCE_UNAVAILABLE',
    'PACT_PRODUCTION_PROVENANCE_INVALID'
  );
  if (provenance.schema !== 1 || provenance.buildContract !== 'pact-release-v1' || provenance.sourceRepository !== expectedRepository) {
    fail('PACT_PRODUCTION_PROVENANCE_INVALID');
  }
  const deployedSha = normalizeSha(provenance.sourceCommit, 'PACT_PRODUCTION_PROVENANCE_INVALID');
  if (deployedSha !== expectedSha) fail('PACT_PRODUCTION_RELEASE_MISMATCH');

  let authorityResponse;
  try {
    authorityResponse = await fetchImpl(`${base}/api/pact`, {
      method: 'GET',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' }
    });
  } catch (cause) {
    throw new Error('PACT_PRODUCTION_AUTHORITY_UNAVAILABLE', { cause });
  }
  if (authorityResponse?.status !== 405 || header(authorityResponse, 'allow').toUpperCase() !== 'POST') {
    fail('PACT_PRODUCTION_AUTHORITY_UNAVAILABLE');
  }
  const authoritySha = normalizeSha(header(authorityResponse, 'x-pact-release'), 'PACT_PRODUCTION_AUTHORITY_RELEASE_INVALID');
  if (authoritySha !== expectedSha) fail('PACT_PRODUCTION_AUTHORITY_RELEASE_MISMATCH');

  return Object.freeze({
    baseUrl: base,
    releaseSha: deployedSha,
    authorityReachable: true,
    sourceRepository: provenance.sourceRepository,
    buildContract: provenance.buildContract
  });
}
