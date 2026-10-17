// Explicit opt-in live smoke test. Not part of test:ci: this consumes provider usage.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const executable=join(process.cwd(),'dist/index.js');
const root=await mkdtemp(join(tmpdir(),'pi-delegate-live-'));
await writeFile(join(root,'facts.txt'),'demo-value=7319\n');
const models=['opencode-go/deepseek-v4.1-flash','commandcode/deepseek/deepseek-v4.1-flash'];
const results=[];
try {
 for(const model of models){
  const started=Date.now();
  const client=new Client({name:'pi-delegate-live-smoke',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[executable],cwd:root,
   env:{PATH:process.env.PATH,HOME:homedir(),PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent'),PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_DELEGATE_ROOT:root,PI_DELEGATE_MODEL:model,PI_DELEGATE_STATE_DIR:join(root,'state')}});
  const raw=(name,args={})=>client.callTool({name,arguments:args},undefined,{timeout:90000});
  const call=async(name,args={})=>{const r=await raw(name,args);assert.ok(!r.isError,r.content?.[0]?.text);return JSON.parse(r.content[0].text);};
  try {
   await client.connect(transport);const info=await call('init');assert.equal(info.pi.ok,true);
   const blocked=await raw('spawn',{prompt:'Do nothing',tools:['bash']});assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/blocked/);
   const outside=await raw('spawn',{cwd:tmpdir(),prompt:'Do nothing',tools:[]});assert.equal(outside.isError,true);assert.match(outside.content[0].text,/WORKSPACE_DENIED/);
   const r=await call('run',{id:'live-read',prompt:'Use the read tool to read facts.txt in this disposable test project. Return exactly VALUE_ followed by the demo-value from that file. Do not read other files.',tools:['read']});
   assert.equal(r.state,'done',r.error);assert.equal(r.model,model);assert.equal(r.lastText.trim(),'VALUE_7319');assert.deepEqual(r.activeTools,['read']);assert.ok(r.toolCalls.some(c=>c.name==='read'&&c.state==='ok'));
   await call('follow_up',{sessionId:r.sessionId,prompt:'Recall the demo-value from the previous turn. Reply exactly VALUE_ followed by that number, without reading files again.'});
   let final;const deadline=Date.now()+90000;
   while(Date.now()<deadline){final=await call('status',{sessionId:r.sessionId});if(!['starting','running'].includes(final.state))break;await new Promise(r=>setTimeout(r,500));}
   assert.equal(final?.state,'done',final?.error);assert.equal(final.lastText.trim(),'VALUE_7319');
   assert.equal(final.toolCalls.length,r.toolCalls.length,'Follow-up must use retained context without another tool call');
   const result={model,read:true,followUp:true,deniedShell:true,deniedOutsideCwd:true,seconds:Math.round((Date.now()-started)/100)/10};
   results.push(result);console.log(JSON.stringify(result));
  }finally{await client.close();}
 }
 if(process.env.PI_DELEGATE_LIVE_RESULTS)await writeFile(process.env.PI_DELEGATE_LIVE_RESULTS,JSON.stringify(results,null,2)+'\n');
}finally{await rm(root,{recursive:true,force:true});}
