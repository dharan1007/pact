const SHA40 = /^[a-f0-9]{40}$/;

function normalizedCandidate(value) {
  if (value == null || String(value).trim() === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!SHA40.test(normalized)) throw new Error('PACT_RUNTIME_INVALID_RELEASE_SHA');
  return normalized;
}

export function resolveReleaseSha(env = {}, { required = false } = {}) {
  const candidates = [
    ['PACT_SOURCE_COMMIT', normalizedCandidate(env?.PACT_SOURCE_COMMIT)],
    ['VERCEL_GIT_COMMIT_SHA', normalizedCandidate(env?.VERCEL_GIT_COMMIT_SHA)],
    ['GITHUB_SHA', normalizedCandidate(env?.GITHUB_SHA)]
  ].filter(([, value]) => value != null);

  if (candidates.length === 0) {
    if (required) throw new Error('PACT_RUNTIME_RELEASE_SHA_REQUIRED');
    return null;
  }

  const unique = new Set(candidates.map(([, value]) => value));
  if (unique.size !== 1) throw new Error('PACT_RUNTIME_RELEASE_SHA_CONFLICT');
  return candidates[0][1];
}

export function describeReleaseProvenance(env = {}) {
  const sourceCommit = resolveReleaseSha(env);
  const sources = ['PACT_SOURCE_COMMIT', 'VERCEL_GIT_COMMIT_SHA', 'GITHUB_SHA']
    .filter(name => env?.[name] != null && String(env[name]).trim() !== '');
  return {
    sourceCommit,
    sources,
    commitProvenance: sourceCommit ? 'validated-consistent-build-environment' : 'unavailable'
  };
}
