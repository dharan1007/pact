#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { summarizeProviderQualificationCorpus, assertProductionQualified, REQUIRED_PROVIDER_FAMILIES } from '../src/provider-qualification-report.js';

const fail=code=>{throw new Error(code)};
const raw=process.env.PACT_PROVIDER_QUALIFICATION_CONFIG;
if(typeof raw!=='string'||!raw.trim())fail('PACT_PROVIDER_QUALIFICATION_CONFIG_REQUIRED');
let config;try{config=JSON.parse(raw)}catch{fail('PACT_PROVIDER_QUALIFICATION_CONFIG_INVALID_JSON')}
if(!config||typeof config!=='object'||Array.isArray(config))fail('PACT_PROVIDER_QUALIFICATION_CONFIG_INVALID');
const runs=Number(process.env.PACT_PROVIDER_QUALIFICATION_RUNS??500);
if(!Number.isSafeInteger(runs)||runs<500||runs>5000)fail('PACT_PROVIDER_QUALIFICATION_RUNS_INVALID');
const releaseSha=String(process.env.PACT_SOURCE_COMMIT??'').trim().toLowerCase();
if(!/^[a-f0-9]{40}$/.test(releaseSha)||/^0{40}$/.test(releaseSha))fail('PACT_PROVIDER_QUALIFICATION_RELEASE_SHA_INVALID');
await mkdir('artifacts/provider-qualification',{recursive:true});

const field=(entry,name,{required=true,defaultValue=''}={})=>{const value=entry?.[name];if((value==null||String(value).trim()==='')&&required)fail(`PACT_PROVIDER_QUALIFICATION_CONFIG_FIELD_REQUIRED:${name}`);return value==null||String(value).trim()===''?defaultValue:String(value).trim()};
function envFor(family,entry){
  if(!entry||typeof entry!=='object'||Array.isArray(entry))fail(`PACT_PROVIDER_QUALIFICATION_FAMILY_CONFIG_REQUIRED:${family}`);
  return{
    PACT_SOURCE_COMMIT:releaseSha,
    PACT_QUAL_FAMILY:family,
    PACT_QUAL_TARGET_URL:field(entry,'targetUrl'),
    PACT_QUAL_CONTROL_URL:field(entry,'controlUrl'),
    PACT_QUAL_TARGET_ID:field(entry,'targetId'),
    PACT_QUAL_TARGET_TOKEN:field(entry,'targetToken',{required:false}),
    PACT_QUAL_CONTROL_TOKEN:field(entry,'controlToken',{required:false}),
    PACT_QUAL_RESOURCE_PATH:field(entry,'resourcePath',{required:false,defaultValue:'/resource'}),
    PACT_QUAL_COMMAND_PATH:field(entry,'commandPath',{required:false,defaultValue:'/command'}),
    PACT_QUAL_OBSERVE_PATH:field(entry,'observePath',{required:false,defaultValue:'/state'}),
    PACT_QUAL_EXPECTED_REVISION_HEADER:field(entry,'expectedRevisionHeader',{required:false,defaultValue:'if-match'}),
    PACT_QUAL_REMOTE_FENCING:String(entry.remoteFencing===true)
  };
}
async function runFamily(family,entry){
  const safe=family.replace(/[^a-z0-9-]/gi,'_');
  const output=`artifacts/provider-qualification/${safe}.json`;
  const child=spawn(process.execPath,['scripts/qualify-provider.mjs','scripts/qualification/remote-provider.mjs',output,String(runs)],{env:{...process.env,...envFor(family,entry)},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk});child.stderr.on('data',chunk=>{stderr+=chunk});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
  if(code!==0){const digest=createHash('sha256').update(stderr).digest('hex');console.error(`PACT_PROVIDER_QUALIFICATION_FAMILY_FAILED:${family}:stderr-sha256=${digest}`);fail(`PACT_PROVIDER_QUALIFICATION_FAMILY_FAILED:${family}`)}
  const parsed=JSON.parse(await readFile(output,'utf8'));if(!Array.isArray(parsed)||!parsed.length)fail(`PACT_PROVIDER_QUALIFICATION_EMPTY_FAMILY:${family}`);
  if(parsed.some(row=>row.driverFamily!==family))fail(`PACT_PROVIDER_QUALIFICATION_FAMILY_IDENTITY_MISMATCH:${family}`);
  process.stdout.write(stdout.trim()?`${stdout.trim()}\n`:'');return parsed;
}

const transactions=[];
for(const family of REQUIRED_PROVIDER_FAMILIES)transactions.push(...await runFamily(family,config[family]));
const summary=summarizeProviderQualificationCorpus(transactions);
assertProductionQualified(summary);
await writeFile('artifacts/provider-qualification/transactions.json',`${JSON.stringify(transactions,null,2)}\n`,'utf8');
await writeFile('artifacts/provider-qualification/summary.json',`${JSON.stringify({...summary,releaseSha},null,2)}\n`,'utf8');
console.log(JSON.stringify({ok:true,releaseSha,transactionCount:summary.transactionCount,driverFamilies:summary.driverFamilies,p50LatencyMs:summary.p50LatencyMs,p95LatencyMs:summary.p95LatencyMs,p99LatencyMs:summary.p99LatencyMs,evidenceDigest:summary.evidenceDigest}));
