import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
test('overlay verifier accepts copied known stack and rejects a changed installed byte',()=>{
 const root=path.resolve(import.meta.dirname,'../../..');const temp=fs.mkdtempSync(path.join(os.tmpdir(),'team-overlay-'));
 const mapped=p=>{assert.ok(p.startsWith(root+path.sep));return path.join(temp,path.relative(root,p));};
 const copy=p=>{const dest=mapped(p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(p,dest);};
 try {
  for(const name of ['goal-team-hold-wake','goal-team-reliability','goal-team-delivery']){
   const dir=path.join(root,'teams/patches',name),file=path.join(dir,'manifest.json'),m=JSON.parse(fs.readFileSync(file));copy(file);
   const pkg=path.join(root,'npm/node_modules',m.package);copy(path.join(pkg,'package.json'));
   for(const row of [...m.files,...m.requiredFiles??[]])copy(path.join(pkg,row.path));
   for(const row of m.files){if(row.preimage)copy(path.join(dir,row.preimage));copy(path.join(dir,row.postimage));}
  }
  for(const name of ['flow-fixes-20260908','efficiency-20260908','usability-fixes-20260908','skills-ready-20260908','audit-fixes-20260908']){
   const file=path.join(root,'teams/goal-team-evidence',name,'manifest.json'),m=JSON.parse(fs.readFileSync(file));
   for(const row of m.files)for(const key of ['path','before','after'])if(row[key]){copy(row[key]);row[key]=mapped(row[key]);}
   fs.mkdirSync(path.dirname(mapped(file)),{recursive:true});fs.writeFileSync(mapped(file),JSON.stringify(m));
  }
  const script=mapped(path.join(import.meta.dirname,'check-installed.mjs'));
  const good=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.equal(good.status,0,good.stderr);
  fs.appendFileSync(mapped(path.join(root,'teams/goal-request.mjs')),'\n// fixture tamper\n');
  const bad=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.equal(bad.status,1);assert.match(bad.stderr,/installed source mismatch/);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
