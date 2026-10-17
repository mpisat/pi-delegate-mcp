import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'pi-delegate-security-'));
  const root = join(base, 'project');
  const agentDir = join(base, 'agent');
  await mkdir(root); await mkdir(agentDir);
  const requests = [];
  const sockets = new Set();
  const http = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body); requests.push(request);
      if (options.handle) return options.handle(request, res);
      const user = [...request.messages].reverse().find(m => m.role === 'user')?.content;
      const task = typeof user === 'string' ? user : (user ?? []).map(part => part.text ?? '').join('\n');
      const previousTools = request.messages.slice(request.messages.findLastIndex(m => m.role === 'user') + 1).filter(m => m.role === 'tool');
      if (task.includes('HOLD')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': waiting\n\n'); return; }
      let call;
      try { call = JSON.parse(task); } catch {}
      if (call?.tool && previousTools.length === 0) return stream(res, request.model, undefined, call);
      stream(res, request.model, previousTools.at(-1)?.content ?? 'OK');
    } catch (err) { res.writeHead(500); res.end(String(err)); }
  });
  http.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const settings = { defaultProvider: 'test', defaultModel: 'one', defaultThinkingLevel: 'off', ...options.settings };
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify(settings));
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: 'openai-completions', apiKey: 'synthetic-key',
    models: ['one', 'two'].map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  const client = new Client({ name: 'security-tests', version: '1' });
  const env = { PATH: process.env.PATH + delimiter + (process.env.PI_TEST_TOOLS_DIR ?? join(homedir(), '.pi', 'agent', 'bin')), HOME: base, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_CODING_AGENT_DIR: agentDir,
    PI_DELEGATE_STATE_DIR: join(base, 'state'), PI_DELEGATE_ROOT: root, ...options.env };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/index.js')], cwd: root, env });
  const raw = (name, args = {}, callOptions = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 15000, ...callOptions });
  const call = async (name, args = {}) => {
    const r = await raw(name, args); assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text);
  };
  t.after(async () => { await client.close(); for (const s of sockets) s.destroy(); await new Promise(r => http.close(r)); await rm(base, { recursive: true, force: true }); });
  await client.connect(transport);
  return { base, root, agentDir, requests, client, transport, env, raw, call };
}

export function stream(res, model, text, call) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (call) { emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'tool-1', type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } }] }); emit({}, 'tool_calls'); }
  else { emit({ role: 'assistant', content: typeof text === 'string' ? text : JSON.stringify(text) }); emit({}, 'stop'); }
  res.end('data: [DONE]\n\n');
}

export async function settled(call, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await call('status', { sessionId: id, verbose: true });
    if (!['starting', 'running'].includes(state.state)) return state;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Delegate did not settle before test deadline');
}
