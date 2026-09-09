// Read-only verification of known chronological overlays. Not an installer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../..');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const expected=new Map();let previous;
for(const name of ['goal-team-hold-wake','goal-team-reliability','goal-team-delivery']){
 const dir=path.join(root,'patches',name), manifest=json(path.join(dir,'manifest.json'));
 const pkg=path.resolve(root,'../npm/node_modules',manifest.package);
 assert.equal(json(path.join(pkg,'package.json')).version,manifest.version,'package version changed');
 if(manifest.requires) assert.equal(manifest.requires,previous,'patch dependency mismatch');
 for(const row of manifest.requiredFiles??[]){const file=path.join(pkg,row.path);if(expected.has(file))assert.equal(expected.get(file),row.sha256,'required layer mismatch '+file);expected.set(file,row.sha256);}
 for(const row of manifest.files){
  const file=path.join(pkg,row.path);
  if(row.preimage)assert.equal(hash(path.join(dir,row.preimage)),row.preSha256,'saved preimage changed');
  assert.equal(hash(path.join(dir,row.postimage)),row.postSha256,'saved postimage changed');
  if(expected.has(file))assert.equal(expected.get(file),row.preSha256,'layer continuity mismatch '+file);
  expected.set(file,row.postSha256);
 }
 previous=manifest.patchId;
}
for(const name of ['flow-fixes-20260908','efficiency-20260908','usability-fixes-20260908']){
 const manifest=json(path.join(root,'goal-team-evidence',name,'manifest.json'));
 for(const row of manifest.files){
  const pre=row.preSha256??row.beforeSha256??null, post=row.postSha256??row.afterSha256;
  if(row.before)assert.equal(hash(row.before),pre,'saved overlay preimage changed '+row.path);
  if(row.after)assert.equal(hash(row.after),post,'saved overlay postimage changed '+row.path);
  if(expected.has(row.path))assert.equal(expected.get(row.path),pre,'overlay continuity mismatch '+row.path);
  expected.set(row.path,post);
 }
}
for(const [file,sha] of expected)assert.equal(hash(file),sha,'installed source mismatch '+file);
console.log(JSON.stringify({status:'verified',files:expected.size,scope:'known base/delta/runtime/helper overlays only',limitations:['not a fresh-install or upgrade installer','legacy wrappers correctly reject superseded hashes; never bypass them']},null,2));
