import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_ASSURANCE, deriveProviderAssurance, assuranceAtLeast } from '../src/provider-assurance.js';

const now=2_000_000;
const binding={providerId:'payments',driverId:'stripe.command',driverVersion:'1.0.0',configDigest:'a'.repeat(64)};
const evidence=(probeType,overrides={})=>({schema:1,status:'provider-verified',probeType,binding,completedAt:now-1000,expiresAt:now+100_000,evidenceHash:'b'.repeat(64),...overrides});

const derive=(items,capabilities={})=>deriveProviderAssurance({binding,description:{capabilities},evidence:items,now:()=>now});

test('starts unqualified and advances only from executed evidence',()=>{
  assert.equal(derive([],{}).assurance,PROVIDER_ASSURANCE.P0_UNQUALIFIED);
  assert.equal(derive([evidence('idempotency')],{idempotency:true}).assurance,PROVIDER_ASSURANCE.P1_IDEMPOTENT);
  assert.equal(derive([evidence('conditional-write')],{conditionalWrite:true}).assurance,PROVIDER_ASSURANCE.P2_CONDITIONAL);
  assert.equal(derive([evidence('conditional-write'),evidence('reconciliation')],{conditionalWrite:true,strongRevision:true,stateReplacement:true,reconciliation:true}).assurance,PROVIDER_ASSURANCE.P3_STRONGLY_VERSIONED);
  assert.equal(derive([evidence('conditional-write'),evidence('reconciliation'),evidence('remote-fencing')],{conditionalWrite:true,strongRevision:true,stateReplacement:true,reconciliation:true,remoteFencing:true}).assurance,PROVIDER_ASSURANCE.P4_REMOTE_FENCED);
});

test('expired or differently-bound evidence cannot raise assurance',()=>{
  const expired=evidence('conditional-write',{expiresAt:now-1});
  assert.equal(derive([expired],{conditionalWrite:true}).assurance,PROVIDER_ASSURANCE.P0_UNQUALIFIED);
  const mismatched=evidence('conditional-write',{binding:{...binding,driverVersion:'2.0.0'}});
  const result=derive([mismatched],{conditionalWrite:true});
  assert.equal(result.assurance,PROVIDER_ASSURANCE.P0_UNQUALIFIED);
  assert.ok(result.reasons.includes('EVIDENCE_BINDING_MISMATCH'));
});

test('P3 requires reconciliation plus a replay-safe mutation model',()=>{
  const conditional=evidence('conditional-write');
  const reconciliation=evidence('reconciliation');
  assert.equal(derive([conditional,reconciliation],{conditionalWrite:true,strongRevision:true,reconciliation:true}).assurance,PROVIDER_ASSURANCE.P2_CONDITIONAL);
  assert.equal(derive([conditional,reconciliation,evidence('idempotency')],{conditionalWrite:true,strongRevision:true,reconciliation:true,idempotency:true}).assurance,PROVIDER_ASSURANCE.P3_STRONGLY_VERSIONED);
});

test('policy comparison follows the explicit assurance ordering',()=>{
  assert.equal(assuranceAtLeast(PROVIDER_ASSURANCE.P3_STRONGLY_VERSIONED,PROVIDER_ASSURANCE.P2_CONDITIONAL),true);
  assert.equal(assuranceAtLeast(PROVIDER_ASSURANCE.P1_IDEMPOTENT,PROVIDER_ASSURANCE.P2_CONDITIONAL),false);
  assert.throws(()=>assuranceAtLeast('P9_FAKE',PROVIDER_ASSURANCE.P0_UNQUALIFIED),/INVALID_ASSURANCE/);
});
