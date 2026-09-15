import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const build=await readFile(new URL('../scripts/build.mjs',import.meta.url),'utf8');
const verify=await readFile(new URL('../scripts/verify-prebuilt.mjs',import.meta.url),'utf8');

test('syntax gate recursively checks provider source instead of only src root glob',()=>{
  assert.match(packageJson.scripts.check,/check-syntax\.mjs/);
});

test('release SDK ships provider contract, assurance, policy and built-in drivers',()=>{
  for(const file of ['provider-driver.js','provider-assurance.js','provider-policy.js'])assert.match(build,new RegExp(`['\"]${file.replace('.','\\.')}['\"]`));
  assert.match(build,/src['"`],\s*['"`]providers|src\/providers|providersDir/);
  for(const file of ['etag-json.js','kubernetes-resource.js','idempotent-command.js'])assert.match(build,new RegExp(file.replace('.','\\.')));
});

test('prebuilt verifier treats organizational provider runtime as required release content',()=>{
  for(const file of ['sdk/provider-assurance.js','sdk/provider-policy.js','sdk/providers/etag-json.js','sdk/providers/kubernetes-resource.js','sdk/providers/idempotent-command.js'])assert.match(verify,new RegExp(file.replace(/[./-]/g,'\\$&')));
});
