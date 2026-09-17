import test from 'node:test';
import assert from 'node:assert/strict';
import { createVersionedCommandDriver } from '../src/providers/versioned-command.js';

const clone=value=>value===undefined?undefined:structuredClone(value);
function harness(){
  let revision=4,state={status:'open',owner:'a'},writes=0,loseNext=false;
  const read=async()=>({revision:String(revision),state:clone(state)});
  const apply=async({intent,expectedRevision})=>{
    if(String(expectedRevision)!==String(revision)){const error=new Error('HTTP_409');error.status=409;throw error}
    writes+=1;state={...state,...clone(intent.patch)};revision+=1;
    const result={revision:String(revision),state:clone(state)};
    if(loseNext){loseNext=false;throw new Error('NETWORK_RESPONSE_LOST')}
    return result;
  };
  const observe=async()=>read();
  return {read,apply,observe,writes:()=>writes,drift(){state={...state,owner:'other'};revision+=1},loseResponseOnce(){loseNext=true},current:()=>({revision:String(revision),state:clone(state)})};
}
function driver(h){return createVersionedCommandDriver({
  id:'crm.versioned-command',version:'1.0.0',providerId:'crm',resourceKey:'ticket:42',atomicDomain:'crm/ticket',commandId:'ticket-update',
  read:h.read,apply:h.apply,observe:h.observe,readRevision:value=>value.revision,
  classifyConflict:error=>error?.status===409,
  verifyOutcome:({intent,observed})=>Object.entries(intent.patch).every(([key,value])=>observed.state[key]===value)
});}

test('binds each planned mutation to the observed explicit revision',async()=>{
  const h=harness(),d=driver(h),observed=await d.read();
  const plan=await d.plan({intent:{patch:{status:'closed'}},observed});
  assert.equal(plan.expectedRevision,'4');
  assert.deepEqual(await d.precondition({observed,plan}),{kind:'explicit-version',revision:'4'});
  const result=await d.commit({plan,authorization:{authorizationId:'v-1'},idempotencyKey:'v-1'});
  assert.equal(result.revision,'5');assert.equal(h.writes(),1);
  assert.equal(await d.verify({plan,observed:await d.observe({plan,providerResult:result})}),true);
});

test('classifies a provider revision conflict as stale state',async()=>{
  const h=harness(),d=driver(h),observed=await d.read(),plan=await d.plan({intent:{patch:{status:'closed'}},observed});h.drift();
  await assert.rejects(()=>d.commit({plan,authorization:{authorizationId:'v-2'},idempotencyKey:'v-2'}),/PACT_VERSIONED_STALE_PROVIDER_STATE/);
  assert.equal(h.writes(),0);
});

test('lost response is uncertain and reconciliation observes without replaying',async()=>{
  const h=harness(),d=driver(h),observed=await d.read(),plan=await d.plan({intent:{patch:{status:'closed'}},observed});h.loseResponseOnce();
  let error;try{await d.commit({plan,authorization:{authorizationId:'v-3'},idempotencyKey:'v-3'})}catch(cause){error=cause}
  assert.match(error?.message??'',/PACT_VERSIONED_COMMIT_UNCERTAIN/);assert.equal(h.writes(),1);
  assert.deepEqual(await d.reconcile({plan,error}),{classification:'COMMITTED'});assert.equal(h.writes(),1);
});

test('divergent postcondition never verifies as success',async()=>{
  const h=harness(),d=driver(h),observed=await d.read(),plan=await d.plan({intent:{patch:{status:'closed'}},observed});h.drift();
  const current=await d.observe({plan});assert.equal(await d.verify({plan,observed:current}),false);
  assert.deepEqual(await d.reconcile({plan}),{classification:'DIVERGED'});
});

test('describes strong explicit-version semantics without inventing idempotency',()=>{
  const d=driver(harness()),desc=d.describe();
  assert.equal(desc.family,'explicit-version-command');
  assert.equal(desc.capabilities.conditionalWrite,true);
  assert.equal(desc.capabilities.strongRevision,true);
  assert.equal(desc.capabilities.idempotency,false);
});
