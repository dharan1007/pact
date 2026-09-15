import test from 'node:test';
import assert from 'node:assert/strict';
import { definePactProviderDriver } from '../src/provider-driver.js';

const valid=overrides=>({
  id:'provider.test',version:'1.0.0',
  describe(){return {capabilities:{}}},
  async read(){return {revision:'1',state:{}}},
  async plan(){return {effects:[],invariants:[],command:{}}},
  async precondition(){return {revision:'1'}},
  async commit(){return {providerRequestId:'r1'}},
  async observe(){return {revision:'2',state:{}}},
  async verify(){return true},
  async reconcile(){return {classification:'UNRESOLVED'}},
  ...overrides
});

test('accepts and freezes the complete organisational provider contract',()=>{
  const driver=definePactProviderDriver(valid());
  assert.equal(driver.id,'provider.test');
  assert.equal(driver.version,'1.0.0');
  assert.equal(Object.isFrozen(driver),true);
});

test('rejects missing consequential lifecycle methods',()=>{
  for(const method of ['describe','read','plan','precondition','commit','observe','verify','reconcile']){
    const candidate=valid();delete candidate[method];
    assert.throws(()=>definePactProviderDriver(candidate),new RegExp(`PACT_PROVIDER_DRIVER_METHOD_REQUIRED:${method}`));
  }
});

test('rejects unsafe identity and non-function compensation',()=>{
  assert.throws(()=>definePactProviderDriver(valid({id:'../bad'})),/INVALID_ID/);
  assert.throws(()=>definePactProviderDriver(valid({version:'latest'})),/INVALID_VERSION/);
  assert.throws(()=>definePactProviderDriver(valid({compensate:true})),/INVALID_COMPENSATE/);
});
