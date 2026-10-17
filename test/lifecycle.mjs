import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, settled, stream } from './security-helpers.mjs';

test('steering and follow-up survive the SDK upgrade with their full conversation context', async t=>{
  let release;
  let calls=0;
  const f=await fixture(t,{handle(request,res){
    calls++;
    if(calls===1){release=()=>stream(res,request.model,'FIRST_TURN');return;}
    stream(res,request.model,'NEXT_TURN');
  }});
  await f.call('init');
  const s=await f.call('spawn',{model:'test/one',prompt:'ORIGINAL_CONTEXT_718b',tools:[]});
  const deadline=Date.now()+5000;
  while(!release && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  assert.ok(release,'first provider request must arrive');
  await f.call('steer',{sessionId:s.sessionId,message:'STEERING_CONTEXT_5a18'});
  release();
  assert.equal((await settled(f.call,s.sessionId)).state,'done');
  assert.ok(JSON.stringify(f.requests[1]).includes('ORIGINAL_CONTEXT_718b'));
  assert.ok(JSON.stringify(f.requests[1]).includes('STEERING_CONTEXT_5a18'));
  await f.call('follow_up',{sessionId:s.sessionId,prompt:'FOLLOWUP_CONTEXT_b017'});
  assert.equal((await settled(f.call,s.sessionId)).state,'done');
  const last=JSON.stringify(f.requests.at(-1));
  assert.ok(last.includes('ORIGINAL_CONTEXT_718b'));assert.ok(last.includes('STEERING_CONTEXT_5a18'));assert.ok(last.includes('FOLLOWUP_CONTEXT_b017'));
});
