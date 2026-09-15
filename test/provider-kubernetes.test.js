import test from 'node:test';
import assert from 'node:assert/strict';
import { createKubernetesResourceDriver } from '../src/providers/kubernetes-resource.js';

const clone=value=>value===undefined?undefined:structuredClone(value);
function response(status,body){return {ok:status>=200&&status<300,status,async text(){return body==null?'':JSON.stringify(body)}}}
function harness(){
  let revision=7,writes=0;
  let resource={apiVersion:'v1',kind:'ConfigMap',metadata:{name:'app',namespace:'qa',resourceVersion:String(revision),labels:{team:'platform'}},data:{mode:'safe',owner:'a'}};
  let loseNext=false;
  const requests=[];
  const fetchImpl=async(_url,options={})=>{
    const method=String(options.method??'GET').toUpperCase();requests.push({method,headers:{...(options.headers??{})},body:options.body});
    if(method==='GET')return response(200,resource);
    const next=JSON.parse(options.body);
    if(next?.metadata?.resourceVersion!==String(revision))return response(409,{kind:'Status',reason:'Conflict'});
    writes+=1;revision+=1;resource={...next,metadata:{...next.metadata,resourceVersion:String(revision)}};
    if(loseNext){loseNext=false;throw new Error('NETWORK_RESPONSE_LOST')}
    return response(200,resource);
  };
  return {fetchImpl,requests,writes:()=>writes,current:()=>clone(resource),drift(){revision+=1;resource={...resource,metadata:{...resource.metadata,resourceVersion:String(revision)},data:{...resource.data,owner:'other'}}},loseResponseOnce(){loseNext=true}};
}
function driver(h){return createKubernetesResourceDriver({id:'kubernetes.configmap',version:'1.0.0',providerId:'cluster-a',baseUrl:'https://kubernetes.example.test',resourcePath:'/api/v1/namespaces/qa/configmaps/app',fetchImpl:h.fetchImpl,bearerToken:'secret',resourceKey:'qa/configmap/app',atomicDomain:'cluster-a/qa'});}

test('reads metadata.resourceVersion as provider revision and never exposes credentials in describe',async()=>{
  const h=harness(),d=driver(h);const observed=await d.read();
  assert.equal(observed.revision,'7');assert.equal(observed.state.data.mode,'safe');
  const description=d.describe();assert.equal(description.family,'kubernetes-resource-version');assert.equal(description.capabilities.conditionalWrite,true);assert.equal(description.capabilities.strongRevision,true);assert.equal(description.capabilities.idempotency,false);assert.doesNotMatch(JSON.stringify(description),/secret/);
});

test('commits with the observed resourceVersion and verifies by independent reread',async()=>{
  const h=harness(),d=driver(h);const observed=await d.read();
  const plan=await d.plan({intent:{operations:[{path:['data','mode'],value:'fast'}]},observed});
  assert.equal(plan.command.metadata.resourceVersion,'7');
  const committed=await d.commit({plan,authorization:{authorizationId:'auth-k1'},idempotencyKey:'auth-k1'});
  assert.equal(committed.revision,'8');assert.equal(h.writes(),1);
  const sent=JSON.parse(h.requests.find(x=>x.method==='PUT').body);assert.equal(sent.metadata.resourceVersion,'7');assert.equal(sent.data.mode,'fast');
  const after=await d.observe({plan});assert.equal(await d.verify({plan,observed:after}),true);
});

test('rejects immutable identity and overlapping mutation paths',async()=>{
  const h=harness(),d=driver(h),observed=await d.read();
  await assert.rejects(()=>d.plan({intent:{path:['metadata','resourceVersion'],value:'999'},observed}),/PACT_K8S_IMMUTABLE_IDENTITY_PATH/);
  await assert.rejects(()=>d.plan({intent:{operations:[{path:['metadata','labels'],value:{team:'a'}},{path:['metadata','labels','team'],value:'b'}]},observed}),/PACT_K8S_OVERLAPPING_OPERATION_PATH/);
});

test('maps Kubernetes 409 to stale provider state and does not claim success',async()=>{
  const h=harness(),d=driver(h);const observed=await d.read();const plan=await d.plan({intent:{path:['data','mode'],value:'fast'},observed});h.drift();
  await assert.rejects(()=>d.commit({plan,authorization:{authorizationId:'auth-k2'},idempotencyKey:'auth-k2'}),/PACT_K8S_STALE_PROVIDER_STATE/);
  assert.equal(h.writes(),0);
});

test('classifies a lost response by rereading the provider instead of issuing a second mutation',async()=>{
  const h=harness(),d=driver(h);const observed=await d.read();const plan=await d.plan({intent:{path:['data','mode'],value:'fast'},observed});h.loseResponseOnce();
  let uncertain;try{await d.commit({plan,authorization:{authorizationId:'auth-k3'},idempotencyKey:'auth-k3'})}catch(error){uncertain=error}
  assert.match(uncertain?.message??'',/PACT_K8S_COMMIT_UNCERTAIN/);assert.equal(h.writes(),1);
  assert.deepEqual(await d.reconcile({plan,error:uncertain}),{classification:'COMMITTED'});assert.equal(h.writes(),1);
});

test('refuses insecure Kubernetes API endpoints',()=>{
  const h=harness();assert.throws(()=>createKubernetesResourceDriver({id:'kubernetes.configmap',version:'1.0.0',providerId:'cluster-a',baseUrl:'http://kubernetes.example.test',resourcePath:'/api/v1/x',fetchImpl:h.fetchImpl,resourceKey:'x',atomicDomain:'x'}),/PACT_K8S_REQUIRES_HTTPS/);
});
