import { createHash } from 'node:crypto';
import { canonicalStringify } from '../engine.js';
import { definePactProviderDriver } from '../provider-driver.js';
import { createPactRestResourceBridge, createPactJsonResourceAdapter } from '../rest-resource.js';

const fail=code=>{throw new Error(code)};
const clone=value=>value===undefined?undefined:structuredClone(value);
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const STRONG_ETAG=/^"[^"\x00-\x20\x7f]+"$/;
const FENCE_HEADER='x-pact-fence-generation';

function nonEmpty(value,code,max=2048){
  if(typeof value!=='string'||!value.trim())fail(code);
  const normalized=value.trim();
  if(normalized.length>max)fail(code);
  return normalized;
}

function configDigest(value){return createHash('sha256').update(canonicalStringify(value)).digest('hex');}
function same(left,right){return canonicalStringify(left)===canonicalStringify(right)};
function normalizeRemoteFencing(value){
  if(value==null||value===false)return null;
  if(value===true)return Object.freeze({mode:'monotonic-header',header:FENCE_HEADER});
  if(isObject(value)&&value.mode==='monotonic-header'&&String(value.header??'').toLowerCase()===FENCE_HEADER)return Object.freeze({mode:'monotonic-header',header:FENCE_HEADER});
  fail('PACT_ETAG_DRIVER_REMOTE_FENCING_INVALID');
}
function fenceGeneration(fence){
  if(!isObject(fence)||!Number.isSafeInteger(fence.generation)||fence.generation<1||typeof fence.ownerId!=='string'||!fence.ownerId.trim())fail('PACT_ETAG_DRIVER_REMOTE_FENCE_REQUIRED');
  return fence.generation;
}

function applyEffects(current,effects){
  const next=clone(current);
  next.version=current.version+1;
  for(const effect of effects){
    if(typeof effect?.path!=='string'||!effect.path.startsWith('resource.'))fail('PACT_ETAG_DRIVER_INVALID_EFFECT');
    const parts=effect.path.slice('resource.'.length).split('.');
    if(parts.length<1||parts.some(part=>!part))fail('PACT_ETAG_DRIVER_INVALID_EFFECT');
    let cursor=next.resource;
    for(const key of parts.slice(0,-1)){
      if(!isObject(cursor)||!Object.prototype.hasOwnProperty.call(cursor,key))fail('PACT_ETAG_DRIVER_EFFECT_PATH_MISSING');
      cursor=cursor[key];
    }
    const leaf=parts.at(-1);
    if(!isObject(cursor)||!Object.prototype.hasOwnProperty.call(cursor,leaf))fail('PACT_ETAG_DRIVER_EFFECT_PATH_MISSING');
    cursor[leaf]=clone(effect.after);
  }
  return next;
}

function canonicalFromObserved(observed){
  if(!isObject(observed)||!isObject(observed.state)||!Number.isSafeInteger(observed.state.version)||observed.state.version<0||!isObject(observed.state.resource))fail('PACT_ETAG_DRIVER_INVALID_OBSERVED_STATE');
  return clone(observed.state);
}

function strongEtagFetch(fetchImpl,required){
  if(!required)return fetchImpl;
  return async (url,options={})=>{
    const response=await fetchImpl(url,options);
    if(response?.ok){
      const etag=response?.headers?.get?.('etag');
      if(typeof etag!=='string'||!STRONG_ETAG.test(etag.trim()))fail('PACT_ETAG_DRIVER_STRONG_ETAG_REQUIRED');
    }
    return response;
  };
}

