import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createPactProviderQualifier } from '../src/provider-qualification.js';
import { qualifyProvider } from '../src/provider-qualification-suite.js';
import { deriveProviderAssurance, PROVIDER_ASSURANCE } from '../src/provider-assurance.js';

const clone=value=>value===undefined?undefined:structuredClone(value);
function fixture(){
  let revision=1,state={value:0,fence:0},effects=0,lose=false,highestFence=0;
  const description={providerId:'fixture',driverId:'fixture.driver',driverVersion:'1.0.0',configDigest:'a'.repeat(64),resourceKey:'fixture:1',atomicDomain:'fixture',capabilities:{idempotency:true,conditionalWrite:true,strongRevision:true,reconciliation:true,stateReplacement:true,remoteFencing:true}};
  const applied=new Map();
  const driver={id:'fixture.driver',version:'1.0.0',describe(){return description},async read(){return{revision:String(revision),state:clone(state)}},async plan({intent,observed}){return{intent:clone(intent),before:clone(observed),expectedRevision:observed.revision}},async precondition({observed,plan}){if(observed.revision!==plan.expectedRevision)throw new Error('STALE');return{revision:observed.revision}},async commit({plan,idempotencyKey,fence}){if(fence){if(fence.generation<=highestFence){const e=new Error('STALE_FENCE');e.stale=true;throw e}highestFence=fence.generation}if(applied.has(idempotencyKey))return clone(applied.get(idempotencyKey));if(String(revision)!==String(plan.expectedRevision)){const e=new Error('STALE');e.stale=true;throw e}effects+=1;revision+=1;state={value:plan.intent.value,fence:highestFence};const result={revision:String(revision),state:clone(state)};applied.set(idempotencyKey,result);if(lose){lose=false;const e=new Error('AFTER_WRITE_5XX');e.uncertain=true;throw e}return clone(result)},async observe(){return{revision:String(revision),state:clone(state)}},async verify({plan,observed}){return observed.state.value===plan.intent.value},async reconcile({plan}){const observed=await this.observe();if(await this.verify({plan,observed}))return{classification:'COMMITTED'};if(observed.revision===plan.before.revision)return{classification:'NOT_COMMITTED'};return{classification:'DIVERGED'}}};
  return{driver,description,reset(){revision+=1;state={value:0,fence:highestFence};applied.clear();effects=0;lose=false},effects:()=>effects,armAfterWriteFailure(){lose=true},fence:async generation=>{if(generation<=highestFence)return{accepted:false,status:409};highestFence=generation;revision+=1;state={...state,fence:generation};return{accepted:true,status:200}},readFence:async()=>({revision:String(revision),state:clone(state)})};
}

async function runQualification(f,qualifier,releaseSha='1'.repeat(40)){
  return qualifyProvider({driver:f.driver,qualifier,qualificationTarget:{id:'fixture-qualification',production:false},releaseSha,scenarios:{reset:async()=>f.reset(),intentA:{value:1},intentB:{value:2},effectCount:async()=>f.effects(),armAfterWriteFailure:async()=>f.armAfterWriteFailure(),fencing:{apply:async({generation})=>f.fence(generation),read:async()=>f.readFence(),generation:100}}});
}

test('qualification actively exercises idempotency, stale concurrency, reconciliation, after-write uncertainty and fencing',async()=>{
  const f=fixture(),store=new MemoryAuthorityStore(),qualifier=createPactProviderQualifier({store,now:()=>100000});
  const report=await runQualification(f,qualifier);
  assert.equal(report.status,'QUALIFIED');
  for(const probe of ['idempotency','conditional-write','reconciliation','remote-fencing'])assert.ok(report.probes.includes(probe),probe);
  assert.equal(report.scenarios.concurrentWriters.staleRejected,true);
  assert.equal(report.scenarios.afterWriteFailure.reconciled,'COMMITTED');
  assert.equal(report.scenarios.afterWriteFailure.effects,1);
  assert.match(report.evidenceDigest,/^[a-f0-9]{64}$/);
});

test('persisted qualification evidence raises the exact bound driver to remote-fenced assurance',async()=>{
  const f=fixture(),store=new MemoryAuthorityStore(),qualifier=createPactProviderQualifier({store,now:()=>300000});
  await runQualification(f,qualifier,'3'.repeat(40));
  const evidence=[];
  for(const probe of ['idempotency','conditional-write','reconciliation','remote-fencing']){
    const item=await qualifier.inspectQualification('fixture',probe);
    assert.ok(item,`missing persisted ${probe} evidence`);
    evidence.push(item);
  }
  const assessment=deriveProviderAssurance({
    binding:{providerId:'fixture',driverId:'fixture.driver',driverVersion:'1.0.0',configDigest:'a'.repeat(64)},
    description:f.description,
    evidence,
    now:()=>300000
  });
  assert.equal(assessment.assurance,PROVIDER_ASSURANCE.P4_REMOTE_FENCED);
  assert.deepEqual([...assessment.validEvidence].sort(),['conditional-write','idempotency','reconciliation','remote-fencing']);
  assert.match(assessment.evidenceDigest,/^[a-f0-9]{64}$/);
});

test('qualification rejects production targets and cannot fabricate absent scenarios',async()=>{
  const f=fixture(),qualifier=createPactProviderQualifier({store:new MemoryAuthorityStore(),now:()=>200000});
  await assert.rejects(()=>qualifyProvider({driver:f.driver,qualifier,qualificationTarget:{id:'prod',production:true},releaseSha:'2'.repeat(40),scenarios:{}}),/PACT_PROVIDER_QUALIFICATION_PRODUCTION_TARGET_FORBIDDEN/);
  await assert.rejects(()=>qualifyProvider({driver:f.driver,qualifier,qualificationTarget:{id:'qa',production:false},releaseSha:'2'.repeat(40),scenarios:{reset:async()=>{},intentA:{value:1},intentB:{value:2}}}),/PACT_PROVIDER_QUALIFICATION_EFFECT_COUNTER_REQUIRED/);
});
