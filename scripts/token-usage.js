#!/usr/bin/env node
// Claude Code 세션 기록(~/.claude/projects)에서 토큰을 집계해, 작업이 읽기형인지 코드 작성형인지 보여준다.
// 사용법: node scripts/token-usage.js [기록 폴더] [--days N]

const fs = require('fs');
const os = require('os');
const path = require('path');

// 입력 단가 대비 비율(Anthropic 공통): 캐시 쓰기 5분 1.25배·1시간 2배, 캐시 읽기 0.1배, 출력 5배.
// shortcut: 모델별 실제 단가가 아닌 비율이라 금액은 안 나온다, 금액이 필요하면 모델별 단가표를 붙일 것.
const W = { input: 1, write5m: 1.25, write1h: 2, cacheRead: 0.1, output: 5 };

function jsonlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsonlFiles(p) : e.name.endsWith('.jsonl') ? [p] : [];
  });
}

function firstPrompt(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return '';
  const c = entry.message && entry.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b) => b.type === 'text') || {}).text || '' : '';
  return text.startsWith('<') ? '' : text.replace(/\s+/g, ' ').trim();
}

function collect(root, sinceMs = 0) {
  const sessions = new Map();
  for (const file of jsonlFiles(root)) {
    // <프로젝트>/<세션>.jsonl 과 <프로젝트>/<세션>/subagents/*.jsonl 을 같은 세션으로 묶는다.
    // 기록 폴더로 프로젝트 폴더 하나를 주면 <세션>.jsonl 이 바로 아래에 있다.
    const parts = path.relative(root, file).split(path.sep);
    const [project, sessionPart] = parts[0].endsWith('.jsonl') || parts[1] === 'subagents' ? [path.basename(root), parts[0]] : parts;
    const key = project + '/' + sessionPart.replace(/\.jsonl$/, '');
    const s = sessions.get(key) || { project, prompt: '', last: '', seen: new Set(), input: 0, write: 0, weightedWrite: 0, cacheRead: 0, output: 0 };
    sessions.set(key, s);
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      let e;
      try { e = JSON.parse(line); } catch { continue; } // 잘린 마지막 줄 등은 건너뜀
      if (!e || (e.timestamp && Date.parse(e.timestamp) < sinceMs)) continue;
      if (!s.prompt && !file.includes(path.sep + 'subagents' + path.sep)) s.prompt = firstPrompt(e);
      const m = e.message;
      const u = e.type === 'assistant' && m && m.usage;
      // 응답 하나가 블록마다 같은 usage로 여러 줄 기록되므로 message.id로 한 번만 센다.
      if (!u || s.seen.has(m.id)) continue;
      s.seen.add(m.id);
      const w1h = (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
      s.input += u.input_tokens || 0;
      s.write += u.cache_creation_input_tokens || 0;
      s.weightedWrite += ((u.cache_creation_input_tokens || 0) - w1h) * W.write5m + w1h * W.write1h;
      s.cacheRead += u.cache_read_input_tokens || 0;
      s.output += u.output_tokens || 0;
      if (e.timestamp > s.last) s.last = e.timestamp;
    }
  }
  return [...sessions.values()].filter((s) => s.seen.size);
}

function shares(s) {
  const read = s.input * W.input + s.weightedWrite;
  const resent = s.cacheRead * W.cacheRead;
  const write = s.output * W.output;
  const total = read + resent + write || 1;
  return { read: read / total, resent: resent / total, write: write / total, units: total };
}

function label(sh) {
  const top = Math.max(sh.read, sh.resent, sh.write);
  return top === sh.write ? '코드·답변 작성형' : top === sh.read ? '읽기형' : '재전송형(긴 대화)';
}

const pct = (x) => (x * 100).toFixed(0).padStart(3) + '%';
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n)).padStart(6);

function report(list) {
  const lines = ['날짜        읽기 재전송  작성 | 새입력  캐시읽기   출력 | 유형              | 첫 요청'];
  for (const s of list.sort((a, b) => b.last.localeCompare(a.last))) {
    const sh = shares(s);
    lines.push(`${s.last.slice(0, 10)}  ${pct(sh.read)}  ${pct(sh.resent)}  ${pct(sh.write)} | ${k(s.input + s.write)} ${k(s.cacheRead)}  ${k(s.output)} | ${label(sh).padEnd(16)} | ${s.prompt.slice(0, 40)}`);
  }
  const t = list.reduce((a, s) => ({ input: a.input + s.input, write: a.write + s.write, weightedWrite: a.weightedWrite + s.weightedWrite, cacheRead: a.cacheRead + s.cacheRead, output: a.output + s.output }),
    { input: 0, write: 0, weightedWrite: 0, cacheRead: 0, output: 0 });
  const sh = shares(t);
  lines.push('', `전체 ${list.length}개 세션 (비용 가중 비중): 읽기 ${pct(sh.read)} · 재전송 ${pct(sh.resent)} · 작성 ${pct(sh.write)} → ${label(sh)}`);
  return lines.join('\n');
}

module.exports = { collect, shares, label };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--days');
  const days = i >= 0 ? Number(args.splice(i, 2)[1]) : 0;
  if (i >= 0 && !(days > 0)) { console.error('--days 뒤에는 양수를 넣으세요.'); process.exit(1); }
  const root = args[0] || path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) { console.error(`기록 폴더가 없습니다: ${root}`); process.exit(1); }
  const list = collect(root, days ? Date.now() - days * 864e5 : 0);
  console.log(list.length ? report(list) : '집계할 세션이 없습니다.');
}
