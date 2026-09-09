import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createJiti} from '/home/timmypai/.pi/agent/npm/node_modules/jiti/lib/jiti.mjs';
import {Agent} from '/home/timmypai/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js';
const installed='/home/timmypai/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent';
const jiti=createJiti(import.meta.url,{moduleCache:false,alias:{'@earendil-works/pi-agent-core':installed+'/node_modules/@earendil-works/pi-agent-core/dist/index.js','@earendil-works/pi-ai/compat':installed+'/node_modules/@earendil-works/pi-ai/dist/compat.js','@earendil-works/pi-ai':installed+'/node_modules/@earendil-works/pi-ai/dist/index.js','@earendil-works/pi-coding-agent':installed+'/dist/index.js'}});
const base='/home/timmypai/.pi/agent/npm/node_modules/pi-subagents/src/runs/';
const runtimePath=base+'shared/subagent-prompt-runtime.ts';
const {registerSteeringInbox}=process.argv[2] ? await jiti.evalModule(readFileSync(process.argv[2],'utf8'),{filename:runtimePath,async:true}) : await jiti.import(runtimePath);
const env=await jiti.import(base+'shared/pi-args.ts');
const {STRUCTURED_OUTPUT_CAPTURE_ENV}=await jiti.import(base+'shared/structured-output.ts');
const {writeSteerRequestToDir,consumeSteerAckFromDir}=await jiti.import(base+'background/control-channel.ts');
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
async function scenario(structured,terminal,mode='steer',failed=false) {
 const root=mkdtempSync(join(tmpdir(),'steering-regression-')),handlers=new Map();
 const inbox=join(root,'inbox'),ack=join(root,'ack');
 process.env[env.SUBAGENT_STEER_INBOX_ENV]=inbox;process.env[env.SUBAGENT_STEER_ACK_DIR_ENV]=ack;process.env[env.SUBAGENT_CHILD_INDEX_ENV]='0';
 if(structured)process.env[STRUCTURED_OUTPUT_CAPTURE_ENV]=join(root,'report');else delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
 let calls=0;let toolRuns=0;let delivered=0;
 const emit=async(type,event={})=>{for(const h of handlers.get(type)??[])await h({...event,type});};
 const agent=new Agent({streamFn:()=>{
  calls++;
  if(calls===1)writeSteerRequestToDir(inbox,{type:'steer',id:'guidance',ts:Date.now(),message:'Finalize',mode});
  const message={role:'assistant',api:'fake',provider:'fake',model:'fake',usage,timestamp:Date.now(),stopReason:calls===1?'toolUse':'stop',content:calls===1?[{type:'toolCall',id:'capture',name:'structured_output',arguments:{}}]:[{type:'text',text:'done'}]};
  return{async *[Symbol.asyncIterator](){yield{type:'done',message};},result:async()=>message};
 },initialState:{tools:[{name:'structured_output',label:'capture',description:'capture',parameters:{type:'object',properties:{}},execute:async()=>{toolRuns++;if(failed)throw new Error('invalid report');return{content:[{type:'text',text:'captured'}],terminate:terminal};}}]}});
 const pi={on:(type,h)=>handlers.set(type,[...(handlers.get(type)??[]),h]),sendUserMessage:(text,options)=>{
  delivered++;void emit('input',{source:'extension',text,streamingBehavior:options?.deliverAs});
  const msg={role:'user',content:[{type:'text',text}],timestamp:Date.now()};
  if(options?.deliverAs==='followUp')agent.followUp(msg);else agent.steer(msg);
 }};
 registerSteeringInbox(pi,{platform:'win32',timers:{setInterval:()=>({unref(){}}),clearInterval:()=>{}}});
 agent.subscribe(e=>emit(e.type,e));
 try {
  await emit('session_start');await agent.prompt('test');
  let result,next;while((next=consumeSteerAckFromDir(ack,'guidance')))result=next;
  assert.equal(toolRuns,1);
  if(structured&&terminal&&!failed){assert.equal(calls,1);assert.equal(delivered,0);assert.equal(result.state,'failed');assert.match(result.message,/already captured/);
   writeSteerRequestToDir(inbox,{type:'steer',id:'late',ts:Date.now(),message:'Finalize again'});await emit('message_end');assert.equal(delivered,0);assert.equal(consumeSteerAckFromDir(ack,'late').state,'failed');
  }
  else {assert.equal(calls,2);assert.equal(delivered,1);}
 } finally {await emit('session_shutdown');rmSync(root,{recursive:true,force:true});}
}
for(const mode of ['steer','follow_up','auto'])await scenario(true,true,mode);
await scenario(true,false);await scenario(false,true);await scenario(true,true,'steer',true);
console.log('PASS actual runtime + Agent: terminal blocks stale steer/follow_up/auto; nonterminal and ordinary steering remain functional. Zero model/network.');
