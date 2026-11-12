#!/usr/bin/env node

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { collect, shares, label } = require('../scripts/token-usage');

test('dedupes repeated message ids, folds subagents into the session, applies --days', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-'));
  const proj = path.join(root, '-home-me-app');
  fs.mkdirSync(path.join(proj, 's1', 'subagents'), { recursive: true });
  const usage = (o) => ({ input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: o });
  const now = new Date().toISOString();
  const lines = (...xs) => xs.map((x) => JSON.stringify(x)).join('\n') + '\n{broken';
  fs.writeFileSync(path.join(proj, 's1.jsonl'), lines(
    { type: 'user', timestamp: now, message: { content: '<command-name>/clear' } },
    { type: 'user', timestamp: now, message: { content: [{ type: 'text', text: '로그인 버그 고쳐줘' }] } },
    { type: 'assistant', timestamp: now, message: { id: 'a', usage: usage(50) } },
    { type: 'assistant', timestamp: now, message: { id: 'a', usage: usage(50) } }, // same response, second block
    { type: 'assistant', timestamp: '2000-01-01T00:00:00Z', message: { id: 'old', usage: usage(999) } },
  ));
  fs.writeFileSync(path.join(proj, 's1', 'subagents', 'agent-1.jsonl'), lines(
    { type: 'user', timestamp: now, isSidechain: true, message: { content: 'sub prompt' } },
    { type: 'assistant', timestamp: now, message: { id: 'b', usage: usage(20) } },
  ));

  const [s] = collect(root, Date.now() - 864e5);
  assert.equal(s.prompt, '로그인 버그 고쳐줘');
  assert.deepEqual([s.input, s.write, s.cacheRead, s.output], [20, 200, 2000, 70]);

  // 20*1 + 200*1.25 = 270 read, 2000*0.1 = 200 resent, 70*5 = 350 write
  const sh = shares(s);
  assert.equal(Math.round(sh.units), 820);
  assert.equal(label(sh), '코드·답변 작성형');
  assert.equal(collect(root).find((x) => x.output).output, 1069); // no --days: old entry counted

  // a single project folder as root: same session, subagents still folded in
  const [p] = collect(proj, Date.now() - 864e5);
  assert.equal(p.project, '-home-me-app');
  assert.equal(p.output, 70);
});
