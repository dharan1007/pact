const fail = code => { throw new Error(code); };

const CAS_SCRIPT = [
  "local current = redis.call('GET', KEYS[1])",
  "if not current then return 0 end",
  "local decoded = cjson.decode(current)",
  "if tonumber(decoded.version) ~= tonumber(ARGV[1]) then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "return 1"
].join('\n');

function nonEmpty(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code);
  return value.trim();
}

function encode(value) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) fail('PACT_UPSTASH_VALUE_NOT_JSON');
    return json;
  } catch {
    fail('PACT_UPSTASH_VALUE_NOT_JSON');
  }
}

function decode(value) {
  if (value == null) return null;
  if (typeof value !== 'string') fail('PACT_UPSTASH_CORRUPT_JSON');
  try {
    return JSON.parse(value);
  } catch {
    fail('PACT_UPSTASH_CORRUPT_JSON');
  }
}

export function createUpstashRestAtomicStore({ url, token, fetchImpl = globalThis.fetch } = {}) {
  url = nonEmpty(url, 'PACT_UPSTASH_URL_REQUIRED').replace(/\/+$/, '');
  token = nonEmpty(token, 'PACT_UPSTASH_TOKEN_REQUIRED');
  if (!url.startsWith('https://')) fail('PACT_UPSTASH_HTTPS_REQUIRED');
  if (typeof fetchImpl !== 'function') fail('PACT_UPSTASH_FETCH_REQUIRED');

  async function command(args) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'pact-webmcp/1.0'
        },
        body: JSON.stringify(args)
      });
    } catch {
      fail('PACT_UPSTASH_TRANSPORT_FAILED');
    }

    let body;
    try {
      body = await response.json();
    } catch {
      fail('PACT_UPSTASH_INVALID_RESPONSE');
    }
    if (!response.ok || !body || typeof body !== 'object' || typeof body.error === 'string') {
      fail('PACT_UPSTASH_COMMAND_FAILED');
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'result')) fail('PACT_UPSTASH_INVALID_RESPONSE');
    return body.result;
  }

  async function get(key) {
    key = nonEmpty(key, 'PACT_UPSTASH_KEY_REQUIRED');
    return decode(await command(['GET', key]));
  }

  async function create(key, value) {
    key = nonEmpty(key, 'PACT_UPSTASH_KEY_REQUIRED');
    const result = await command(['SET', key, encode(value), 'NX']);
    if (result === null) return false;
    if (result !== 'OK') fail('PACT_UPSTASH_INVALID_SET_RESPONSE');
    return true;
  }

  async function compareAndSwap(key, expectedVersion, value) {
    key = nonEmpty(key, 'PACT_UPSTASH_KEY_REQUIRED');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail('PACT_UPSTASH_INVALID_EXPECTED_VERSION');
    const result = await command(['EVAL', CAS_SCRIPT, 1, key, expectedVersion, encode(value)]);
    if (result === 0) return false;
    if (result !== 1) fail('PACT_UPSTASH_INVALID_CAS_RESPONSE');
    return true;
  }

  return { get, create, compareAndSwap };
}
