import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactEngine } from '../src/engine.js';
import { createWebMcpRegistry } from '../src/webmcp.js';

function fakeContext() {
  const calls = [];
  return { calls, registerTool(tool, options) { calls.push({tool, options}); return Promise.resolve(); } };
}

test('tool surface exposes commit only after trusted approval', async () => {
  const e = createPactEngine({ now: () => 1000 });
  const ctx = fakeContext();
  const r = createWebMcpRegistry({ engine:e, modelContext:ctx });
  await r.refresh();
  assert(!r.activeNames().includes('pact_commit_transaction'));
  e.startIntent(); await e.preview(); await e.approve({trusted:true});
  await r.refresh();
  assert(r.activeNames().includes('pact_commit_transaction'));
});

test('refresh aborts previous registrations', async () => {
  const e = createPactEngine(); const ctx=fakeContext();
  const r=createWebMcpRegistry({engine:e,modelContext:ctx});
  await r.refresh(); const signal=ctx.calls[0].options.signal;
  assert.equal(signal.aborted,false);
  await r.refresh(); assert.equal(signal.aborted,true);
});

test('human approval tool cannot self-approve', async () => {
  const e=createPactEngine(); e.startIntent(); await e.preview();
  const ctx=fakeContext(); const r=createWebMcpRegistry({engine:e,modelContext:ctx}); await r.refresh();
  const tool=ctx.calls.find(x=>x.tool.name==='pact_request_human_approval').tool;
  const out=await tool.execute({});
  assert.equal(out.requiresHumanInteraction,true);
  assert.equal(e.inspect().transaction.state,'PREVIEWED');
});

test('failed registration aborts the whole generation', async () => {
  const e=createPactEngine();
  const ctx={registerTool(){throw new Error('boom')}};
  const r=createWebMcpRegistry({engine:e,modelContext:ctx});
  await assert.rejects(()=>r.refresh(),/WEBMCP_REGISTRATION_FAILED/);
  assert.deepEqual(r.activeNames(),[]);
});

test('successful WebMCP mutations invoke the persistence hook exactly once', async () => {
  const e = createPactEngine({ now: () => 1000 });
  const ctx = fakeContext();
  const mutations = [];
  const r = createWebMcpRegistry({
    engine: e,
    modelContext: ctx,
    onMutation: async ({ name, snapshot }) => mutations.push({ name, snapshot })
  });
  await r.refresh();
  const start = ctx.calls.find(x => x.tool.name === 'pact_start_intent').tool;
  await start.execute({});
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].name, 'pact_start_intent');
  assert.equal(mutations[0].snapshot.transaction.state, 'DRAFT');
});

test('read-only WebMCP calls do not invoke the persistence hook', async () => {
  const e = createPactEngine();
  const ctx = fakeContext();
  let mutations = 0;
  const r = createWebMcpRegistry({ engine: e, modelContext: ctx, onMutation: async () => { mutations++; } });
  await r.refresh();
  const inspect = ctx.calls.find(x => x.tool.name === 'pact_inspect').tool;
  await inspect.execute({});
  assert.equal(mutations, 0);
});

test('failed persistence rolls a WebMCP mutation back in memory', async () => {
  const e = createPactEngine({ now: () => 1000 });
  const ctx = fakeContext();
  const before = e.exportSnapshot();
  const r = createWebMcpRegistry({
    engine: e,
    modelContext: ctx,
    onMutation: async () => { throw new Error('PERSISTENCE_WRITE_FAILED'); }
  });
  await r.refresh();
  const start = ctx.calls.find(x => x.tool.name === 'pact_start_intent').tool;
  await assert.rejects(() => start.execute({}), /PERSISTENCE_WRITE_FAILED/);
  assert.deepEqual(e.exportSnapshot(), before);
});

test('agent gets autopilot prepare instead of needing start plus preview manually', async () => {
  const e=createPactEngine(); const ctx=fakeContext();
  const r=createWebMcpRegistry({engine:e,modelContext:ctx,onMutation:async()=>{}});
  await r.refresh();
  assert(r.activeNames().includes('pact_autopilot_prepare'));
  const tool=ctx.calls.find(x=>x.tool.name==='pact_autopilot_prepare').tool;
  const out=await tool.execute({});
  assert.equal(out.requiresHumanInteraction,true);
  assert.equal(e.inspect().transaction.state,'PREVIEWED');
});

test('approved transaction exposes one autopilot finish tool that commits and verifies', async () => {
  const e=createPactEngine(); e.startIntent(); await e.preview(); await e.approve({trusted:true});
  const ctx=fakeContext(); const r=createWebMcpRegistry({engine:e,modelContext:ctx,onMutation:async()=>{}});
  await r.refresh();
  assert(r.activeNames().includes('pact_autopilot_finish'));
  const tool=ctx.calls.find(x=>x.tool.name==='pact_autopilot_finish').tool;
  const out=await tool.execute({});
  assert.equal(out.state,'VERIFIED');
  assert.equal(e.inspect().transaction.state,'VERIFIED');
  assert.match(out.receipt.receiptHash,/^[a-f0-9]{64}$/);
});


