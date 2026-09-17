import { MemoryAuthorityStore } from '../../src/authority.js';
import { createPactProviderQualifier } from '../../src/provider-qualification.js';
import { createEtagJsonDriver } from '../../src/providers/etag-json.js';
import { createKubernetesResourceDriver } from '../../src/providers/kubernetes-resource.js';
import { createIdempotentCommandDriver } from '../../src/providers/idempotent-command.js';
import { createVersionedCommandDriver } from '../../src/providers/versioned-command.js';

const fail=code=>{throw new Error(code)};
const families=new Set(['etag-json','kubernetes-resource-version','idempotent-command','explicit-version-command']);
const env=(name,{required=true,defaultValue=null}={})=>{const value=process.env[name];if((value==null||!String(value).trim())&&required)fail(`PACT_QUALIFICATION_ENV_REQUIRED:${name}`);return value==null||!String(value).trim()?defaultValue:String(value).trim()};
const family=env('PACT_QUAL_FAMILY');
if(!families.has(family))fail('PACT_QUALIFICATION_FAMILY_INVALID');
const releaseSha=env('PACT_SOURCE_COMMIT');
if(!/^[a-f0-9]{40}$/.test(releaseSha)||/^0{40}$/.test(releaseSha))fail('PACT_QUALIFICATION_RELEASE_SHA_INVALID');
const targetBase=secureBase(env('PACT_QUAL_TARGET_URL'),'PACT_QUALIFICATION_TARGET_URL_INVALID');
const controlBase=secureBase(env('PACT_QUAL_CONTROL_URL'),'PACT_QUALIFICATION_CONTROL_URL_INVALID');
const targetToken=env('PACT_QUAL_TARGET_TOKEN',{required:false,defaultValue:''});
const controlToken=env('PACT_QUAL_CONTROL_TOKEN',{required:false,defaultValue:''});
const targetId=env('PACT_QUAL_TARGET_ID');
const resourcePath=env('PACT_QUAL_RESOURCE_PATH',{required:false,defaultValue:'/resource'});
const commandPath=env('PACT_QUAL_COMMAND_PATH',{required:false,defaultValue:'/command'});
const observePath=env('PACT_QUAL_OBSERVE_PATH',{required:false,defaultValue:'/state'});
const expectedRevisionHeader=env('PACT_QUAL_EXPECTED_REVISION_HEADER',{required:false,defaultValue:'if-match'}).toLowerCase();
const enableFencing=env('PACT_QUAL_REMOTE_FENCING',{required:false,defaultValue:'false'}).toLowerCase()==='true';

function secureBase(value,code){let url;try{url=new URL(value)}catch{fail(code)}if(url.protocol!=='https:')fail(code);if(url.username||url.password||url.search||url.hash)fail(code);return url.toString().replace(/\/$/,'')}
function url(base,path){let out;try{out=new URL(path,`${base}/`)}catch{fail('PACT_QUALIFICATION_PATH_INVALID')}if(out.origin!==new URL(base).origin)fail('PACT_QUALIFICATION_CROSS_ORIGIN_PATH');return out.toString()}
function headers(token,extra={}){return{accept:'application/json',...(token?{authorization:`Bearer ${token}`}:{}) ,...extra}}
async function jsonResponse(response,code){const text=await response.text();let body;try{body=text?JSON.parse(text):{}}catch{fail(code)}if(!body||typeof body!=='object'||Array.isArray(body))fail(code);return body}
async function request(base,path,{method='GET',token='',body=null,extraHeaders={}}={}){let response;try{response=await fetch(url(base,path),{method,headers:headers(token,{...(body!=null?{'content-type':'application/json'}:{}),...extraHeaders}),...(body!=null?{body:JSON.stringify(body)}:{}) ,signal:AbortSignal.timeout(30_000)})}catch(cause){const error=new Error('PACT_QUALIFICATION_NETWORK_FAILURE',{cause});error.uncertain=true;throw error}const parsed=await jsonResponse(response,'PACT_QUALIFICATION_PROVIDER_RESPONSE_INVALID');if(!response.ok){const error=new Error(`PACT_QUALIFICATION_HTTP_${response.status}`);error.status=response.status;error.body=parsed;throw error}return{response,body:parsed}}
async function control(path,options={}){return (await request(controlBase,path,{token:controlToken,...options})).body}
async function effectCount(){const value=await control(`/effects?family=${encodeURIComponent(family)}&target=${encodeURIComponent(targetId)}`);if(!Number.isSafeInteger(value.count)||value.count<0)fail('PACT_QUALIFICATION_EFFECT_COUNT_INVALID');return value.count}
async function reset(index){const value=await control('/reset',{method:'POST',body:{family,targetId,index}});if(value.reset!==true)fail('PACT_QUALIFICATION_RESET_REJECTED')}
async function armAfterWriteFailure(){const value=await control('/faults/after-write',{method:'POST',body:{family,targetId}});if(value.armed!==true)fail('PACT_QUALIFICATION_FAULT_NOT_ARMED')}
async function applyFence({generation}){const value=await control('/fence',{method:'POST',body:{family,targetId,generation}});if(typeof value.accepted!=='boolean')fail('PACT_QUALIFICATION_FENCE_RESPONSE_INVALID');return{accepted:value.accepted,status:Number.isInteger(value.status)?value.status:null}}
async function readFence(){const value=await control(`/fence?family=${encodeURIComponent(family)}&target=${encodeURIComponent(targetId)}`);if(typeof value.revision!=='string'||!value.state||typeof value.state!=='object')fail('PACT_QUALIFICATION_FENCE_OBSERVATION_INVALID');return{revision:value.revision,state:value.state}}
function bearer(){return targetToken?{authorization:`Bearer ${targetToken}`}:{}}
function genericIntent(index,value){if(family==='etag-json')return{path:['value'],value};if(family==='kubernetes-resource-version')return{path:['data','value'],value:String(value)};return{qualificationRun:index,value};}

