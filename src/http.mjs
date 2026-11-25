// ─────────────────────────────────────────────────────────────────────────────
// http.mjs — HTTP API와 정적 파일 서빙 (프레임워크 없이 Node 기본 http만 사용)
//
// [엔드포인트]
//   GET  /api/status               서버·AI(LLM)·받아쓰기(STT) 상태, 한도
//   GET  /api/sample               시연용 샘플 대본
//   POST /api/llm/reconnect        AI(Ollama 등) 다시 연결
//   POST /api/meetings/text        글 대본 제출 → { jobId }
//   POST /api/meetings/audio       음성 파일(바이너리 본문) 제출 → { jobId }
//   GET  /api/jobs/status          작업 진행 상황(jobId)
//   GET  /api/meetings             내 회의 목록
//   GET  /api/meetings/get         회의 상세(구간·요약·항목)
//   GET  /api/meetings/export      회의록 내려받기(.md)
//   POST /api/meetings/delete      회의 삭제
//   POST /api/meetings/reextract   받아쓰기 교정 후 다시 정리 → { jobId }
//   POST /api/segments/edit        구간 문장 교정
//   POST /api/items/update         할 일 완료 체크·담당자·기한 수정
//   POST /api/feedback             항목이 도움이 됐는지 평가
//   GET  /api/actions              내 모든 회의의 할 일 모아보기
//   GET  /api/search               회의 전체 검색(근거 구간 반환)
//   POST /api/forget               내 기록 전부 삭제(confirm 필요, 복구 불가)
//   GET  /api/stats                운영 지표
//
// [보안 장치 — 면접에서 설명할 수 있어야 하는 부분]
//   1) 본문 크기 제한(413): JSON 작게, 음성은 MAX_AUDIO_MB   2) userId 형식 검사 + 모든 조회에 소유자 조건(IDOR 방지)
//   3) 사용자당 호출 간격 제한(429)   4) 정적 파일 경로 이탈(../) 차단   5) 보안 헤더(CSP 등)
//   6) 내부 오류는 일반 문구만 노출   7) 음성은 내용(매직 넘버)으로 검사하고 처리 후 삭제   8) 127.0.0.1 바인딩 기본값
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { ROOT } from './app.mjs';
import { HttpError } from './errors.mjs';
import { MAX_AUDIO_SEC } from './stt.mjs';
import { LIMITS } from './transcript.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

// CSP: 우리 서버의 스크립트·스타일만 실행. media-src blob: / connect-src 'self' 는 브라우저 녹음 파일 업로드용.
const SECURITY = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'permissions-policy': 'microphone=(self), camera=(), geolocation=()', // 마이크는 이 사이트만 사용 가능
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY });
  res.end(JSON.stringify(body));
};

// 본문 읽기: 한도를 넘으면 끝까지 읽어 버리고 413(바로 끊으면 브라우저가 오류 내용을 못 받음)
const readRaw = (req, limit) => new Promise((resolve, reject) => {
  let size = 0, tooBig = false; const parts = [];
  req.on('data', (c) => { size += c.length; if (size > limit) tooBig = true; else if (!tooBig) parts.push(c); });
  req.on('end', () => (tooBig ? reject(new HttpError(413, '요청이 너무 큽니다.')) : resolve(Buffer.concat(parts))));
  req.on('error', () => reject(new HttpError(400, '요청을 읽을 수 없습니다.')));
});
const readBody = async (req, limit) => {
  const buf = await readRaw(req, limit);
  try {
    const body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not object');
    return body;
  } catch { throw new HttpError(400, '요청 본문은 JSON 객체여야 합니다.'); }
};

