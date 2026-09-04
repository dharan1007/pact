import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactHttpHandler } from '../src/http-handler.js';

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; }
  };
}

function makeService() {
  const calls = [];
  const service = {};
  for (const action of ['preview', 'approve', 'commit', 'verify', 'receipt', 'inspect']) {
    service[action] = async payload => {
      calls.push({ action, payload });
      return { ok: true, action, payload };
    };
  }
  return { service, calls };
}

test('PACT HTTP handler dispatches only canonical actions and emits security/cache headers', async () => {
  const { service, calls } = makeService();
  const handler = createPactHttpHandler({ service, releaseSha: 'abc123' });
  const response = makeResponse();
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { action: 'preview', adapter: { id: 'example.flags', version: '1.0.0' }, intent: { key: 'beta', value: true } }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-pact-release'], 'abc123');
  assert.deepEqual(calls, [{
    action: 'preview',
    payload: { adapter: { id: 'example.flags', version: '1.0.0' }, intent: { key: 'beta', value: true } }
  }]);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.action, 'preview');
});

test('PACT HTTP handler rejects method, media type and unknown actions without invoking service', async () => {
  const { service, calls } = makeService();
  const handler = createPactHttpHandler({ service });

  const getResponse = makeResponse();
  await handler({ method: 'GET', headers: {}, body: null }, getResponse);
  assert.equal(getResponse.statusCode, 405);
  assert.equal(getResponse.headers.allow, 'POST');

  const mediaResponse = makeResponse();
  await handler({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }, mediaResponse);
  assert.equal(mediaResponse.statusCode, 415);

  const actionResponse = makeResponse();
  await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { action: 'destroyEverything' } }, actionResponse);
  assert.equal(actionResponse.statusCode, 400);
  assert.match(actionResponse.body.error.code, /^PACT_HTTP_/);
  assert.equal(calls.length, 0);
});

test('PACT HTTP handler strips routing fields before service dispatch and maps protocol errors deterministically', async () => {
  const service = {
    async commit(payload) {
      assert.deepEqual(payload, { transactionId: 'tx_1', capabilityToken: 'cap_1', idempotencyKey: 'idem_1' });
      throw new Error('PACT_API_STALE_CANONICAL_STATE');
    }
  };
  const handler = createPactHttpHandler({ service });
  const response = makeResponse();
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: { action: 'commit', transactionId: 'tx_1', capabilityToken: 'cap_1', idempotencyKey: 'idem_1' }
  }, response);

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, { error: { code: 'PACT_API_STALE_CANONICAL_STATE' } });
});

test('PACT HTTP handler does not leak unexpected exception messages', async () => {
  const service = { async preview() { throw new Error('database password was hunter2'); } };
  const handler = createPactHttpHandler({ service });
  const response = makeResponse();
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { action: 'preview', intent: {} }
  }, response);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { error: { code: 'PACT_HTTP_INTERNAL_ERROR' } });
  assert.doesNotMatch(JSON.stringify(response.body), /hunter2/);
});