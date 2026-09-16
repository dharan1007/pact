import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProviderQualificationCorpus, assertProductionQualified, REQUIRED_PROVIDER_FAMILIES } from '../src/provider-qualification-report.js';

const tx=(index,overrides={})=>({id:`tx-${index}`,driverFamily:'etag-json',status:'VERIFIED',duplicateEffect:false,falseVerification:false,unresolved:false,latencyMs:20+(index%10),evidenceHash:'a'.repeat(64),...overrides});
const completeCorpus=()=>REQUIRED_PROVIDER_FAMILIES.flatMap((family,familyIndex)=>Array.from({length:1000},(_,index)=>tx(familyIndex*1000+index,{driverFamily:family,evidenceHash:String(familyIndex+1).repeat(64)})));

test('production corpus requires at least 1000 real transactions for every organisational driver family with zero critical correctness errors',()=>{
  const summary=summarizeProviderQualificationCorpus(completeCorpus());
  assert.equal(summary.transactionCount,4000);
  assert.equal(summary.productionEligible,true);
  assert.deepEqual(summary.missingDriverFamilies,[]);
  assert.deepEqual(summary.driverFamilies,[...REQUIRED_PROVIDER_FAMILIES].sort());
  for(const family of REQUIRED_PROVIDER_FAMILIES){assert.equal(summary.perFamily[family].transactionCount,1000);assert.equal(summary.perFamily[family].productionEligible,true);}
  assert.equal(summary.duplicateEffects,0);assert.equal(summary.falseVerifications,0);assert.equal(summary.unresolved,0);assert.ok(summary.p95LatencyMs>=summary.p50LatencyMs);assert.equal(assertProductionQualified(summary),true);
});

test('a perfect corpus for only one driver family cannot qualify the organisational runtime',()=>{
  const summary=summarizeProviderQualificationCorpus(Array.from({length:1000},(_,i)=>tx(i)));
  assert.equal(summary.productionEligible,false);
  assert.deepEqual(summary.missingDriverFamilies.sort(),REQUIRED_PROVIDER_FAMILIES.filter(family=>family!=='etag-json').sort());
  assert.throws(()=>assertProductionQualified(summary),/PRODUCTION_EVIDENCE_INSUFFICIENT/);
});

test('small, duplicate-effect, false-verification and unresolved corpora cannot qualify',()=>{
  const small=completeCorpus().filter((_,index)=>index!==0);
  assert.equal(summarizeProviderQualificationCorpus(small).productionEligible,false);
  const duplicate=completeCorpus();duplicate[4]={...duplicate[4],duplicateEffect:true};assert.equal(summarizeProviderQualificationCorpus(duplicate).productionEligible,false);
  const falseVerified=completeCorpus();falseVerified[5]={...falseVerified[5],falseVerification:true};assert.equal(summarizeProviderQualificationCorpus(falseVerified).productionEligible,false);
  const unresolved=completeCorpus();unresolved[6]={...unresolved[6],unresolved:true,status:'UNRESOLVED'};assert.equal(summarizeProviderQualificationCorpus(unresolved).productionEligible,false);
});

test('corpus refuses duplicate transaction identities, fabricated evidence hashes and unknown driver families',()=>{
  const items=[tx(1),tx(1)];assert.throws(()=>summarizeProviderQualificationCorpus(items),/DUPLICATE_TRANSACTION/);
  assert.throws(()=>summarizeProviderQualificationCorpus([tx(2,{evidenceHash:'fake'})]),/EVIDENCE_HASH_INVALID/);
  assert.throws(()=>summarizeProviderQualificationCorpus([tx(3,{driverFamily:'magic-provider'})]),/DRIVER_FAMILY_UNSUPPORTED/);
});
