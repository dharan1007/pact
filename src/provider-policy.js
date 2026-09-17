import { PROVIDER_ASSURANCE, assuranceAtLeast } from './provider-assurance.js';

const fail=code=>{throw new Error(code)};
const READ_RECOVERY_OPERATIONS=new Set(['inspect','preview','verify','receipt','reconcile']);
const GATED_OPERATIONS=new Set(['approve','commit']);
const HASH=/^[a-f0-9]{64}$/;
const BINDING_KEYS=['providerId','driverId','driverVersion','configDigest'];

function normalizeBinding(value){
  if(value==null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))fail('PACT_PROVIDER_POLICY_INVALID_BINDING');
  const binding={};
  for(const key of BINDING_KEYS){if(typeof value[key]!=='string'||!value[key])fail('PACT_PROVIDER_POLICY_INVALID_BINDING');binding[key]=value[key];}
  if(!HASH.test(binding.configDigest))fail('PACT_PROVIDER_POLICY_INVALID_BINDING');
  return Object.freeze(binding);
}

export function evaluateProviderPolicy({operation,minimumAssurance=PROVIDER_ASSURANCE.P0_UNQUALIFIED,providerAssurance}={}){
  if(typeof operation!=='string'||(!READ_RECOVERY_OPERATIONS.has(operation)&&!GATED_OPERATIONS.has(operation)))fail('PACT_PROVIDER_POLICY_INVALID_OPERATION');
  if(!providerAssurance||typeof providerAssurance!=='object'||Array.isArray(providerAssurance)||typeof providerAssurance.assurance!=='string')fail('PACT_PROVIDER_POLICY_ASSURANCE_REQUIRED');
  assuranceAtLeast(providerAssurance.assurance,PROVIDER_ASSURANCE.P0_UNQUALIFIED);
  assuranceAtLeast(minimumAssurance,PROVIDER_ASSURANCE.P0_UNQUALIFIED);
  const recoverySafe=READ_RECOVERY_OPERATIONS.has(operation);
  const allowed=recoverySafe||assuranceAtLeast(providerAssurance.assurance,minimumAssurance);
  const digest=providerAssurance.evidenceDigest==null?null:String(providerAssurance.evidenceDigest);
  if(digest!==null&&!HASH.test(digest))fail('PACT_PROVIDER_POLICY_INVALID_EVIDENCE_DIGEST');
  return Object.freeze({
    operation,
    allowed,
    requiredAssurance:minimumAssurance,
    actualAssurance:providerAssurance.assurance,
    evidenceDigest:digest,
    providerBinding:normalizeBinding(providerAssurance.binding),
    recoverySafe
  });
}

export function assertProviderPolicy(result){
  if(!result||typeof result!=='object'||Array.isArray(result)||typeof result.allowed!=='boolean')fail('PACT_PROVIDER_POLICY_RESULT_REQUIRED');
  if(result.allowed)return result;
  const error=new Error('PACT_PROVIDER_ASSURANCE_INSUFFICIENT');
  error.requiredAssurance=result.requiredAssurance;
  error.actualAssurance=result.actualAssurance;
  error.operation=result.operation;
  throw error;
}
