import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProviderQualificationCorpus, assertProductionQualified } from '../src/provider-qualification-report.js';

const tx=(index,overrides={})=>({id:`tx-${index}`,driverFamily:'etag-json',status:'VERIFIED',duplicateEffect:false,falseVerification:false,unresolved:false,latencyMs:20+(index%10),evidenceHash:'a'.repeat(64),...overrides});

test('production corpus requires at least 1000 real transactions with zero critical correctness errors',()=>{
  const summary=summarizeProviderQualificationCorpus(Array.from({length:1000},(_,i)=>tx(i)));
  assert.equal(summary.transactionCount,1000);assert.equal(summary.productionEligible,true);assert.equal(summary.duplicateEffects,0);assert.equal(summary.falseVerifications,0);assert.equal(summary.unresolved,0);assert.ok(summary.p95LatencyMs>=summary.p50LatencyMs);assert.equal(assertProductionQualified(summary),true);
});

test('small, duplicate-effect, false-verification and unresolved corpora cannot qualify',()=>{
  assert.equal(summarizeProviderQualificationCorpus(Array.from({length:999},(_,i)=>tx(i))).productionEligible,false);
  assert.equal(summarizeProviderQualificationCorpus(Array.from({length:1000},(_,i)=>tx(i,i===4?{duplicateEffect:true}:{}))).productionEligible,false);
  assert.equal(summarizeProviderQualificationCorpus(Array.from({length:1000},(_,i)=>tx(i,i===5?{falseVerification:true}:{}))).productionEligible,false);
  assert.equal(summarizeProviderQualificationCorpus(Array.from({length:1000},(_,i)=>tx(i,i===6?{unresolved:true,status:'UNRESOLVED'}:{}))).productionEligible,false);
});

test('corpus refuses duplicate transaction identities and fabricated evidence hashes',()=>{
  const items=[tx(1),tx(1)];assert.throws(()=>summarizeProviderQualificationCorpus(items),/DUPLICATE_TRANSACTION/);
  assert.throws(()=>summarizeProviderQualificationCorpus([tx(2,{evidenceHash:'fake'})]),/EVIDENCE_HASH_INVALID/);
});
