import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(process.cwd(), 'dist/statusline/cli.js');
const esc = String.fromCharCode(27);
async function render(t, label, id = 'delegate-1') {
  const state = await mkdtemp(join(tmpdir(), 'pi-statusline-security-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  await writeFile(join(state, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, hostPid: process.pid, updatedAt: new Date().toISOString(),
    sessions: [{ id, label, state: 'running', turns: 2, questions: 0 }],
  }));
  return execFileSync(process.execPath, [cli], {
    env: { ...process.env, PI_DELEGATE_STATE_DIR: state, PI_DELEGATE_STATUSLINE_WRAP: '' },
    input: '{}', encoding: 'utf8',
  });
}
const plain = output => output.replace(/\u001b\[(?:0|2|31|32|33)m/g, '').replace(/\n$/, '');

test('statusline preserves plain labels and its own ANSI styles', async t => {
  const out = await render(t, 'Read source');
  assert.match(plain(out), /Read source·t2/);
  assert.ok(out.includes(`${esc}[2m`));
});

for (const [name, label, safe] of [
  ['C0 controls', 'A\u0000\t\r\n\u0007B', 'AB'],
  ['C1 controls', 'A\u0080\u0085\u008fB', 'AB'],
  ['OSC hyperlink', `${esc}]8;;https://invalid.test${esc}\\Read${esc}]8;;${esc}\\`, 'Read'],
  ['OSC clipboard', `${esc}]52;c;Y2FuYXJ5\u0007Safe`, 'Safe'],
  ['CSI styles and erase', `${esc}[31mRed${esc}[0m${esc}[2J`, 'Red'],
  ['C1 OSC', '\u009d52;c;Y2FuYXJ5\u009cSafe', 'Safe'],
]) {
  test(`statusline strips ${name} before truncating labels`, async t => {
    const out = plain(await render(t, label));
    assert.equal(out, `π ▸ ${safe}·t2`);
    assert.doesNotMatch(out, /[\u0000-\u001f\u007f-\u009f]/);
  });
}

test('statusline also sanitizes the fallback session id', async t => {
  assert.equal(plain(await render(t, '', `Id${esc}[2J\rSafe`)), 'π ▸ IdSafe·t2');
});
