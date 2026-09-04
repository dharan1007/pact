import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pages = [
  ['index.html','WHY PACT EXISTS'],
  ['pages/demo.html','One approval. Everything else automated.'],
  ['pages/workspace.html','Transaction workspace'],
  ['pages/how-it-works.html','How PACT works'],
  ['pages/security.html','Trust without blind access'],
  ['pages/developers.html','WebMCP developer surface']
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

test('developers page documents the autopilot-first WebMCP surface', async () => {
  const html = await readFile('pages/developers.html','utf8');
  assert.match(html, /pact_autopilot_prepare/);
  assert.match(html, /pact_autopilot_finish/);
  assert.match(html, /trusted human approval/i);
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

test('developer documentation includes the committed recovery capability', async () => {
  const html = await readFile('pages/developers.html','utf8');
  assert.match(html, /pact_autopilot_resume_verify/);
});

test('browser boot fails closed on corrupt persistence instead of deleting evidence', async () => {
  for (const file of ['src/demo.js','src/main.js']) {
    const js = await readFile(file,'utf8');
    assert.match(js, /validateIntegrity\(\)/);
    assert.doesNotMatch(js, /localStorage\.removeItem\(store\.key\)/);
    assert.match(js, /PERSISTENCE_INTEGRITY_FAILED/);
  }
});
