import test from 'node:test';
import assert from 'node:assert/strict';
import { createPactSagaAuthorityService } from '../src/saga-protocol.js';

const clone=value=>value===undefined?undefined:structuredClone(value);
function store(){const data=new Map();return{async get(key){return clone(data.get(key)??null)},async create(key,value){if(data.has(key))return false;data.set(key,clone(value));return true},async compareAndSwap(key,version,value){const current=data.get(key);if(!current||current.version!==version)return false;data.set(key,clone(value));return true}}}
function step(){return{id:'account',handler:'provider',resourceKey:'account:42',atomicDomain:'accounts',input:{id:'42'}}}
const binding={providerId:'accounts',driverId:'etag-json',driverVersion:'1.0.0',configDigest:'b'.repeat(64)};
const policy=(operation,assurance='P3_STRONGLY_VERSIONED')=>({operation,allowed:true,requiredAssurance:'P2_CONDITIONAL',actualAssurance:assurance,evidenceDigest:'a'.repeat(64),providerBinding:binding,recoverySafe:false});
function service({gate}={}){
  const external=new Map();
  const handlers={provider:{
    async assertProviderOperation(operation,context){return gate?gate(operation,context):policy(operation)},
    async execute({input}){external.set(input.id,'committed');return{revision:'2'}},
    async verify({input}){return external.get(input.id)==='committed'},
    async reconcile({input}){return external.get(input.id)==='committed'?'committed':'not_committed'}
  }};
  return createPactSagaAuthorityService({store:store(),handlers,now:()=>10_000,verifyApproval:async()=>({humanPrincipal:'human:ops',agentSession:'agent:ops'})});
}

test('provider assurance failure blocks approval before authority is issued',async()=>{
  let calls=0;const s=service({gate(operation){calls+=1;if(operation==='approve'){const error=new Error('PACT_PROVIDER_ASSURANCE_INSUFFICIENT');error.requiredAssurance='P2_CONDITIONAL';error.actualAssurance='P0_UNQUALIFIED';throw error}return policy(operation)}});
  const preview=await s.sagaPreview({steps:[step()]});
  await assert.rejects(()=>s.sagaApprove({sagaId:preview.saga.id,approval:{signed:true}}),/PACT_PROVIDER_ASSURANCE_INSUFFICIENT/);
  assert.equal(calls,1);
  const inspected=await s.sagaInspect({sagaId:preview.saga.id});assert.equal(inspected.saga.state,'PREVIEWED');
});

test('provider assurance failure blocks first execution before external mutation',async()=>{
  let executeCalls=0;const external=new Map();
  const handlers={provider:{
    async assertProviderOperation(operation){if(operation==='commit'){const error=new Error('PACT_PROVIDER_ASSURANCE_INSUFFICIENT');error.requiredAssurance='P3_STRONGLY_VERSIONED';error.actualAssurance='P1_IDEMPOTENT';throw error}return policy(operation)},
    async execute(){executeCalls+=1;external.set('x',true);return{}},async verify(){return true},async reconcile(){return'not_committed'}
  }};
  const s=createPactSagaAuthorityService({store:store(),handlers,now:()=>20_000,verifyApproval:async()=>({humanPrincipal:'human:ops',agentSession:'agent:ops'})});
  const preview=await s.sagaPreview({steps:[step()]});const approved=await s.sagaApprove({sagaId:preview.saga.id,approval:{signed:true}});
  await assert.rejects(()=>s.sagaExecute({sagaId:preview.saga.id,capabilityToken:approved.capability.token,idempotencyKey:'exec-1'}),/PACT_PROVIDER_ASSURANCE_INSUFFICIENT/);
  assert.equal(executeCalls,0);assert.equal(external.size,0);
});

test('approved and committed assurance evidence is frozen into receipt and evidence chain',async()=>{
  const s=service();const preview=await s.sagaPreview({steps:[step()]});const approved=await s.sagaApprove({sagaId:preview.saga.id,approval:{signed:true}});
  const executed=await s.sagaExecute({sagaId:preview.saga.id,capabilityToken:approved.capability.token,idempotencyKey:'exec-2'});assert.equal(executed.saga.state,'COMMITTED');
  const receipt=(await s.sagaReceipt({sagaId:preview.saga.id})).receipt;
  assert.equal(receipt.providerAssurance.approval[0].stepId,'account');
  assert.equal(receipt.providerAssurance.approval[0].evidenceDigest,'a'.repeat(64));
  assert.equal(receipt.providerAssurance.commit[0].providerBinding.driverId,'etag-json');
  assert.ok(receipt.evidenceChain.events.some(event=>event.type==='PROVIDER_ASSURANCE_APPROVED'));
  assert.ok(receipt.evidenceChain.events.some(event=>event.type==='PROVIDER_ASSURANCE_COMMIT'));
  assert.doesNotMatch(JSON.stringify(receipt.providerAssurance),/token|secret|authorization/i);
});

test('replay after first execution authorization does not require fresh provider assurance',async()=>{
  let commitChecks=0;const s=service({gate(operation){if(operation==='commit'&&++commitChecks>1)throw new Error('EVIDENCE_EXPIRED');return policy(operation)}});
  const preview=await s.sagaPreview({steps:[step()]});const approved=await s.sagaApprove({sagaId:preview.saga.id,approval:{signed:true}});
  await s.sagaExecute({sagaId:preview.saga.id,capabilityToken:approved.capability.token,idempotencyKey:'exec-3'});
  const replay=await s.sagaExecute({sagaId:preview.saga.id,capabilityToken:approved.capability.token,idempotencyKey:'exec-3'});
  assert.equal(replay.idempotentReplay,true);assert.equal(commitChecks,1);
});
