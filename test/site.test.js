import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = [
  ['index.html','WHY PACT EXISTS'],
  ['pages/demo.html','One approval. Everything else automated.'],
  ['pages/workspace.html','Transaction workspace'],
  ['pages/how-it-works.html','How PACT works'],
  ['pages/security.html','Trust without blind access'],
  ['pages/developers.html','Use PACT as a runtime, not a demo.']
];
const nav = ['Overview','Live Demo','Workspace','How It Works','Security','Developers'];

test('all product routes exist and explain their purpose', async () => {
  for (const [file, marker] of pages) {
    const html = await readFile(file,'utf8');
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    for (const item of nav) assert.match(html, new RegExp(item));
  }
});

test('overview links to every primary route', async () => {
  const html = await readFile('index.html','utf8');
  for (const href of ['/demo/','/workspace/','/how-it-works/','/security/','/developers/']) assert.match(html, new RegExp(`href="${href}"`));
});

test('developers page documents the reusable SDK, authority boundary and current WebMCP host', async () => {
  const html = await readFile('pages/developers.html','utf8');
  assert.match(html, /\/sdk\/adapter\.js/);
  assert.match(html, /\/sdk\/runtime\.js/);
  assert.match(html, /\/sdk\/authority\.js/);
  assert.match(html, /verifyApproval/);
  assert.match(html, /humanPrincipal/);
  assert.match(html, /agentSession/);
  assert.match(html, /document\.modelContext/);
  assert.match(html, /pact-manifest\.json/);
});

test('developers page shows the exact HTTP connector API and current WebMCP annotation surface', async () => {
  const html = await readFile('pages/developers.html','utf8');
  assert.match(html, /baseUrl: 'https:\/\/example\.com'/);
  assert.match(html, /api\.commit\(\{ txId \}, txId/);
  assert.match(html, /AbortController/);
  assert.match(html, /signal: request\.signal/);
  assert.match(html, /PACT_HTTP_ABORTED/);
  assert.match(html, /PACT_HTTP_TIMEOUT/);
  assert.doesNotMatch(html, /endpoint: 'https:\/\/example\.com\/api\/pact'/);
  assert.doesNotMatch(html, /annotated as consequential/i);
  assert.match(html, /readOnlyHint/);
  assert.match(html, /untrustedContentHint/);
});

test('developers page documents HTTP idempotency and durable-authority limitation without claiming the static deployment provides it', async () => {
  const html = await readFile('pages/developers.html','utf8');
  assert.match(html, /idempotency key/i);
  assert.match(html, /durable atomic store/i);
  assert.match(html, /static reference deployment does not provide that guarantee yet/i);
});

test('guided demo explicitly supports durable committed-state recovery', async () => {
  const js = await readFile('src/demo.js','utf8');
  assert.match(js, /state === 'COMMITTED'/);
  assert.match(js, /resumeCommitted\(\)/);
  assert.match(js, /state === 'APPROVED'/);
  assert.match(js, /resumeApproved\(\)/);
});

test('workspace explains committed recovery instead of stranding the user', async () => {
  const html = await readFile('pages/workspace.html','utf8');
  assert.match(html, /recovery/i);
  assert.match(html, /verification/i);
  const js = await readFile('src/main.js','utf8');
  assert.match(js, /recovery-status/);
  assert.match(js, /COMMITTED/);
});

test('browser boot fails closed on corrupt persistence instead of deleting evidence', async () => {
  for (const file of ['src/demo.js','src/main.js']) {
    const js = await readFile(file,'utf8');
    assert.match(js, /validateIntegrity\(\)/);
    assert.doesNotMatch(js, /localStorage\.removeItem\(store\.key\)/);
    assert.match(js, /PERSISTENCE_INTEGRITY_FAILED/);
  }
});
