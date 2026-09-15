const fail=code=>{throw new Error(code)};
const REQUIRED_METHODS=Object.freeze(['describe','read','plan','precondition','commit','observe','verify','reconcile']);
const ID=/^[a-z0-9][a-z0-9._-]{0,127}$/;
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function definePactProviderDriver(driver){
  if(!driver||typeof driver!=='object'||Array.isArray(driver))fail('PACT_PROVIDER_DRIVER_REQUIRED');
  if(typeof driver.id!=='string'||!ID.test(driver.id))fail('PACT_PROVIDER_DRIVER_INVALID_ID');
  if(typeof driver.version!=='string'||!VERSION.test(driver.version))fail('PACT_PROVIDER_DRIVER_INVALID_VERSION');
  for(const method of REQUIRED_METHODS)if(typeof driver[method]!=='function')fail(`PACT_PROVIDER_DRIVER_METHOD_REQUIRED:${method}`);
  if(driver.compensate!==undefined&&typeof driver.compensate!=='function')fail('PACT_PROVIDER_DRIVER_INVALID_COMPENSATE');
  if(driver.acquireFence!==undefined&&typeof driver.acquireFence!=='function')fail('PACT_PROVIDER_DRIVER_INVALID_FENCE');
  return Object.freeze({...driver});
}

export const PACT_PROVIDER_DRIVER_METHODS=REQUIRED_METHODS;