export function createEtagJsonDriver({
  id,
  version='1.0.0',
  providerId,
  store,
  resourceKey,
  atomicDomain,
  baseUrl,
  resourcePath,
  fetchImpl=globalThis.fetch,
  headers={},
  method='PUT',
  conditionalWrite='conditional-write-unknown-strength',
  remoteFencing=null,
  maxRetries=12
}={}){
  id=nonEmpty(id,'PACT_ETAG_DRIVER_ID_REQUIRED',128);
  version=nonEmpty(version,'PACT_ETAG_DRIVER_VERSION_REQUIRED',64);
  providerId=nonEmpty(providerId,'PACT_ETAG_DRIVER_PROVIDER_ID_REQUIRED',256);
  resourceKey=nonEmpty(resourceKey,'PACT_ETAG_DRIVER_RESOURCE_KEY_REQUIRED',512);
  atomicDomain=nonEmpty(atomicDomain,'PACT_ETAG_DRIVER_ATOMIC_DOMAIN_REQUIRED',256);
  if(typeof fetchImpl!=='function')fail('PACT_ETAG_DRIVER_FETCH_REQUIRED');
  if(!['strong-validator','conditional-write-unknown-strength'].includes(conditionalWrite))fail('PACT_ETAG_DRIVER_CONDITIONAL_WRITE_INVALID');
  const fencing=normalizeRemoteFencing(remoteFencing);

  const strongRevision=conditionalWrite==='strong-validator';
  const qualifiedFetch=strongEtagFetch(fetchImpl,strongRevision);
  const createBridge=(extraHeaders={})=>createPactRestResourceBridge({store,key:resourceKey,baseUrl,resourcePath,fetchImpl:qualifiedFetch,headers:{...headers,...extraHeaders},method,maxRetries});
  const bridge=createBridge();
  const bridgeForFence=fence=>{
    if(!fencing)return bridge;
    const generation=fenceGeneration(fence);
    return createBridge({[fencing.header]:String(generation)});
  };
  const adapter=createPactJsonResourceAdapter({id,version});
  const digest=configDigest({driver:'etag-json',id,version,providerId,resourceKey,atomicDomain,baseUrl,resourcePath,method:String(method).toUpperCase(),conditionalWrite,remoteFencing:fencing});

  const driver={
    id,
    version,
    describe(){
      return Object.freeze({providerId,driverId:id,driverVersion:version,configDigest:digest,resourceKey,atomicDomain,family:'etag-json',capabilities:Object.freeze({idempotency:true,conditionalWrite:strongRevision,strongRevision,reconciliation:true,stateReplacement:true,remoteFencing:Boolean(fencing)})});
    },
    async read(){const state=await bridge.read();return {revision:String(state.version),state:clone(state)};},
    async plan({intent,observed}={}){
      const before=canonicalFromObserved(observed);
      const planned=await adapter.plan({intent:clone(intent),state:clone(before)});
      if(!Array.isArray(planned?.effects)||planned.effects.length<1)fail('PACT_ETAG_DRIVER_EMPTY_PLAN');
      const next=applyEffects(before,planned.effects);
      return Object.freeze({providerId,driverId:id,driverVersion:version,intent:clone(intent),before,next,effects:clone(planned.effects),invariants:clone(planned.invariants??[]),metadata:clone(planned.metadata??{}),command:Object.freeze({method:String(method).toUpperCase(),resourcePath})});
    },
    async precondition({observed,plan}={}){
      const state=canonicalFromObserved(observed);
      if(!isObject(plan?.before)||!same(state,plan.before))fail('PACT_ETAG_DRIVER_PRECONDITION_MISMATCH');
      return {kind:'etag-json',canonicalVersion:state.version};
    },
    async commit({plan,authorization,idempotencyKey,fence}={}){
      if(!isObject(plan?.before)||!isObject(plan?.next))fail('PACT_ETAG_DRIVER_PLAN_REQUIRED');
      return bridgeForFence(fence).commit({expectedVersion:plan.before.version,nextState:clone(plan.next),authorization:clone(authorization),idempotencyKey});
    },
    async observe(){const state=await bridge.read();return {revision:String(state.version),state:clone(state)};},
    async verify({plan,observed}={}){
      if(!isObject(plan)||!isObject(observed?.state)||!same(observed.state,plan.next))return false;
      return adapter.verify({intent:clone(plan.intent),state:clone(observed.state)});
    },
    async reconcile({plan}={}){
      if(!isObject(plan?.before)||!isObject(plan?.next))return {classification:'UNRESOLVED'};
      let current;try{current=await bridge.read()}catch{return {classification:'UNRESOLVED'}}
      if(same(current,plan.next))return {classification:'COMMITTED'};
      if(same(current,plan.before))return {classification:'NOT_COMMITTED'};
      return {classification:'DIVERGED'};
    }
  };
  return definePactProviderDriver(driver);
}
