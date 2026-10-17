import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, settled } from './security-helpers.mjs';

async function eventually(check) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) { if(await check()) return; await new Promise(r=>setTimeout(r,20)); }
  assert.fail('Expected condition did not become true before deadline');
}

test('cancelling blocking run aborts its underlying model request', {timeout:15000}, async t=>{
  const f=await fixture(t); await f.call('init');
  const controller=new AbortController();
  const task=f.raw('run',{id:'cancel-run',model:'test/one',prompt:'HOLD',tools:[]},{signal:controller.signal});
  const rejected=assert.rejects(task,e=>e.code===-32001 && /aborted/i.test(e.message));
  await eventually(()=>f.requests.length===1);controller.abort();await rejected;
  await eventually(async()=> (await f.call('status',{sessionId:'cancel-run'})).state==='aborted');
  const next=await f.call('run',{model:'test/one',prompt:'OK',tools:[]});assert.equal(next.state,'done');assert.equal(next.lastText,'OK');
});

test('cancelling during extension startup prevents any provider request', {timeout:15000}, async t=>{
  const f=await fixture(t,{env:{PI_DELEGATE_ALLOW_EXTENSIONS:'1'}});const dir=join(f.agentDir,'extensions');await mkdir(dir);
  const marker=join(f.base,'startup-marker');
  await writeFile(join(dir,'slow.js'),`import {writeFileSync} from 'node:fs';export default async()=>{writeFileSync(${JSON.stringify(marker)},'STARTED');await new Promise(r=>setTimeout(r,400));}`);
  await f.call('init');const controller=new AbortController();
  const task=f.raw('run',{id:'cancel-start',model:'test/one',prompt:'OK',tools:[],extensions:true},{signal:controller.signal});
  const rejected=assert.rejects(task,e=>e.code===-32001 && /aborted/i.test(e.message));
  await eventually(async()=>{try{await access(marker);return true;}catch{return false;}});
  controller.abort();await rejected;
  await new Promise(r=>setTimeout(r,500));
  const state=await settled(f.call,'cancel-start');assert.equal(state.state,'aborted');assert.equal(f.requests.length,0);
});

test('successful spawn and follow_up remain independent of completed request signals',async t=>{
  const f=await fixture(t);await f.call('init');
  const s=await f.call('spawn',{id:'independent',model:'test/one',prompt:'OK',tools:[]});
  assert.equal((await settled(f.call,s.sessionId)).state,'done');
  await f.call('follow_up',{sessionId:s.sessionId,prompt:'OK'});
  assert.equal((await settled(f.call,s.sessionId)).state,'done');
  const held=await f.call('spawn',{id:'explicit-abort',model:'test/one',prompt:'HOLD',tools:[]});
  await eventually(()=>f.requests.length===3);
  assert.equal((await f.call('status',{sessionId:held.sessionId})).state,'running');
  await f.call('abort',{sessionId:held.sessionId});assert.equal((await settled(f.call,held.sessionId)).state,'aborted');
});
