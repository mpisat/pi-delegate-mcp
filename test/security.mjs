import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeFile, mkdir, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './security-helpers.mjs';

const canary = 'SYNTHETIC_OUTSIDE_SECRET_7e90c1';
for (const tool of ['read', 'grep', 'find', 'ls']) {
  test(`${tool} allows in-project paths and rejects traversal, absolute and symlink escapes`, { timeout: 30000 }, async t => {
    const f = await fixture(t); await writeFile(join(f.root, 'inside.txt'), 'SAFE_INSIDE');
    const outside = join(f.base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), canary);
    await symlink(outside, join(f.root, 'escape-dir')); await symlink(join(outside, 'secret.txt'), join(f.root, 'escape-file'));
    await f.call('init');
    const dirTool = ['find', 'ls'].includes(tool);
    const args = path => ({ path, ...(tool === 'grep' ? { pattern: 'SAFE|SYNTHETIC' } : tool === 'find' ? { pattern: '*' } : {}) });
    const run = path => f.call('run', { prompt: JSON.stringify({ tool, args: args(path) }), model: 'test/one' });
    const inside = await run(dirTool ? '.' : 'inside.txt');
    assert.ok(inside.toolCalls.some(c => c.name === tool && c.state === 'ok'), JSON.stringify(inside));
    for (const path of [dirTool ? '../outside' : '../outside/secret.txt', dirTool ? outside : join(outside, 'secret.txt'), dirTool ? 'escape-dir' : 'escape-file', 'escape-dir/secret.txt']) {
      await t.test(path, async () => {
      const before = f.requests.length;
      const result = await run(path);
      const denied = result.toolCalls.find(c => c.name === tool);
      const detail = await f.call('status', { sessionId: result.sessionId, verbose: true });
      assert.equal(denied?.state, 'error', `${tool} unexpectedly accepted ${path}`);
      assert.match(detail.toolCalls.find(c => c.name === tool)?.result ?? '', /WORKSPACE_DENIED/);
      assert.ok(!JSON.stringify(f.requests.slice(before)).includes(canary), `${tool} leaked outside content`);
      });
    }
  });
}

test('caller cannot change the server-owned workspace root via cwd or symlinks', async t => {
  const f = await fixture(t); await symlink(f.base, join(f.root, 'escape'));
  await f.call('init');
  const allowed = await f.call('run', { cwd: f.root, prompt: 'OK', tools: [] }); assert.equal(allowed.state, 'done');
  for (const cwd of [f.base, join(f.root, 'escape')]) {
    const r = await f.raw('spawn', { cwd, model: 'test/one', prompt: 'OK', tools: [] });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /WORKSPACE_DENIED/);
  }
});