function makeDriver(store,index){
  const common={id:`qual-${family}`,version:'1.0.0',providerId:`qual:${family}`,resourceKey:`${targetId}:${family}`,atomicDomain:`qualification:${family}`};
  if(family==='etag-json')return createEtagJsonDriver({...common,store,baseUrl:targetBase,resourcePath,headers:bearer(),conditionalWrite:'strong-validator',remoteFencing:enableFencing});
  if(family==='kubernetes-resource-version')return createKubernetesResourceDriver({...common,baseUrl:targetBase,resourcePath,bearerToken:targetToken});
  if(family==='idempotent-command')return createIdempotentCommandDriver({...common,commandId:commandPath,observeId:observePath,store,
    async command({intent,idempotencyKey}){const {body}=await request(targetBase,commandPath,{method:'POST',token:targetToken,body:{intent},extraHeaders:{'idempotency-key':idempotencyKey}});return body},
    async observe(){const {body}=await request(targetBase,observePath,{token:targetToken});if(typeof body.revision!=='string'||!body.state||typeof body.state!=='object')fail('PACT_QUALIFICATION_OBSERVATION_INVALID');return body},
    async verifyOutcome({intent,observed}){return observed?.state?.value===intent.value&&observed?.state?.qualificationRun===intent.qualificationRun}
  });
  return createVersionedCommandDriver({...common,commandId:commandPath,
    async read(){return (await request(targetBase,observePath,{token:targetToken})).body},
    async apply({intent,expectedRevision,idempotencyKey}){return (await request(targetBase,commandPath,{method:'POST',token:targetToken,body:{intent},extraHeaders:{[expectedRevisionHeader]:expectedRevision,'idempotency-key':idempotencyKey}})).body},
    async observe(){return (await request(targetBase,observePath,{token:targetToken})).body},
    readRevision(value){return value.revision},
    classifyConflict(error){return error?.status===409||error?.status===412},
    async verifyOutcome({intent,observed}){return observed?.state?.value===intent.value&&observed?.state?.qualificationRun===intent.qualificationRun}
  });
}

export async function createQualificationContext({index=0}={}){
  if(!Number.isSafeInteger(index)||index<0)fail('PACT_QUALIFICATION_INDEX_INVALID');
  const store=new MemoryAuthorityStore();
  const qualifier=createPactProviderQualifier({store});
  const driver=makeDriver(store,index);
  const scenarios={
    reset:async()=>reset(index),
    intentA:genericIntent(index,index*2+1),
    intentB:genericIntent(index,index*2+2),
    effectCount,
    armAfterWriteFailure,
    ...(enableFencing?{fencing:{apply:applyFence,read:readFence,generation:1000+index*2}}:{})
  };
  return{driver,qualifier,qualificationTarget:{id:`${targetId}:${family}`,production:false},releaseSha,scenarios};
}