const USER_ID = /^[\w-]{6,64}$/u;
const userOf = (v) => { const id = String(v ?? ''); if (!USER_ID.test(id)) throw new HttpError(400, 'userId가 필요합니다.'); return id; };
const intOf = (v, name) => { const n = Number(v); if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} 값이 올바르지 않습니다.`); return n; };

export function createHandler(svc, { sampleFile = join(ROOT, 'samples', 'scripts.json'), minGapMs = 700, maxAudioBytes = Number(process.env.MAX_AUDIO_MB || 100) * 1024 * 1024 } = {}) {
  const lastCall = new Map();
  const throttle = (key) => {
    const t = Date.now(), prev = lastCall.get(key) ?? 0;
    if (t - prev < minGapMs) throw new HttpError(429, '요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.');
    lastCall.set(key, t);
    if (lastCall.size > 5000) lastCall.clear();
  };

  async function api(req, res, url) {
    const m = req.method, p = url.pathname, q = url.searchParams;

    if (m === 'GET' && p === '/api/status') {
      await svc.llm.ensure?.();
      await svc.stt.check();
      return json(res, 200, {
        llm: svc.llm.label, llmProvider: svc.llm.available ? svc.llm.provider : null, llmError: svc.llm.lastError,
        stt: svc.stt.label, sttAvailable: !!svc.stt.available, sttError: svc.stt.lastError,
        limits: { audioMB: Math.round(maxAudioBytes / 1048576), audioMinutes: MAX_AUDIO_SEC / 60, textChars: LIMITS.maxChars },
      });
    }
    if (m === 'POST' && p === '/api/llm/reconnect') {
      throttle('llm-reconnect');
      await svc.llm.ensure({ force: true });
      await svc.stt.check({ force: true });
      return json(res, 200, { llm: svc.llm.label, llmProvider: svc.llm.available ? svc.llm.provider : null, llmError: svc.llm.lastError, stt: svc.stt.label, sttAvailable: !!svc.stt.available });
    }
    if (m === 'GET' && p === '/api/sample') {
      if (!existsSync(sampleFile)) return json(res, 200, {});
      const s = JSON.parse(readFileSync(sampleFile, 'utf8')).meetings[0];
      return json(res, 200, { title: s.title, heldAt: s.heldAt, text: s.lines.map((l) => `${l.speaker}: ${l.text}`).join('\n') });
    }
    if (m === 'GET' && p === '/api/stats') return json(res, 200, svc.store.stats());

    if (m === 'POST' && p === '/api/meetings/text') {
      const b = await readBody(req, 700000); // 한글 200,000자 ≈ 600KB(글자당 3바이트)
      const userId = userOf(b.userId); throttle(userId);
      return json(res, 202, { jobId: svc.submitText(userId, { title: b.title, heldAt: b.heldAt, text: b.text, useLlm: b.useLlm !== false }) });
    }
    if (m === 'POST' && p === '/api/meetings/audio') {
      // 음성은 JSON이 아니라 "바이너리 본문"으로 보냅니다(base64로 감싸면 크기가 1.33배가 되고 메모리를 더 씁니다).
      const userId = userOf(q.get('userId')); throttle(userId);
      const bytes = await readRaw(req, maxAudioBytes);
      return json(res, 202, { jobId: svc.submitAudio(userId, { title: q.get('title'), heldAt: q.get('heldAt'), bytes, useLlm: q.get('useLlm') !== '0' }) });
    }
    if (m === 'GET' && p === '/api/jobs/status') {
      const j = svc.job(userOf(q.get('userId')), q.get('jobId'));
      if (!j) throw new HttpError(404, '작업을 찾을 수 없습니다.');
      return json(res, 200, j);
    }
    if (m === 'GET' && p === '/api/meetings') return json(res, 200, svc.meetings(userOf(q.get('userId'))));
    if (m === 'GET' && p === '/api/meetings/get') {
      const r = svc.meeting(userOf(q.get('userId')), intOf(q.get('id'), 'id'));
      if (!r) throw new HttpError(404, '회의를 찾을 수 없습니다.');
      return json(res, 200, r);
    }
    if (m === 'GET' && p === '/api/meetings/export') {
      const md = svc.exportMarkdown(userOf(q.get('userId')), intOf(q.get('id'), 'id'));
      if (md == null) throw new HttpError(404, '회의를 찾을 수 없습니다.');
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="meeting-${intOf(q.get('id'), 'id')}.md"`, ...SECURITY });
      return res.end(md);
    }
    if (m === 'POST' && p === '/api/meetings/delete') {
      const b = await readBody(req, 1000);
      if (!svc.store.deleteMeeting(userOf(b.userId), intOf(b.id, 'id'))) throw new HttpError(404, '회의를 찾을 수 없습니다.');
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/meetings/reextract') {
      const b = await readBody(req, 1000);
      const userId = userOf(b.userId); throttle(userId);
      return json(res, 202, { jobId: svc.reextract(userId, intOf(b.id, 'id'), b.useLlm !== false) });
    }
    if (m === 'POST' && p === '/api/segments/edit') {
      const b = await readBody(req, 10000);
      if (!svc.editSegment(userOf(b.userId), intOf(b.meetingId, 'meetingId'), intOf(b.idx, 'idx'), b.text)) throw new HttpError(404, '구간을 찾을 수 없습니다.');
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/items/update') {
      const b = await readBody(req, 2000);
      const patch = {};
      if ('status' in b) { if (!['open', 'done'].includes(b.status)) throw new HttpError(400, 'status 값이 올바르지 않습니다.'); patch.status = b.status; }
      if ('owner' in b) patch.owner = b.owner == null || b.owner === '' ? null : String(b.owner).slice(0, 20);
      if ('due' in b) {
        if (b.due !== null && b.due !== '' && !/^\d{4}-\d{2}-\d{2}$/u.test(String(b.due))) throw new HttpError(400, '기한은 YYYY-MM-DD 형식이어야 합니다.');
        patch.due = b.due || null;
      }
      if (!svc.store.updateItem(userOf(b.userId), intOf(b.itemId, 'itemId'), patch)) throw new HttpError(404, '항목을 찾을 수 없습니다.');
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/api/feedback') {
      const b = await readBody(req, 1000);
      const userId = userOf(b.userId), itemId = intOf(b.itemId, 'itemId');
      if (!svc.store.ownsItem(userId, itemId)) throw new HttpError(404, '평가할 항목을 찾을 수 없습니다.');
      svc.store.saveFeedback(userId, itemId, !!b.helpful);
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/actions') return json(res, 200, svc.actions(userOf(q.get('userId')), q.get('status') === 'all' ? 'all' : 'open'));
    if (m === 'GET' && p === '/api/search') return json(res, 200, svc.search(userOf(q.get('userId')), String(q.get('q') ?? '').slice(0, 200)));
    if (m === 'POST' && p === '/api/forget') {
      const b = await readBody(req, 1000);
      const userId = userOf(b.userId);
      if (b.confirm !== true) throw new HttpError(400, '삭제하려면 confirm: true 가 필요합니다. 삭제한 기록은 복구할 수 없습니다.');
      return json(res, 200, { ok: true, deleted: svc.store.deleteUser(userId) });
    }
    throw new HttpError(404, '찾을 수 없는 API입니다.');
  }

  function serveStatic(req, res, url) {
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, '주소 형식이 올바르지 않습니다.'); }
    const rel = url.pathname === '/' ? 'index.html' : decoded.replace(/^[/\\]+/u, '');
    const root = join(ROOT, 'public');
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY }); return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY });
    res.end(readFileSync(file));
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않는 요청입니다.');
      return serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error('[error]', e);
      return json(res, 500, { error: '서버 내부 오류가 발생했습니다.' });
    }
  };
}
