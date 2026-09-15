import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const build=await readFile(new URL('../scripts/build.mjs',import.meta.url),'utf8');
const verify=await readFile(new URL('../scripts/verify-prebuilt.mjs',import.meta.url),'utf8');

const required=[
  'sdk/provider-driver.js',
  'sdk/provider-assurance.js',
  'sdk/provider-policy.js',
  'sdk/provider-qualification.js',
  'sdk/providers/etag-json.js',
  'sdk/providers/kubernetes-resource.js',
  'sdk/providers/idempotent-command.js',
  'sdk/providers/versioned-command.js'
];

test('release builder ships every organizational provider module',()=>{
  for(const path of required){
    const file=path.replace(/^sdk\//,'');
    const basename=file.replace(/^providers\//,'');
    assert.match(build,new RegExp(basename.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),path);
  }
});

test('prebuilt verifier requires hashes for every organizational provider module',()=>{
  for(const path of required)assert.match(verify,new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),path);
});
