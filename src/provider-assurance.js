import { createHash } from 'node:crypto';

const fail=code=>{throw new Error(code)};
const HASH=/^[a-f0-9]{64}$/;
const ASSURANCE_ORDER=Object.freeze(['P0_UNQUALIFIED','P1_IDEMPOTENT','P2_CONDITIONAL','P3_STRONGLY_VERSIONED','P4_REMOTE_FENCED']);
export const PROVIDER_ASSURANCE=Object.freeze(Object.fromEntries(ASSURANCE_ORDER.map(value=>[value,value])));
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);

function canonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;}
function digest(value){return createHash('sha256').update(canonical(value)).digest('hex');}
function sameBinding(left,right){return Boolean(left&&right)&&left.providerId===right.providerId&&left.driverId===right.driverId&&left.driverVersion===right.driverVersion&&left.configDigest===right.configDigest;}
function validBinding(binding){return isObject(binding)&&typeof binding.providerId==='string'&&binding.providerId&&typeof binding.driverId==='string'&&binding.driverId&&typeof binding.driverVersion==='string'&&binding.driverVersion&&typeof binding.configDigest==='string'&&HASH.test(binding.configDigest);}
function normalizedEvidence(items,binding,now){
  const valid=[];const reasons=[];
  for(const item of Array.isArray(items)?items:[]){
    if(!isObject(item)||item.schema!==1||item.status!=='provider-verified'||typeof item.probeType!=='string'||!item.probeType){reasons.push('EVIDENCE_INVALID');continue;}
    if(!sameBinding(item.binding,binding)){reasons.push('EVIDENCE_BINDING_MISMATCH');continue;}
    if(!Number.isFinite(item.completedAt)||!Number.isFinite(item.expiresAt)||item.expiresAt<=item.completedAt||item.expiresAt<=now){reasons.push('EVIDENCE_EXPIRED');continue;}
    if(typeof item.evidenceHash!=='string'||!HASH.test(item.evidenceHash)){reasons.push('EVIDENCE_HASH_INVALID');continue;}
    valid.push(item);
  }
  return {valid,reasons:[...new Set(reasons)]};
}
function evidenceIdentity(valid,binding){return digest({binding,evidence:[...valid].map(item=>({probeType:item.probeType,evidenceHash:item.evidenceHash,completedAt:item.completedAt,expiresAt:item.expiresAt})).sort((a,b)=>a.probeType.localeCompare(b.probeType)||a.evidenceHash.localeCompare(b.evidenceHash))});}

export function assuranceAtLeast(actual,required){const actualIndex=ASSURANCE_ORDER.indexOf(actual),requiredIndex=ASSURANCE_ORDER.indexOf(required);if(actualIndex<0||requiredIndex<0)fail('PACT_PROVIDER_INVALID_ASSURANCE');return actualIndex>=requiredIndex;}

export function deriveProviderAssurance({binding,description={},evidence=[],now=()=>Date.now()}={}){
  if(!validBinding(binding))fail('PACT_PROVIDER_ASSURANCE_INVALID_BINDING');
  if(typeof now!=='function')fail('PACT_PROVIDER_ASSURANCE_INVALID_CLOCK');const timestamp=now();if(!Number.isFinite(timestamp))fail('PACT_PROVIDER_ASSURANCE_INVALID_CLOCK');
  const capabilities=isObject(description?.capabilities)?description.capabilities:{};
  const {valid,reasons}=normalizedEvidence(evidence,binding,timestamp);
  const probes=new Set(valid.map(item=>item.probeType));
  let assurance=PROVIDER_ASSURANCE.P0_UNQUALIFIED;
  if(capabilities.idempotency===true&&probes.has('idempotency'))assurance=PROVIDER_ASSURANCE.P1_IDEMPOTENT;
  if(capabilities.conditionalWrite===true&&probes.has('conditional-write'))assurance=PROVIDER_ASSURANCE.P2_CONDITIONAL;
  const replaySafe=(capabilities.idempotency===true&&probes.has('idempotency'))||capabilities.stateReplacement===true;
  if(assuranceAtLeast(assurance,PROVIDER_ASSURANCE.P2_CONDITIONAL)&&capabilities.strongRevision===true&&capabilities.reconciliation===true&&probes.has('reconciliation')&&replaySafe)assurance=PROVIDER_ASSURANCE.P3_STRONGLY_VERSIONED;
  if(assurance===PROVIDER_ASSURANCE.P3_STRONGLY_VERSIONED&&capabilities.remoteFencing===true&&probes.has('remote-fencing'))assurance=PROVIDER_ASSURANCE.P4_REMOTE_FENCED;
  return Object.freeze({assurance,reasons:Object.freeze(reasons),validEvidence:Object.freeze(valid.map(item=>item.probeType)),evidenceDigest:evidenceIdentity(valid,binding),binding:Object.freeze({...binding}),evaluatedAt:timestamp});
}
