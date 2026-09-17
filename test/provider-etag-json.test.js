import test from 'node:test';
import assert from 'node:assert/strict';
import { createEtagJsonDriver } from '../src/providers/etag-json.js';

const clone=value=>value===undefined?undefined:structuredClone(value);

function atomicStore(){
  const data=new Map();
  return {
    async get(key){return clone(data.get(key)??null)},
    async create(key,value){if(data.has(key))return false;data.set(key,clone(value));return true},
    async compareAndSwap(key,expectedVersion,value){const current=data.get(key);if(!current||current.version!==expectedVersion)return false;data.set(key,clone(value));return true}
  };
}

function response(status,body,etag){
  return {ok:status>=200&&status<300,status,headers:{get(name){return String(name).toLowerCase()==='etag'?(etag??null):null}},async text(){return body==null?'':JSON.stringify(body)}};
}

function providerHarness({weak=false,fenceHeader=null}={}){
  let revision=1;
  let resource={profile:{name:'Ada'},enabled:false};
  let writes=0;
  let loseNext=false;
  let highestFence=0;
  const requests=[];
  const etag=()=>`${weak?'W/':''}"r${revision}"`;
  const fetchImpl=async (_url,options={})=>{
    const method=String(options.method??'GET').toUpperCase();
    requests.push({method,headers:{...(options.headers??{})},body:options.body});
    if(method==='GET')return response(200,resource,etag());
    if(fenceHeader){
      const raw=options.headers?.[fenceHeader];
      const generation=Number(raw);
      if(!Number.isSafeInteger(generation)||generation<1)return response(400,{error:'missing-fence'},etag());
      if(generation<=highestFence)return response(409,{error:'stale-fence'},etag());
      highestFence=generation;
    }
    if(options.headers?.['if-match']!==etag())return response(412,{error:'stale'},etag());
    writes+=1;
    resource=JSON.parse(options.body);
    revision+=1;
    if(loseNext){loseNext=false;throw new Error('NETWORK_RESPONSE_LOST')}
    return response(200,resource,etag());
  };
  return {
    fetchImpl,requests,writes:()=>writes,current:()=>clone(resource),
    drift(next){resource=clone(next);revision+=1},
    loseResponseOnce(){loseNext=true}
  };
}

function makeDriver(provider,overrides={}){
  return createEtagJsonDriver({
    id:'crm.account',version:'1.0.0',providerId:'crm-primary',
    store:atomicStore(),resourceKey:'account:42',atomicDomain:'crm/account',
    baseUrl:'https://api.example.test',resourcePath:'/v1/accounts/42',
    fetchImpl:provider.fetchImpl,conditionalWrite:'strong-validator',
    ...overrides
  });
}

test('describes explicit ETag state-replacement semantics without self-qualifying them',()=>{
  const provider=providerHarness();
  const driver=makeDriver(provider);
  const description=driver.describe();
  assert.equal(description.providerId,'crm-primary');
  assert.equal(description.driverId,'crm.account');
  assert.equal(description.driverVersion,'1.0.0');
  assert.match(description.configDigest,/^[a-f0-9]{64}$/);
  assert.deepEqual(description.capabilities,{
    idempotency:true,
    conditionalWrite:true,
    strongRevision:true,
    reconciliation:true,
    stateReplacement:true,
    remoteFencing:false
  });
});

test('plans, conditionally commits and independently verifies a resource mutation',async()=>{
  const provider=providerHarness();
  const driver=makeDriver(provider);
  const observed=await driver.read();
  const plan=await driver.plan({intent:{path:['enabled'],value:true},observed});
  assert.equal(plan.before.version,0);
  assert.equal(plan.next.version,1);
  assert.equal(plan.next.resource.enabled,true);
  assert.deepEqual(await driver.precondition({observed,plan}),{kind:'etag-json',canonicalVersion:0});
  const committed=await driver.commit({plan,authorization:{authorizationId:'auth-1'},idempotencyKey:'auth-1'});
  assert.equal(committed.version,1);
  assert.equal(provider.writes(),1);
  const write=provider.requests.find(item=>item.method==='PUT');
  assert.equal(write.headers['if-match'],'"r1"');
  assert.equal(write.headers['idempotency-key'],'auth-1');
  const after=await driver.observe({plan});
  assert.equal(await driver.verify({plan,observed:after}),true);
});

