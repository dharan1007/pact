const clone = value => value === undefined ? undefined : structuredClone(value);
const fail = code => { throw new Error(code); };

const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, decoded = pcall(cjson.decode, current)
if not ok or type(decoded) ~= 'table' or decoded['version'] ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

function assertHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('PACT_REDIS_INVALID_URL'); }
  if (url.protocol !== 'https:') fail('PACT_REDIS_REQUIRES_HTTPS');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
}

function validateKey(key) {
  key = nonEmpty(key, 'PACT_REDIS_KEY_REQUIRED');
  if (key.length > 512) fail('PACT_REDIS_INVALID_KEY');
  return key;
}

function validateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.version) || value.version < 0) {
    fail('PACT_REDIS_INVALID_RECORD');
  }
  return clone(value);
}

export function createRedisAuthorityStore({ url, token, fetchImpl = globalThis.fetch, prefix = 'pact:authority:', timeoutMs = 5_000 } = {}) {
  const endpoint = assertHttpsUrl(url);
  token = nonEmpty(token, 'PACT_REDIS_TOKEN_REQUIRED');
  if (typeof fetchImpl !== 'function') fail('PACT_REDIS_FETCH_REQUIRED');
  if (typeof prefix !== 'string' || prefix.length < 1 || prefix.length > 128) fail('PACT_REDIS_INVALID_PREFIX');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) fail('PACT_REDIS_INVALID_TIMEOUT');

  const redisKey = key => `${prefix}${validateKey(key)}`;

  async function command(args) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('PACT_REDIS_TIMEOUT')), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json'
        },
        body: JSON.stringify(args),
        signal: controller.signal
      });
      let body;
      try { body = await response.json(); } catch { fail('PACT_REDIS_INVALID_RESPONSE'); }
      if (!response.ok) {
        const error = new Error('PACT_REDIS_HTTP_ERROR');
        error.status = response.status;
        error.details = body;
        throw error;
      }
      if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'result')) fail('PACT_REDIS_INVALID_RESPONSE');
      return body.result;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('PACT_REDIS_TIMEOUT', { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function get(key) {
    const result = await command(['GET', redisKey(key)]);
    if (result == null) return null;
    if (typeof result !== 'string') fail('PACT_REDIS_CORRUPT_RECORD');
    try { return validateRecord(JSON.parse(result)); } catch (error) {
      if (error?.message === 'PACT_REDIS_INVALID_RECORD') throw new Error('PACT_REDIS_CORRUPT_RECORD', { cause: error });
      throw new Error('PACT_REDIS_CORRUPT_RECORD', { cause: error });
    }
  }

  async function create(key, value) {
    const record = validateRecord(value);
    const result = await command(['SET', redisKey(key), JSON.stringify(record), 'NX']);
    if (result === 'OK') return true;
    if (result == null) return false;
    fail('PACT_REDIS_INVALID_RESPONSE');
  }

  async function compareAndSwap(key, expectedVersion, value) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('PACT_REDIS_INVALID_EXPECTED_VERSION');
    const record = validateRecord(value);
    const result = await command(['EVAL', CAS_SCRIPT, '1', redisKey(key), String(expectedVersion), JSON.stringify(record)]);
    if (result === 1 || result === '1') return true;
    if (result === 0 || result === '0') return false;
    fail('PACT_REDIS_INVALID_RESPONSE');
  }

  return { get, create, compareAndSwap };
}
