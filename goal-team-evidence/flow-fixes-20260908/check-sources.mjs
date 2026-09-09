import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const {files}=JSON.parse(readFileSync(new URL('manifest.json',import.meta.url),'utf8'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
for(const f of files){assert.equal(hash(f.path),f.postSha256,f.path);assert.equal(hash(f.before),f.preSha256,f.before);assert.equal(hash(f.after),f.postSha256,f.after);}
console.log('PASS exact installed/preimage/postimage hashes for '+files.length+' changed files');
