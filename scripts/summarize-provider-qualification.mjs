#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { summarizeProviderQualificationCorpus, assertProductionQualified } from '../src/provider-qualification-report.js';

const [inputPath,outputPath,...flags]=process.argv.slice(2);
if(!inputPath){console.error('usage: node scripts/summarize-provider-qualification.mjs <transactions.json> [summary.json] [--require-production]');process.exit(2)}
let transactions;try{transactions=JSON.parse(await readFile(inputPath,'utf8'))}catch(error){console.error(`PACT_PROVIDER_CORPUS_READ_FAILED:${error?.message??error}`);process.exit(1)}
try{
  const summary=summarizeProviderQualificationCorpus(transactions);
  if(flags.includes('--require-production'))assertProductionQualified(summary);
  const encoded=JSON.stringify(summary,null,2)+'\n';
  if(outputPath)await writeFile(outputPath,encoded);else process.stdout.write(encoded);
}catch(error){console.error(error?.message??'PACT_PROVIDER_CORPUS_SUMMARY_FAILED');process.exit(1)}
