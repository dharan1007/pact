import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdempotentCommandDriver } from '../src/providers/idempotent-command.js';

function harness(){
  const outcomes=new Map();let executions=0,loseNext=false;
  const command=async({intent,idempotencyKey})=>{
    const encoded=JSON.stringify(intent);
    if(outcomes.has(idempotencyKey)){
      const prior=outcomes.get(idempotencyKey);
      if(prior.encoded!==encoded){const error=new Error('PROVIDER_IDEMPOTENCY_CONFLICT');error.definitive=true;throw error}
      return prior.result;
    }
    executions+=1;
    const result={operationId:`op-${executions}`,status:'succeeded',value:intent.value};
    outcomes.set(idempotencyKey,{encoded,result});
    if(loseNext){loseNext=false;throw new Error('NETWORK_RESPONSE_LOST')}
    return result;
  };
  const observe=async({plan})=>{const record=[...outcomes.values()].find(x=>x.encoded===JSON.stringify(plan.intent));return record?{revision:record.result.operationId,state:{status:record.result.status,value:record.result.value}}:{revision:'none',state:{status:'absent'}}};
  return {command,observe,executions:()=>executions,loseResponseOnce(){loseNext=true}};
}
function driver(h){return createIdempotentCommandDriver({id:'stripe.payment-command',version:'1.0.0',providerId:'payments',resourceKey:'payment:42',atomicDomain:'payments',commandId:'payment-intent-update',observeId:'payment-intent-read',command:h.command,observe:h.observe,verifyOutcome:({intent,observed})=>observed?.state?.status==='succeeded'&&observed.state.value===intent.value});}

test('describes an idempotent command family whose built-in assurance ceiling is P1',()=>{
  const d=driver(harness()),desc=d.describe();
  assert.equal(desc.family,'idempotent-command');
  assert.equal(desc.capabilities.idempotency,true);
  assert.equal(desc.capabilities.conditionalWrite,false);
  assert.equal(desc.capabilities.strongRevision,false);
});

test('binds authorization and command payload to one idempotency key and replays one external effect',async()=>{
  const h=harness(),d=driver(h),observed=await d.read();const plan=await d.plan({intent:{value:100},observed});
  const first=await d.commit({plan,authorization:{authorizationId:'idem-1'},idempotencyKey:'idem-1'});
  const second=await d.commit({plan,authorization:{authorizationId:'idem-1'},idempotencyKey:'idem-1'});
  assert.deepEqual(second,first);assert.equal(h.executions(),1);
  assert.equal(await d.verify({plan,observed:await d.observe({plan,providerResult:first})}),true);
});

test('same idempotency key with a different payload is rejected',async()=>{
  const h=harness(),d=driver(h),observed=await d.read();const p1=await d.plan({intent:{value:100},observed}),p2=await d.plan({intent:{value:200},observed});
  await d.commit({plan:p1,authorization:{authorizationId:'idem-2'},idempotencyKey:'idem-2'});
  await assert.rejects(()=>d.commit({plan:p2,authorization:{authorizationId:'idem-2'},idempotencyKey:'idem-2'}),/PACT_COMMAND_IDEMPOTENCY_CONFLICT/);
  assert.equal(h.executions(),1);
});

test('lost response is uncertain and reconciliation observes committed state without reissuing command',async()=>{
  const h=harness(),d=driver(h),observed=await d.read();const plan=await d.plan({intent:{value:300},observed});h.loseResponseOnce();
  let error;try{await d.commit({plan,authorization:{authorizationId:'idem-3'},idempotencyKey:'idem-3'})}catch(cause){error=cause}
  assert.match(error?.message??'',/PACT_COMMAND_COMMIT_UNCERTAIN/);assert.equal(h.executions(),1);
  assert.deepEqual(await d.reconcile({plan,error}),{classification:'COMMITTED'});assert.equal(h.executions(),1);
});

test('cannot claim a conditional precondition it does not possess',async()=>{
  const h=harness(),d=driver(h),observed=await d.read(),plan=await d.plan({intent:{value:1},observed});
  assert.deepEqual(await d.precondition({observed,plan}),{kind:'none'});
});
