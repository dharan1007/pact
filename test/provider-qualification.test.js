import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createPactProviderQualifier } from '../src/provider-qualification.js';
import { deriveProviderAssurance, PROVIDER_ASSURANCE } from '../src/provider-assurance.js';

const clone = value => value === undefined ? undefined : structuredClone(value);
const BINDING={providerId:'identity.account',driverId:'etag-json',driverVersion:'1.0.0',configDigest:'a'.repeat(64)};
function providerDescriptor(withBinding=false,binding=BINDING) {
  return {id:'identity.account',resourceKey:'identity:account:42',atomicDomain:'identity/account/42',...(withBinding?{driverId:binding.driverId,driverVersion:binding.driverVersion,configDigest:binding.configDigest}:{})};
}
function conditionalProbe(stateRef,counter={count:0}){return{
  async read(){return{revision:`r${stateRef.revision}`,state:clone(stateRef.state)}},
  async advance(){counter.count+=1;stateRef.revision+=1;stateRef.state={...stateRef.state,marker:`qualified-${stateRef.revision}`};return{revision:`r${stateRef.revision}`,state:clone(stateRef.state)}},
  async attemptStaleWrite(){return{accepted:false,status:412}}
};}

test('conditional-write qualification proves stale rejection and unchanged canonical state before marking provider verified', async () => {
  const store = new MemoryAuthorityStore();let revision=1;let state={role:'admin',marker:'baseline'},staleAttempts=0;
  const qualifier=createPactProviderQualifier({store,now:()=>10_000});
  const evidence=await qualifier.qualifyConditionalWrite({provider:providerDescriptor(),probe:{
    async read(){return{revision:`r${revision}`,state:clone(state)}},
    async advance(){revision+=1;state={role:'admin',marker:'qualified'};return{revision:`r${revision}`,state:clone(state)}},
    async attemptStaleWrite({staleRevision}){staleAttempts+=1;assert.equal(staleRevision,'r1');return{accepted:false,status:412}}
  }});
  assert.equal(staleAttempts,1);assert.equal(evidence.status,'provider-verified');assert.equal(evidence.probeType,'conditional-write');assert.equal(evidence.beforeRevision,'r1');assert.equal(evidence.qualifiedRevision,'r2');assert.equal(evidence.staleProbeAccepted,false);assert.equal(evidence.canonicalUnchanged,true);assert.match(evidence.evidenceHash,/^[a-f0-9]{64}$/);assert.deepEqual(await qualifier.inspectQualification('identity.account','conditional-write'),evidence);
});

test('driver-bound qualification evidence is directly consumable by assurance and expires', async () => {
  const store=new MemoryAuthorityStore();let revision=1;let state={marker:'before'};let clock=100_000;
  const qualifier=createPactProviderQualifier({store,now:()=>clock,ttlMs:30*24*60*60*1000});
  const evidence=await qualifier.qualifyConditionalWrite({provider:providerDescriptor(true),probe:{async read(){return{revision:`r${revision}`,state:clone(state)}},async advance(){revision+=1;state={marker:'after'};return{revision:`r${revision}`,state:clone(state)}},async attemptStaleWrite(){return{accepted:false,status:412}}}});
  assert.deepEqual(evidence.binding,BINDING);assert.equal(evidence.expiresAt,evidence.completedAt+30*24*60*60*1000);assert.equal(deriveProviderAssurance({binding:BINDING,description:{capabilities:{conditionalWrite:true}},evidence:[evidence],now:()=>clock}).assurance,PROVIDER_ASSURANCE.P2_CONDITIONAL);
  clock=evidence.expiresAt+1;assert.equal(deriveProviderAssurance({binding:BINDING,description:{capabilities:{conditionalWrite:true}},evidence:[evidence],now:()=>clock}).assurance,PROVIDER_ASSURANCE.P0_UNQUALIFIED);
});

test('changing driver binding forces a fresh qualification and replaces obsolete evidence only after passing',async()=>{
  const store=new MemoryAuthorityStore();let clock=200_000;const stateRef={revision:1,state:{marker:'before'}};const firstCounter={count:0},secondCounter={count:0};
  const qualifier=createPactProviderQualifier({store,now:()=>clock});
  const first=await qualifier.qualifyConditionalWrite({provider:providerDescriptor(true),probe:conditionalProbe(stateRef,firstCounter)});assert.equal(firstCounter.count,1);
  const nextBinding={...BINDING,driverVersion:'2.0.0',configDigest:'b'.repeat(64)};
  clock+=1000;
  const second=await qualifier.qualifyConditionalWrite({provider:providerDescriptor(true,nextBinding),probe:conditionalProbe(stateRef,secondCounter)});
  assert.equal(secondCounter.count,1);assert.deepEqual(second.binding,nextBinding);assert.notEqual(second.evidenceHash,first.evidenceHash);
  assert.equal(deriveProviderAssurance({binding:BINDING,description:{capabilities:{conditionalWrite:true}},evidence:[second],now:()=>clock}).assurance,PROVIDER_ASSURANCE.P0_UNQUALIFIED);
  assert.equal(deriveProviderAssurance({binding:nextBinding,description:{capabilities:{conditionalWrite:true}},evidence:[second],now:()=>clock}).assurance,PROVIDER_ASSURANCE.P2_CONDITIONAL);
});

test('conditional-write qualification fails closed when stale mutation is accepted', async () => {
  const store=new MemoryAuthorityStore();const qualifier=createPactProviderQualifier({store,now:()=>20_000});let state={version:1};
  await assert.rejects(()=>qualifier.qualifyConditionalWrite({provider:providerDescriptor(),probe:{async read(){return{revision:`r${state.version}`,state:clone(state)}},async advance(){state={version:2};return{revision:'r2',state:clone(state)}},async attemptStaleWrite(){state={version:999};return{accepted:true,status:200}}}}),/PACT_PROVIDER_QUALIFICATION_STALE_WRITE_ACCEPTED/);
  assert.equal(await qualifier.inspectQualification('identity.account','conditional-write'),null);
});

test('remote-fencing qualification proves newer generation wins and stale generation cannot mutate canonical state', async () => {
  const store=new MemoryAuthorityStore();const qualifier=createPactProviderQualifier({store,now:()=>30_000});let highestFence=0;let state={fence:0,value:'before'};
  const evidence=await qualifier.qualifyRemoteFencing({provider:providerDescriptor(),generation:41,probe:{async apply({generation}){if(generation<=highestFence)return{accepted:false,status:409};highestFence=generation;state={fence:generation,value:'newer'};return{accepted:true,status:200}},async read(){return{revision:`f${highestFence}`,state:clone(state)}}}});
  assert.equal(evidence.status,'provider-verified');assert.equal(evidence.probeType,'remote-fencing');assert.equal(evidence.qualifiedGeneration,42);assert.equal(evidence.staleGeneration,41);assert.equal(evidence.staleProbeAccepted,false);assert.equal(evidence.canonicalUnchanged,true);assert.deepEqual(state,{fence:42,value:'newer'});assert.deepEqual(await qualifier.inspectQualification('identity.account','remote-fencing'),evidence);
});
