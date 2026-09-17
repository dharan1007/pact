import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAuthorityStore } from '../src/authority.js';
import { createPactProviderRegistry } from '../src/provider-registry.js';
import { createPactSagaAuthorityService } from '../src/saga-protocol.js';

function jsonResponse(status,body,headers={}){return{ok:status>=200&&status<300,status,headers:{get(name){return headers[String(name).toLowerCase()]??null}},async text(){return body==null?'':JSON.stringify(body)}}}
function harness(){
  let k8sRv=1,k8s={apiVersion:'v1',kind:'ConfigMap',metadata:{name:'app',namespace:'qa',resourceVersion:'1'},data:{mode:'safe'}};
  let command={revision:'op-0',status:'absent',value:null};
  let version=1,versioned={revision:'1',status:'open',owner:'a'};
  const calls=[];
  const fetchImpl=async(url,options={})=>{
    const u=new URL(url),method=String(options.method??'GET').toUpperCase();calls.push({host:u.host,path:u.pathname,method,headers:{...(options.headers??{})},body:options.body});
    if(u.host==='k8s.example'){
      if(method==='GET')return jsonResponse(200,k8s);
      const next=JSON.parse(options.body);if(next.metadata.resourceVersion!==String(k8sRv))return jsonResponse(409,{reason:'Conflict'});k8sRv+=1;k8s={...next,metadata:{...next.metadata,resourceVersion:String(k8sRv)}};return jsonResponse(200,k8s);
    }
    if(u.host==='commands.example'){
      if(u.pathname==='/observe')return jsonResponse(200,command);
      const intent=JSON.parse(options.body);command={revision:`op-${Number(command.revision.split('-')[1])+1}`,status:'succeeded',value:intent.value};return jsonResponse(200,{operationId:command.revision});
    }
    if(u.host==='versioned.example'){
      if(method==='GET')return jsonResponse(200,versioned);
      if(String(options.headers['if-match'])!==String(version))return jsonResponse(409,{error:'stale'});
      const intent=JSON.parse(options.body);version+=1;versioned={...versioned,...intent.patch,revision:String(version)};return jsonResponse(200,versioned);
    }
    throw new Error(`unexpected ${url}`);
  };
  return{fetchImpl,calls,current:()=>({k8s,command,versioned})};
}

function config(){return{version:1,providers:[
  {id:'cluster.config',type:'kubernetes-resource',driverVersion:'1.0.0',baseUrl:'https://k8s.example',resourcePath:'/api/v1/namespaces/qa/configmaps/app',resourceKey:'qa/configmap/app',atomicDomain:'cluster/qa',minimumAssurance:'P0_UNQUALIFIED'},
  {id:'payments.command',type:'idempotent-command',driverVersion:'1.0.0',baseUrl:'https://commands.example',commandPath:'/command',observePath:'/observe',commandId:'set-value',observeId:'read-value',resourceKey:'payment:42',atomicDomain:'payments',idempotencyHeader:'idempotency-key',revisionPath:'revision',minimumAssurance:'P0_UNQUALIFIED',verify:{equals:[{observedPath:'status',value:'succeeded'}],matches:[{observedPath:'value',intentPath:'value'}]}},
  {id:'crm.ticket',type:'versioned-command',driverVersion:'1.0.0',baseUrl:'https://versioned.example',readPath:'/ticket/42',commandPath:'/ticket/42',commandId:'update-ticket',resourceKey:'ticket:42',atomicDomain:'crm',revisionPath:'revision',expectedRevisionHeader:'if-match',minimumAssurance:'P0_UNQUALIFIED',verify:{matches:[{observedPath:'status',intentPath:'patch.status'}]}}
]}}

test('registry instantiates kubernetes, idempotent-command and versioned-command as saga handlers',async()=>{
  const h=harness(),store=new MemoryAuthorityStore(),registry=createPactProviderRegistry({store,config:config(),fetchImpl:h.fetchImpl,env:{}});
  assert.deepEqual(Object.keys(registry.handlers).sort(),['cluster.config','crm.ticket','payments.command']);
  const families=registry.providers.map(p=>p.family).sort();assert.deepEqual(families,['explicit-version-command','idempotent-command','kubernetes-resource-version']);
  for(const handler of Object.values(registry.handlers)){assert.equal(typeof handler.assertProviderOperation,'function');assert.equal(typeof handler.execute,'function');assert.equal(typeof handler.verify,'function');assert.equal(typeof handler.reconcile,'function');}
});

test('all driver families execute through the canonical saga authority path',async()=>{
  const h=harness(),store=new MemoryAuthorityStore(),registry=createPactProviderRegistry({store,config:config(),fetchImpl:h.fetchImpl,env:{}});
  const service=createPactSagaAuthorityService({store,handlers:registry.handlers,now:()=>1000,verifyApproval:async()=>({humanPrincipal:'human:ops',agentSession:'agent:ops'})});
  const preview=await service.sagaPreview({steps:[
    {id:'k8s',handler:'cluster.config',resourceKey:'qa/configmap/app',atomicDomain:'cluster/qa',input:{intent:{path:['data','mode'],value:'fast'}}},
    {id:'pay',handler:'payments.command',resourceKey:'payment:42',atomicDomain:'payments',input:{intent:{value:300}}},
    {id:'crm',handler:'crm.ticket',resourceKey:'ticket:42',atomicDomain:'crm',input:{intent:{patch:{status:'closed'}}}}
  ]});
  const approved=await service.sagaApprove({sagaId:preview.saga.id,approval:{signed:true}});
  const result=await service.sagaExecute({sagaId:preview.saga.id,capabilityToken:approved.capability.token,idempotencyKey:'multi-driver-1'});
  assert.equal(result.saga.state,'COMMITTED');
  const state=h.current();assert.equal(state.k8s.data.mode,'fast');assert.equal(state.command.value,300);assert.equal(state.versioned.status,'closed');
  const receipt=(await service.sagaReceipt({sagaId:preview.saga.id})).receipt;assert.equal(receipt.providerAssurance.commit.length,3);
});

test('declarative provider config refuses executable values and insecure endpoints',()=>{
  const h=harness(),store=new MemoryAuthorityStore();const bad=config();bad.providers[1].verify={matches:[{observedPath:'value',intentPath:'value',transform:'eval(x)'}]};
  assert.throws(()=>createPactProviderRegistry({store,config:bad,fetchImpl:h.fetchImpl,env:{}}),/PACT_PROVIDER_REGISTRY_VERIFY_RULE_INVALID/);
  const insecure=config();insecure.providers[2].baseUrl='http://versioned.example';
  assert.throws(()=>createPactProviderRegistry({store,config:insecure,fetchImpl:h.fetchImpl,env:{}}),/PACT_PROVIDER_REGISTRY_REQUIRES_HTTPS/);
});