test('default resource loading includes instructions without executing project settings', async t => {
  const f = await fixture(t); const pi = join(f.root, '.pi'); await mkdir(pi); await mkdir(join(pi, 'extensions'));
  const marker = join(f.base, 'executed');
  const extension = `import {writeFileSync} from 'node:fs'; export default () => writeFileSync(${JSON.stringify(marker)},'EXECUTED');`;
  await writeFile(join(pi, 'extensions', 'audit.js'), extension);
  await writeFile(join(pi, 'settings.json'), JSON.stringify({ extensions: ['./extensions/audit.js'] }));
  await writeFile(join(f.root, 'AGENTS.md'), 'PROJECT_INSTRUCTION_4a819c');
  await writeFile(join(f.agentDir, 'AGENTS.md'), 'GLOBAL_INSTRUCTION_b8f16e');
  await f.call('init');
  const result = await f.call('run', { prompt: 'OK', model: 'test/one', tools: [] });
  assert.equal(result.state, 'done');
  assert.ok(JSON.stringify(f.requests).includes('PROJECT_INSTRUCTION_4a819c'));
  assert.ok(JSON.stringify(f.requests).includes('GLOBAL_INSTRUCTION_b8f16e'));
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('symlinked context outside the workspace is never included', async t => {
  const f = await fixture(t); const secret = join(f.base, 'private.md'); await writeFile(secret, canary);
  await symlink(secret, join(f.root, 'AGENTS.md')); await f.call('init');
  await f.call('run', { prompt: 'OK', model: 'test/one', tools: [] });
  assert.ok(!JSON.stringify(f.requests).includes(canary));
});

test('trusted global instructions may link to an administrator-selected shared file', async t => {
  const f = await fixture(t);
  const shared = join(f.base, 'shared-instructions.md');
  await writeFile(shared, 'TRUSTED_SHARED_INSTRUCTION_21cb7d');
  await symlink(shared, join(f.agentDir, 'AGENTS.md'));
  await f.call('init');
  await f.call('run', { prompt: 'OK', model: 'test/one', tools: [] });
  assert.ok(JSON.stringify(f.requests).includes('TRUSTED_SHARED_INSTRUCTION_21cb7d'));
});

test('extensions need server opt-in even when the request has no tools', async t => {
  const f = await fixture(t); const dir = join(f.root, '.pi', 'extensions'); await mkdir(dir, { recursive: true });
  const marker = join(f.base, 'extension-marker');
  await writeFile(join(dir, 'audit.js'), `import {writeFileSync} from 'node:fs'; export default () => writeFileSync(${JSON.stringify(marker)},'EXECUTED');`);
  await f.call('init');
  const denied = await f.raw('spawn', { prompt: 'OK', model: 'test/one', extensions: true, tools: [] });
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /EXTENSIONS_DENIED/);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

test('privileged extensions remain available with an explicit server opt-in', async t => {
  const f = await fixture(t, { env: { PI_DELEGATE_ALLOW_EXTENSIONS: '1' } });
  const dir = join(f.agentDir, 'extensions'); await mkdir(dir);
  const marker = join(f.base, 'trusted-extension-marker');
  await writeFile(join(dir, 'audit.js'), `import {writeFileSync} from 'node:fs'; export default () => writeFileSync(${JSON.stringify(marker)},'EXECUTED');`);
  await f.call('init'); await f.call('run', { prompt: 'OK', model: 'test/one', extensions: true, tools: [] });
  await access(marker);
});

for (const tool of ['init', 'models']) {
 test(`${tool} rejects cwd outside root before reading scope`, async t => {
   const f=await fixture(t); if(tool!=='init') await f.call('init');
   const r=await f.raw(tool,{cwd:f.base});assert.equal(r.isError,true);assert.match(r.content[0].text,/WORKSPACE_DENIED/);
 });
}
for(const denied of ['cwd','extensions']) {
 test(`batch validates ${denied} before any delegate starts`,async t=>{
   const f=await fixture(t);await f.call('init');
   const bad=denied==='cwd'?{cwd:f.base}:{extensions:true};
   const r=await f.raw('spawn_batch',{model:'test/one',tasks:[{prompt:'OK',tools:[]},{prompt:'OK',tools:[],...bad}]});
   assert.equal(r.isError,true);assert.match(r.content[0].text,denied==='cwd'?/WORKSPACE_DENIED/:/EXTENSIONS_DENIED/);
   assert.equal((await f.call('sessions')).count,0);assert.equal(f.requests.length,0);
 });
}

test('searches from an allowed directory never follow outward descendant symlinks', async t=>{
  const f=await fixture(t);const outside=join(f.base,'outside');await mkdir(outside);
  await writeFile(join(outside,'OUTSIDE_SECRET_FILENAME.txt'),canary);
  await writeFile(join(f.root,'inside.txt'),'SAFE_INSIDE');
  await symlink(outside,join(f.root,'escape-dir'));
  await symlink(join(outside,'OUTSIDE_SECRET_FILENAME.txt'),join(f.root,'escape-file'));
  await f.call('init');
  for(const tool of ['grep','find']){
    const args=tool==='grep'?{pattern:'SYNTHETIC|SAFE',path:'.'}:{pattern:'*',path:'.'};
    const before=f.requests.length;
    const r=await f.call('run',{prompt:JSON.stringify({tool,args}),model:'test/one'});
    assert.equal(r.toolCalls[0].state,'ok');
    assert.ok(!JSON.stringify(f.requests.slice(before)).includes(canary));
    assert.ok(!r.lastText.includes('OUTSIDE_SECRET_FILENAME'));
  }
});

for(const tool of ['read','grep','find','ls']) {
 test(`${tool} uses exactly the checked Unicode path without a second SDK normalization`,async t=>{
   const f=await fixture(t);const outside=join(f.base,'outside');await mkdir(outside);
   await writeFile(join(outside,'secret.txt'),canary);
   await writeFile(join(outside,'OUTSIDE_UNICODE_ONLY.txt'),canary);
   const safe=join(f.root,'unicode\u00a0space');await mkdir(safe);await writeFile(join(safe,'secret.txt'),'SAFE_UNICODE_FILE');
   await symlink(outside,join(f.root,'unicode space'));
   await f.call('init');
   const path=['find','ls'].includes(tool)?safe:join(safe,'secret.txt');
   const args={path,...(tool==='grep'?{pattern:'SAFE|SYNTHETIC'}:tool==='find'?{pattern:'*'}:{})};
   const before=f.requests.length;
   const r=await f.call('run',{prompt:JSON.stringify({tool,args}),model:'test/one'});
   assert.equal(r.toolCalls[0].state,'ok');
   assert.ok(!JSON.stringify(f.requests.slice(before)).includes(canary),'Unicode normalization leaked outside content');
   assert.ok(!r.lastText.includes('OUTSIDE_UNICODE_ONLY.txt'));
   if(['read','grep'].includes(tool))assert.ok(r.lastText.includes('SAFE_UNICODE_FILE'));
 });
}

test('privileged tool selection is still a literal list, never SDK modifiers or wildcards',async t=>{
 const f=await fixture(t,{env:{PI_DELEGATE_ALLOW_WRITE:'1'}});await f.call('init');
 const allowed=await f.call('run',{prompt:'OK',model:'test/one',tools:['read']});assert.deepEqual(allowed.activeTools,['read']);
 for(const tools of [['+read'],['-write'],['*'],['read','mcp__*']]){
  const before=f.requests.length;
  const r=await f.raw('spawn',{prompt:'OK',model:'test/one',tools});
  assert.equal(r.isError,true);assert.match(r.content[0].text,/TOOL_SELECTION_DENIED/);assert.equal(f.requests.length,before);
 }
});

test('project settings must be a regular file, never a blocking FIFO', {skip:process.platform==='win32'}, async t=>{
 const f=await fixture(t);await f.call('init');await mkdir(join(f.root,'.pi'));
 execFileSync('mkfifo',[join(f.root,'.pi','settings.json')]);
 const r=await f.raw('models',{}, {timeout:800}).catch(error=>assert.fail(`Settings read blocked instead of rejecting a non-regular file: ${error.code}`));
 assert.equal(r.isError,true);assert.match(r.content[0].text,/WORKSPACE_DENIED/);
});