test('autopilot finish durably records commit before verification', async () => {
  const e=createPactEngine(); e.startIntent(); await e.preview(); await e.approve({trusted:true});
  const ctx=fakeContext(); const mutations=[];
  const r=createWebMcpRegistry({engine:e,modelContext:ctx,onMutation:async event=>mutations.push(event)});
  await r.refresh();
  const tool=ctx.calls.find(x=>x.tool.name==='pact_autopilot_finish').tool;
  const out=await tool.execute({});
  assert.equal(out.state,'VERIFIED');
  assert.deepEqual(mutations.map(x=>x.name),['pact_autopilot_finish_commit','pact_autopilot_finish_verify']);
  assert.equal(mutations[0].snapshot.transaction.state,'COMMITTED');
  assert.equal(mutations[1].snapshot.transaction.state,'VERIFIED');
});

test('verification failure preserves the already-durable committed state', async () => {
  const e=createPactEngine(); e.startIntent(); await e.preview(); await e.approve({trusted:true});
  e.verify=async()=>{ throw new Error('VERIFY_FAILED'); };
  const ctx=fakeContext(); const mutations=[];
  const r=createWebMcpRegistry({engine:e,modelContext:ctx,onMutation:async event=>mutations.push(event)});
  await r.refresh();
  const tool=ctx.calls.find(x=>x.tool.name==='pact_autopilot_finish').tool;
  await assert.rejects(()=>tool.execute({}),/VERIFY_FAILED/);
  assert.equal(e.inspect().transaction.state,'COMMITTED');
  assert.deepEqual(mutations.map(x=>x.name),['pact_autopilot_finish_commit']);
});

test('failed commit persistence revokes autopilot commit and restores approval', async () => {
  const e=createPactEngine(); e.startIntent(); await e.preview(); await e.approve({trusted:true});
  const ctx=fakeContext();
  const r=createWebMcpRegistry({engine:e,modelContext:ctx,onMutation:async()=>{ throw new Error('PERSISTENCE_WRITE_FAILED'); }});
  await r.refresh();
  const tool=ctx.calls.find(x=>x.tool.name==='pact_autopilot_finish').tool;
  await assert.rejects(()=>tool.execute({}),/PERSISTENCE_WRITE_FAILED/);
  assert.equal(e.inspect().transaction.state,'APPROVED');
});

test('failed receipt persistence leaves committed state for explicit recovery', async () => {
  const e=createPactEngine(); e.startIntent(); await e.preview(); await e.approve({trusted:true});
  const ctx=fakeContext(); let calls=0;
  const r=createWebMcpRegistry({engine:e,modelContext:ctx,onMutation:async()=>{ calls++; if(calls===2) throw new Error('RECEIPT_PERSIST_FAILED'); }});
  await r.refresh();
  const tool=ctx.calls.find(x=>x.tool.name==='pact_autopilot_finish').tool;
  await assert.rejects(()=>tool.execute({}),/RECEIPT_PERSIST_FAILED/);
  assert.equal(e.inspect().transaction.state,'COMMITTED');
  assert.equal(calls,2);
});

test('committed transaction exposes recovery verification instead of requiring approval again', async () => {
  const e=createPactEngine(); e.startIntent(); await e.preview(); await e.approve({trusted:true}); await e.commit();
  const ctx=fakeContext(); const mutations=[];
  const r=createWebMcpRegistry({engine:e,modelContext:ctx,onMutation:async event=>mutations.push(event)});
  await r.refresh();
  assert(r.activeNames().includes('pact_autopilot_resume_verify'));
  assert(!r.activeNames().includes('pact_request_human_approval'));
  const tool=ctx.calls.find(x=>x.tool.name==='pact_autopilot_resume_verify').tool;
  const out=await tool.execute({});
  assert.equal(out.state,'VERIFIED');
  assert.equal(e.inspect().transaction.state,'VERIFIED');
  assert.deepEqual(mutations.map(x=>x.name),['pact_autopilot_resume_verify']);
});

test('recovery verification never duplicates the commit audit event', async () => {
  const e=createPactEngine(); e.startIntent(); await e.preview(); await e.approve({trusted:true}); await e.commit();
  const committedCount=e.inspect().audit.filter(x=>x.type==='COMMITTED').length;
  const ctx=fakeContext(); const r=createWebMcpRegistry({engine:e,modelContext:ctx,onMutation:async()=>{}});
  await r.refresh();
  const tool=ctx.calls.find(x=>x.tool.name==='pact_autopilot_resume_verify').tool;
  await tool.execute({});
  const state=e.inspect();
  assert.equal(state.audit.filter(x=>x.type==='COMMITTED').length,committedCount);
  assert.equal(state.audit.filter(x=>x.type==='RECEIPT').length,1);
});

test('expired approval no longer advertises commit or autopilot finish authority', async () => {
  let t=1000;
  const e=createPactEngine({now:()=>t,leaseMs:50}); e.startIntent(); await e.preview(); await e.approve({trusted:true});
  t=1100;
  const ctx=fakeContext(); const r=createWebMcpRegistry({engine:e,modelContext:ctx,onMutation:async()=>{}});
  await r.refresh();
  assert(!r.activeNames().includes('pact_commit_transaction'));
  assert(!r.activeNames().includes('pact_autopilot_finish'));
});
