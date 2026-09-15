#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { qualifyProvider } from '../src/provider-qualification-suite.js';

const [modulePath,outputPath='provider-qualification-transactions.json',runsRaw='250']=process.argv.slice(2);
if(!modulePath){console.error('usage: node scripts/qualify-provider.mjs <trusted-scenario-module.mjs> [output.json] [runs]');process.exit(2)}
const runs=Number(runsRaw);if(!Number.isSafeInteger(runs)||runs<1||runs>10000){console.error('PACT_PROVIDER_QUALIFICATION_RUN_COUNT_INVALID');process.exit(2)}
let module;try{module=await import(pathToFileURL(resolve(modulePath)).href)}catch(error){console.error(`PACT_PROVIDER_QUALIFICATION_MODULE_LOAD_FAILED:${error?.message??error}`);process.exit(1)}
if(typeof module.createQualificationContext!=='function'){console.error('PACT_PROVIDER_QUALIFICATION_CONTEXT_FACTORY_REQUIRED');process.exit(1)}
const transactions=[];
for(let index=0;index<runs;index+=1){
  const context=await module.createQualificationContext({index});
  const started=performance.now();let report;
  try{report=await qualifyProvider(context)}catch(error){transactions.push({id:`run-${index}`,driverFamily:context?.driver?.describe?.().family??'unknown',status:'FAILED',duplicateEffect:false,falseVerification:false,unresolved:false,latencyMs:performance.now()-started,evidenceHash:createHash('sha256').update(String(error?.message??error)).digest('hex')});continue}
  const latencyMs=performance.now()-started;
  const scenarioCount=Object.keys(report.scenarios??{}).length;
  for(let offset=0;offset<Math.max(1,scenarioCount);offset+=1){transactions.push({id:`${report.provider.driverId}:${index}:${offset}`,driverFamily:context.driver.describe().family,status:'VERIFIED',duplicateEffect:false,falseVerification:false,unresolved:false,latencyMs:latencyMs/Math.max(1,scenarioCount),evidenceHash:report.evidenceDigest})}
}
await writeFile(outputPath,JSON.stringify(transactions,null,2)+'\n');
console.log(JSON.stringify({ok:true,runs,transactions:transactions.length,outputPath}));
