import { createHash } from 'node:crypto';
import { canonicalStringify } from '../engine.js';
import { definePactProviderDriver } from '../provider-driver.js';

const fail=code=>{throw new Error(code)};
const clone=value=>value===undefined?undefined:structuredClone(value);
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function nonEmpty(value,code,max=512){if(typeof value!=='string'||!value.trim())fail(code);const normalized=value.trim();if(normalized.length>max)fail(code);return normalized;}
function hash(value){return createHash('sha256').update(canonicalStringify(value)).digest('hex');}
function assertStore(store){if(!store||typeof store.get!=='function'||typeof store.create!=='function'||typeof store.compareAndSwap!=='function')fail('PACT_COMMAND_ATOMIC_STORE_REQUIRED');}
function validateRecord(value){if(!isObject(value)||!Number.isSafeInteger(value.version)||value.version<0||typeof value.payloadHash!=='string'||!/^[a-f0-9]{64}$/.test(value.payloadHash)||!['PENDING','COMMITTED','FAILED'].includes(value.status))fail('PACT_COMMAND_CORRUPT_REPLAY_RECORD');return clone(value);}

export function createIdempotentCommandDriver({id,version='1.0.0',providerId,resourceKey,atomicDomain,commandId,observeId,store,command,observe,verifyOutcome}={}){
  id=nonEmpty(id,'PACT_COMMAND_DRIVER_ID_REQUIRED',128);version=nonEmpty(version,'PACT_COMMAND_DRIVER_VERSION_REQUIRED',64);providerId=nonEmpty(providerId,'PACT_COMMAND_PROVIDER_ID_REQUIRED',256);resourceKey=nonEmpty(resourceKey,'PACT_COMMAND_RESOURCE_KEY_REQUIRED',512);atomicDomain=nonEmpty(atomicDomain,'PACT_COMMAND_ATOMIC_DOMAIN_REQUIRED',256);commandId=nonEmpty(commandId,'PACT_COMMAND_COMMAND_ID_REQUIRED',256);observeId=nonEmpty(observeId,'PACT_COMMAND_OBSERVE_ID_REQUIRED',256);assertStore(store);if(typeof command!=='function')fail('PACT_COMMAND_EXECUTOR_REQUIRED');if(typeof observe!=='function')fail('PACT_COMMAND_OBSERVER_REQUIRED');if(typeof verifyOutcome!=='function')fail('PACT_COMMAND_VERIFIER_REQUIRED');
  const configDigest=hash({family:'idempotent-command',id,version,providerId,resourceKey,atomicDomain,commandId,observeId});
  const replayKey=idempotencyKey=>`command-replay:${id}:${hash({idempotencyKey})}`;
  async function existingRecord(key,payloadHash){const raw=await store.get(replayKey(key));if(!raw)return null;const record=validateRecord(raw);if(record.payloadHash!==payloadHash)fail('PACT_COMMAND_IDEMPOTENCY_CONFLICT');return record;}
  async function mark(record,key,status,extra={}){const next={...record,...extra,version:record.version+1,status};if(!await store.compareAndSwap(replayKey(key),record.version,next)){const current=await existingRecord(key,record.payloadHash);if(!current)fail('PACT_COMMAND_REPLAY_LOST');return current;}return next;}
  const driver={id,version,
    describe(){return Object.freeze({providerId,driverId:id,driverVersion:version,configDigest,resourceKey,atomicDomain,family:'idempotent-command',capabilities:Object.freeze({idempotency:true,conditionalWrite:false,strongRevision:false,reconciliation:true,stateReplacement:false,remoteFencing:false})});},
    async read(){return {revision:'unscoped',state:{}};},
    async plan({intent,observed}={}){if(!isObject(intent))fail('PACT_COMMAND_INTENT_REQUIRED');const cleanIntent=clone(intent);return Object.freeze({providerId,driverId:id,driverVersion:version,intent:cleanIntent,before:isObject(observed)?clone(observed):{revision:'unscoped',state:{}},payloadHash:hash({providerId,driverId:id,driverVersion:version,commandId,intent:cleanIntent}),command:{id:commandId}});},
    async precondition(){return {kind:'none'};},
    async commit({plan,authorization,idempotencyKey}={}){
      if(!isObject(plan)||typeof plan.payloadHash!=='string')fail('PACT_COMMAND_PLAN_REQUIRED');if(!isObject(authorization)||typeof authorization.authorizationId!=='string'||!authorization.authorizationId)fail('PACT_COMMAND_AUTHORIZATION_REQUIRED');idempotencyKey=nonEmpty(idempotencyKey,'PACT_COMMAND_IDEMPOTENCY_KEY_REQUIRED');if(authorization.authorizationId!==idempotencyKey)fail('PACT_COMMAND_AUTHORIZATION_BINDING_MISMATCH');
      let record=await existingRecord(idempotencyKey,plan.payloadHash);
      if(record?.status==='COMMITTED')return clone(record.result);
      if(record?.status==='FAILED')fail(record.errorCode||'PACT_COMMAND_PROVIDER_REJECTED');
      if(record?.status==='PENDING')fail('PACT_COMMAND_COMMIT_UNCERTAIN');
      const pending={version:0,payloadHash:plan.payloadHash,status:'PENDING',createdAt:Date.now()};
      if(!await store.create(replayKey(idempotencyKey),pending)){record=await existingRecord(idempotencyKey,plan.payloadHash);if(record?.status==='COMMITTED')return clone(record.result);fail(record?.status==='FAILED'?(record.errorCode||'PACT_COMMAND_PROVIDER_REJECTED'):'PACT_COMMAND_COMMIT_UNCERTAIN');}
      record=pending;
      let result;
      try{result=await command({intent:clone(plan.intent),idempotencyKey,authorization:clone(authorization),plan:clone(plan)});}catch(cause){
        if(cause?.definitive===true){const errorCode=/IDEMPOTENCY_CONFLICT/.test(String(cause?.message))?'PACT_COMMAND_IDEMPOTENCY_CONFLICT':'PACT_COMMAND_PROVIDER_REJECTED';await mark(record,idempotencyKey,'FAILED',{errorCode});fail(errorCode);}
        const error=new Error('PACT_COMMAND_COMMIT_UNCERTAIN',{cause});error.uncertain=true;throw error;
      }
      const committed=await mark(record,idempotencyKey,'COMMITTED',{result:clone(result),committedAt:Date.now()});
      if(committed.status!=='COMMITTED')fail('PACT_COMMAND_COMMIT_UNCERTAIN');
      return clone(committed.result);
    },
    async observe({plan,providerResult}={}){if(!isObject(plan))fail('PACT_COMMAND_PLAN_REQUIRED');const observed=await observe({plan:clone(plan),providerResult:clone(providerResult)});if(!isObject(observed)||typeof observed.revision!=='string'||!isObject(observed.state))fail('PACT_COMMAND_INVALID_OBSERVATION');return clone(observed);},
    async verify({plan,observed,providerResult}={}){if(!isObject(plan)||!isObject(observed))return false;return (await verifyOutcome({intent:clone(plan.intent),observed:clone(observed),providerResult:clone(providerResult),plan:clone(plan)}))===true;},
    async reconcile({plan,idempotencyKey}={}){
      if(!isObject(plan))return {classification:'UNRESOLVED'};
      let observed;try{observed=await driver.observe({plan})}catch{return {classification:'UNRESOLVED'}}
      let verified=false;try{verified=await driver.verify({plan,observed})}catch{return {classification:'UNRESOLVED'}}
      if(!verified)return {classification:'UNRESOLVED'};
      if(typeof idempotencyKey==='string'&&idempotencyKey){const record=await existingRecord(idempotencyKey,plan.payloadHash);if(record?.status==='PENDING')await mark(record,idempotencyKey,'COMMITTED',{result:{reconciled:true,observed:clone(observed)},committedAt:Date.now()});}
      return {classification:'COMMITTED'};
    }
  };
  return definePactProviderDriver(driver);
}
