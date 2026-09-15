import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

async function collect(dir){
  const files=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())files.push(...await collect(full));
    else if(entry.isFile()&&(entry.name.endsWith('.js')||entry.name.endsWith('.mjs')))files.push(full);
  }
  return files;
}

function check(file){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--check',file],{stdio:'inherit'});
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(new Error(`PACT_SYNTAX_CHECK_FAILED:${file}`)));
  });
}

const roots=['src','scripts'];
const files=[];
for(const root of roots)files.push(...await collect(path.resolve(root)));
files.sort();
for(const file of files)await check(file);
console.log(`Syntax checked ${files.length} source files.`);
