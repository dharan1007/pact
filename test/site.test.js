import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = [
  ['index.html','WHY PACT EXISTS'],
  ['pages/demo.html','One approval. Everything else automated.'],
  ['pages/workspace.html','Generic adapter transaction playground'],
  ['pages/how-it-works.html','How PACT works'],
  ['pages/security.html','Trust without blind access'],
  ['pages/developers.html','Use PACT as a runtime, not a demo.']
];
const nav = ['Overview','Live Demo','How It Works','Security','Developers'];

test('all product routes exist and explain their purpose', async () => {
  for (const [file, marker] of pages) {
    const html = await readFile(file,'utf8');
    assert.match(html, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    for (const item of nav) assert.match(html, new RegExp(item));
    assert.match(html, /href="\/workspace\/"/);
    assert.match(html, /(?:Workspace|API Playground)/);
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

test('WebMCP developer guidance uses registration AbortSignal and a single-input execute callback', async () => {
  const html = await readFile('pages/developers.html','utf8');
  assert.match(html, /execute: async input/);
  assert.match(html, /registerTool/);
  assert.match(html, /registration/);
  assert.match(html, /AbortSignal/);
  assert.doesNotMatch(html, /execute callback AbortSignal/i);
  assert.doesNotMatch(html, /execute: async \([^)]*,\s*\{\s*signal/);
  const readme = await readFile('README.md','utf8');
  assert.match(readme, /single input object/i);
  assert.match(readme, /registration.*AbortSignal/i);
  assert.doesNotMatch(readme, /execution callback AbortSignal/i);
});

test('developers page documents canonical commit idempotency and durable authority without advertising unsupported rollback', async () => {
  const html = await readFile('pages/developers.html','utf8');
  assert.match(html, /idempotency key/i);
  assert.match(html, /durable atomic store/i);
  assert.doesNotMatch(html, /commit and rollback before network I\/O/i);
  assert.doesNotMatch(html, /VERIFIED[^<]*→[^<]*receipt\/rollback/i);
});

test('developers page teaches the official real REST provider mode and server-only credential boundary', async () => {
  const html = await readFile('pages/developers.html','utf8');
  assert.match(html, /\/sdk\/rest-resource\.js/);
  assert.match(html, /createPactRestResourceBridge/);
  assert.match(html, /PACT_RUNTIME_MODE/);
  assert.match(html, /rest-json/);
  assert.match(html, /ETag/);
  assert.match(html, /If-Match/);
  assert.match(html, /Idempotency-Key/);
  assert.match(html, /server-side/i);
});

test('README describes the shipped real-provider runtime mode rather than claiming production is generic-only', async () => {
  const readme = await readFile('README.md','utf8');
  assert.match(readme, /src\/rest-resource\.js/);
  assert.match(readme, /PACT_RUNTIME_MODE/);
  assert.match(readme, /rest-json/);
  assert.match(readme, /If-Match/);
  assert.doesNotMatch(readme, /included production runtime is intentionally generic/i);
});

test('guided demo explicitly supports durable committed-state recovery', async () => {
  const js = await readFile('src/demo.js','utf8');
  assert.match(js, /state === 'COMMITTED'/);
  assert.match(js, /resumeCommitted\(\)/);
  assert.match(js, /state === 'APPROVED'/);
  assert.match(js, /resumeApproved\(\)/);
});

test('canonical API playground can recover a durable transaction by id after reload', async () => {
  const html = await readFile('pages/workspace.html','utf8');
  assert.match(html, /recovery/i);
  assert.match(html, /verification/i);
  assert.match(html, /id="recovery-tx-id"/);
  assert.match(html, /id="recover"/);
  const js = await readFile('src/playground.js','utf8');
  assert.match(js, /async function recover\(\)/);
  assert.match(js, /connector\.inspect\(payload\)/);
  assert.match(js, /state\.transaction = result\.transaction/);
  assert.match(js, /COMMITTED/);
  assert.match(js, /VERIFIED/);
});

test('browser boot fails closed on corrupt persistence instead of deleting evidence', async () => {
  for (const file of ['src/demo.js','src/main.js']) {
    const js = await readFile(file,'utf8');
    assert.match(js, /validateIntegrity\(\)/);
    assert.doesNotMatch(js, /localStorage\.removeItem\(store\.key\)/);
    assert.match(js, /PERSISTENCE_INTEGRITY_FAILED/);
  }
});
