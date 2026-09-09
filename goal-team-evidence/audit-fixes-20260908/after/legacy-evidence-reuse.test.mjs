import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {runCheck,verifyCheck} from '../../host-evidence.mjs';
test('existing host verification reuses unaffected evidence without executing the check again',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'team-reuse-'));
 try {
   fs.writeFileSync(path.join(cwd,'domain.txt'),'domain-v1');
   fs.writeFileSync(path.join(cwd,'style.txt'),'style-v1');
   const check={cwd,sourcePaths:['domain.txt'],argv:[process.execPath,'-e',"require('node:fs').appendFileSync('executions.txt','run\\n')"],timeoutMs:1000};
   const receipt=path.join(cwd,'receipt.json');
   assert.equal(runCheck(check,receipt).status,'verified');
   fs.writeFileSync(path.join(cwd,'style.txt'),'style-v2');
   assert.equal(verifyCheck(check,receipt).status,'verified');
   assert.equal(fs.readFileSync(path.join(cwd,'executions.txt'),'utf8'),'run\n');
   fs.writeFileSync(path.join(cwd,'domain.txt'),'domain-v2');
   assert.throws(()=>verifyCheck(check,receipt),/source changed/);
   assert.equal(fs.readFileSync(path.join(cwd,'executions.txt'),'utf8'),'run\n');
 } finally {fs.rmSync(cwd,{recursive:true,force:true});}
});
