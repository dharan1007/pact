import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_ASSURANCE } from '../src/provider-assurance.js';
import { evaluateProviderPolicy, assertProviderPolicy } from '../src/provider-policy.js';

const assessment=(assurance=PROVIDER_ASSURANCE.P0_UNQUALIFIED)=>({assurance,evidenceDigest:'a'.repeat(64),binding:{providerId:'p',driverId:'d',driverVersion:'1.0.0',configDigest:'b'.repeat(64)}});

test('preview and inspection remain available below the mutation assurance floor',()=>{
  for(const operation of ['inspect','preview','verify','receipt','reconcile']){
    const result=evaluateProviderPolicy({operation,minimumAssurance:PROVIDER_ASSURANCE.P3_STRONGLY_VERSIONED,providerAssurance:assessment()});
    assert.equal(result.allowed,true,operation);
  }
});

test('approve and commit fail closed below required assurance',()=>{
  for(const operation of ['approve','commit']){
    const result=evaluateProviderPolicy({operation,minimumAssurance:PROVIDER_ASSURANCE.P3_STRONGLY_VERSIONED,providerAssurance:assessment(PROVIDER_ASSURANCE.P1_IDEMPOTENT)});
    assert.equal(result.allowed,false);assert.equal(result.requiredAssurance,PROVIDER_ASSURANCE.P3_STRONGLY_VERSIONED);assert.equal(result.actualAssurance,PROVIDER_ASSURANCE.P1_IDEMPOTENT);
    assert.throws(()=>assertProviderPolicy(result),error=>error.message==='PACT_PROVIDER_ASSURANCE_INSUFFICIENT'&&error.requiredAssurance===PROVIDER_ASSURANCE.P3_STRONGLY_VERSIONED&&error.actualAssurance===PROVIDER_ASSURANCE.P1_IDEMPOTENT);
  }
});

test('commit is allowed when actual assurance meets or exceeds the policy',()=>{
  const result=evaluateProviderPolicy({operation:'commit',minimumAssurance:PROVIDER_ASSURANCE.P2_CONDITIONAL,providerAssurance:assessment(PROVIDER_ASSURANCE.P3_STRONGLY_VERSIONED)});
  assert.equal(result.allowed,true);assert.equal(assertProviderPolicy(result),result);
});

test('policy result carries only bounded non-secret evidence identity',()=>{
  const result=evaluateProviderPolicy({operation:'commit',minimumAssurance:PROVIDER_ASSURANCE.P1_IDEMPOTENT,providerAssurance:assessment(PROVIDER_ASSURANCE.P1_IDEMPOTENT)});
  assert.equal(result.evidenceDigest,'a'.repeat(64));assert.deepEqual(result.providerBinding,{providerId:'p',driverId:'d',driverVersion:'1.0.0',configDigest:'b'.repeat(64)});
  assert.doesNotMatch(JSON.stringify(result),/token|authorization|secret/i);
});