test('configured remote fencing is carried by the actual conditional mutation and stale generations are rejected remotely',async()=>{
  const provider=providerHarness({fenceHeader:'x-pact-fence'});
  const driver=makeDriver(provider,{remoteFencing:{mode:'monotonic-header',header:'x-pact-fence'}});
  assert.equal(driver.describe().capabilities.remoteFencing,true);
  let observed=await driver.read();
  let plan=await driver.plan({intent:{path:['enabled'],value:true},observed});
  await driver.commit({plan,authorization:{authorizationId:'fenced-1'},idempotencyKey:'fenced-1',fence:{generation:10,ownerId:'worker-a'}});
  const firstWrite=provider.requests.find(item=>item.method==='PUT');
  assert.equal(firstWrite.headers['x-pact-fence'],'10');
  observed=await driver.read();
  plan=await driver.plan({intent:{path:['enabled'],value:false},observed});
  await assert.rejects(()=>driver.commit({plan,authorization:{authorizationId:'fenced-2'},idempotencyKey:'fenced-2',fence:{generation:9,ownerId:'worker-b'}}),/PACT_REST_PROVIDER_REJECTED|PACT_REST_STALE_PROVIDER_STATE/);
  assert.equal(provider.writes(),1);
});

test('remote-fencing capability cannot be declared without a concrete safe fence header',()=>{
  const provider=providerHarness();
  assert.throws(()=>makeDriver(provider,{remoteFencing:true}),/PACT_ETAG_DRIVER_REMOTE_FENCING_INVALID/);
  assert.throws(()=>makeDriver(provider,{remoteFencing:{mode:'monotonic-header',header:'authorization'}}),/PACT_ETAG_DRIVER_REMOTE_FENCING_INVALID/);
});

test('rejects stale expected state after out-of-band provider drift',async()=>{
  const provider=providerHarness();
  const driver=makeDriver(provider);
  const observed=await driver.read();
  const plan=await driver.plan({intent:{path:['enabled'],value:true},observed});
  provider.drift({profile:{name:'Grace'},enabled:false});
  await assert.rejects(()=>driver.commit({plan,authorization:{authorizationId:'auth-2'},idempotencyKey:'auth-2'}),/PACT_REST_STALE_PROVIDER_STATE/);
  assert.equal(provider.writes(),0);
});

test('replay is single-effect and different payload under the same key is rejected',async()=>{
  const provider=providerHarness();
  const driver=makeDriver(provider);
  const observed=await driver.read();
  const plan=await driver.plan({intent:{path:['enabled'],value:true},observed});
  await driver.commit({plan,authorization:{authorizationId:'auth-3'},idempotencyKey:'auth-3'});
  await driver.commit({plan,authorization:{authorizationId:'auth-3'},idempotencyKey:'auth-3'});
  assert.equal(provider.writes(),1);
  const conflicting={...plan,next:{...plan.next,resource:{...plan.next.resource,enabled:false}}};
  await assert.rejects(()=>driver.commit({plan:conflicting,authorization:{authorizationId:'auth-3'},idempotencyKey:'auth-3'}),/PACT_REST_IDEMPOTENCY_CONFLICT/);
  assert.equal(provider.writes(),1);
});

test('lost response reconciles to COMMITTED by rereading provider state without a second mutation',async()=>{
  const provider=providerHarness();
  const driver=makeDriver(provider);
  const observed=await driver.read();
  const plan=await driver.plan({intent:{path:['enabled'],value:true},observed});
  provider.loseResponseOnce();
  let uncertain;
  try{await driver.commit({plan,authorization:{authorizationId:'auth-4'},idempotencyKey:'auth-4'})}catch(error){uncertain=error}
  assert.match(uncertain?.message??'',/PACT_REST_COMMIT_UNCERTAIN/);
  assert.equal(provider.writes(),1);
  assert.deepEqual(await driver.reconcile({plan,error:uncertain}),{classification:'COMMITTED'});
  assert.equal(provider.writes(),1);
});

test('weak provider validators are rejected when strong-validator semantics are configured',async()=>{
  const provider=providerHarness({weak:true});
  const driver=makeDriver(provider);
  await assert.rejects(()=>driver.read(),/PACT_ETAG_DRIVER_STRONG_ETAG_REQUIRED/);
});
