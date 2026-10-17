import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './security-helpers.mjs';

const strict = { PI_DELEGATE_STRICT_SCOPE: '1' };

test('omitted out-of-scope default is refused before any provider request', async t => {
  const f = await fixture(t, { settings: { enabledModels: ['test/two'] }, env: strict });
  await f.call('init');
  const result = await f.raw('run', { prompt: 'OK', tools: [] });
  assert.equal(result.isError, true, 'omitting model must not bypass enabledModels');
  assert.match(result.content[0].text, /Model test\/one is out of scope/);
  assert.equal(f.requests.length, 0);
});

test('omitted allowed default reports its concrete model', async t => {
  const f = await fixture(t, { settings: { enabledModels: ['test/one'] }, env: strict });
  await f.call('init');
  const result = await f.call('run', { prompt: 'OK', tools: [] });
  assert.equal(result.state, 'done');
  assert.equal(result.model, 'test/one');
  assert.equal(f.requests[0].model, 'one');
});

test('explicit models still pass or fail the strict scope gate', async t => {
  const f = await fixture(t, { settings: { enabledModels: ['test/two'] }, env: strict });
  await f.call('init');
  const allowed = await f.call('run', { prompt: 'OK', model: 'test/two', tools: [] });
  assert.equal(allowed.model, 'test/two');
  const before = f.requests.length;
  const denied = await f.raw('spawn', { prompt: 'OK', model: 'test/one', tools: [] });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /Model test\/one is out of scope/);
  assert.equal(f.requests.length, before);
});

test('project default overrides global model and is checked against project scope', async t => {
  const f = await fixture(t, { settings: { enabledModels: ['test/one'] }, env: strict });
  await mkdir(join(f.root, '.pi'));
  await writeFile(join(f.root, '.pi', 'settings.json'), JSON.stringify({ defaultModel: 'two', enabledModels: ['test/two'] }));
  await f.call('init');
  const result = await f.call('run', { prompt: 'OK', tools: [] });
  assert.equal(result.model, 'test/two');
  assert.equal(f.requests[0].model, 'two');
});

test('custom-provider bypass stays available without strict scope', async t => {
  const f = await fixture(t, { settings: { enabledModels: ['test/two'] } });
  await f.call('init');
  const result = await f.call('run', { prompt: 'OK', tools: [] });
  assert.equal(result.model, 'test/one');
});

test('unknown configured default is rejected instead of falling back', async t => {
  const f = await fixture(t, { settings: { defaultModel: 'missing' } });
  await f.call('init');
  const result = await f.raw('run', { prompt: 'OK', tools: [] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Model not found: test\/missing/);
  assert.equal(f.requests.length, 0);
});

test('missing defaults resolve an authenticated model before strict scope validation', async t => {
  const f = await fixture(t, { settings: { defaultProvider: null, defaultModel: null, enabledModels: ['test/two'] }, env: strict });
  await f.call('init');
  const result = await f.raw('run', { prompt: 'OK', tools: [] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Model test\/one is out of scope/);
  assert.equal(f.requests.length, 0);
});

for (const allowed of ['two', 'one']) {
  test(`missing defaults preserve Pi catalog order with scope allowing ${allowed}`, async t => {
    const f = await fixture(t, { settings: { defaultProvider: null, defaultModel: null, enabledModels: [`test/${allowed}`] }, env: strict });
    const path = join(f.agentDir, 'models.json');
    const catalog = JSON.parse(await readFile(path, 'utf8'));
    catalog.providers.test.models.reverse();
    await writeFile(path, JSON.stringify(catalog));
    await f.call('init');
    const result = await f.raw('run', { prompt: 'OK', tools: [] });
    if (allowed === 'two') {
      assert.ok(!result.isError, result.content[0].text);
      assert.equal(JSON.parse(result.content[0].text).model, 'test/two');
      assert.equal(f.requests[0].model, 'two');
    } else {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Model test\/two is out of scope/);
      assert.equal(f.requests.length, 0);
    }
  });
}

for (const tool of ['init', 'run']) {
  test(`${tool} refuses outward project-settings symlinks before reading defaults or scope`, async t => {
    const f = await fixture(t);
    if (tool !== 'init') await f.call('init');
    await mkdir(join(f.root, '.pi'));
    const outside = join(f.base, 'outside-settings.json');
    await writeFile(outside, JSON.stringify({ defaultProvider: 'test', defaultModel: 'outside-default', enabledModels: [] }));
    await symlink(outside, join(f.root, '.pi', 'settings.json'));
    const result = await f.raw(tool, tool === 'run' ? { prompt: 'OK', tools: [] } : {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /WORKSPACE_DENIED/);
    assert.doesNotMatch(result.content[0].text, /outside-default/);
    assert.equal(f.requests.length, 0);
  });
}
