// 저장소 · 받아쓰기 어댑터 · 작업 큐 · HTTP API(보안 포함) 테스트
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { createHandler } from '../src/http.mjs';
import { Store } from '../src/db.mjs';
import { SpeechToText, sniffAudio } from '../src/stt.mjs';

const off = { available: false, label: '없음', provider: 'off', lastError: null, ensure: async () => false, complete: async () => { throw new Error('off'); } };
const SCRIPT = '김민수: 배포는 12월 3일에 하기로 결정하겠습니다.\n이서연: 저는 내일까지 테스트 결과를 정리해서 공유하겠습니다.\n최유나: 결제 일정은 아직 정해지지 않았습니다.\n김민수: 유나 님이 다음 주 월요일까지 업체에 확인해 주세요.';
const U1 = 'user-aaaaaa', U2 = 'user-bbbbbb';

// WAV 헤더 모양의 가짜 바이트(형식 판별만 통과하면 됨)
const wavBytes = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE'), Buffer.alloc(32)]);

// ── 받아쓰기 어댑터 ─────────────────────────────────────────
test('오디오 형식은 확장자가 아니라 첫 바이트로 판별한다', () => {
  assert.equal(sniffAudio(wavBytes()), 'wav');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20)])), 'mp3');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(20)])), 'mp3');
  assert.equal(sniffAudio(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)])), 'm4a');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)])), 'ogg');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(20)])), 'flac');
  assert.equal(sniffAudio(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)])), 'webm');
  assert.equal(sniffAudio(Buffer.from('MZ' + 'x'.repeat(30))), null); // 실행 파일
  assert.equal(sniffAudio(Buffer.from('<html>' + 'x'.repeat(30))), null);
  assert.equal(sniffAudio(Buffer.alloc(3)), null);
  assert.equal(sniffAudio(null), null);
});

test('STT: python·ffmpeg 확인(없으면 이유 안내), 호출은 셸 없이 인자 배열로', async () => {
  const calls = [];
  const ok = new SpeechToText({ env: {}, run: async (c, a) => { calls.push([c, a]); return { stdout: '' }; } });
  assert.equal(await ok.check(), true);
  assert.deepEqual(calls.map((c) => c[0]), ['python', 'ffmpeg']);
  const noPkg = new SpeechToText({ env: {}, run: async (c) => { if (c === 'python') throw Object.assign(new Error('x'), { stderr: "ModuleNotFoundError: No module named 'faster_whisper'" }); return { stdout: '' }; } });
  assert.equal(await noPkg.check(), false); assert.match(noPkg.lastError, /faster-whisper/u);
  const noFfmpeg = new SpeechToText({ env: {}, run: async (c) => { if (c === 'ffmpeg') throw new Error('ENOENT'); return { stdout: '' }; } });
  assert.equal(await noFfmpeg.check(), false); assert.match(noFfmpeg.lastError, /ffmpeg/u);
});

test('STT: 변환 명령에 길이 상한(-t)과 모노 16kHz가 들어가고, 결과 JSON을 구간으로 바꾼다', async () => {
  let ffArgs;
  const stt = new SpeechToText({ env: {}, run: async (c, a) => {
    if (c === 'ffmpeg') { ffArgs = a; return { stdout: '' }; }
    return { stdout: 'warn line\n' + JSON.stringify({ language: 'ko', duration: 9.5, segments: [{ start: 0, end: 2, text: '안녕하세요' }] }) };
  } });
  await stt.toWav('/in.mp3', '/out.wav');
  assert.ok(ffArgs.includes('-t') && ffArgs.includes('3600') && ffArgs.includes('16000') && ffArgs.includes('-vn'));
  const r = await stt.transcribeWav('/out.wav');
  assert.equal(r.segments[0].text, '안녕하세요'); assert.equal(r.duration, 9.5);
});

test('STT: 스크립트 오류·JSON 아님·error 필드는 예외', async () => {
  const mk = (fn) => new SpeechToText({ env: {}, run: fn });
  await assert.rejects(() => mk(async () => { throw Object.assign(new Error('x'), { stderr: 'boom' }); }).transcribeWav('w'), /stt failed/u);
  await assert.rejects(() => mk(async () => ({ stdout: 'not json' })).transcribeWav('w'), /not JSON/u);
  await assert.rejects(() => mk(async () => ({ stdout: JSON.stringify({ error: '모델 없음' }) })).transcribeWav('w'), /모델 없음/u);
});

// ── 저장소 ─────────────────────────────────────────────────
const sample = (over = {}) => ({
  title: 'T', heldAt: '2026-11-30', source: 'text',
  segments: [{ idx: 0, start: 0, end: 1, speaker: 'A', text: '하나' }, { idx: 1, start: null, end: null, speaker: null, text: '둘' }],
  summary: { body: '요약', method: 'rule' },
  items: [{ kind: 'action', text: '둘', owner: 'A', due: '2026-12-01', dueExpr: '내일까지', segIdx: 1, method: 'rule' }, { kind: 'decision', text: '하나', segIdx: 0, method: 'rule' }],
  ...over,
});

test('DB: 저장 → 조회, 소유자 아닌 사용자는 볼 수도 고칠 수도 없다(IDOR)', () => {
  const s = new Store();
  const id = s.saveMeeting(U1, sample());
  const m = s.getMeeting(U1, id);
  assert.equal(m.segments.length, 2); assert.equal(m.items.length, 2); assert.equal(m.summary.method, 'rule');
  assert.equal(s.getMeeting(U2, id), null);
  assert.equal(s.updateSegment(U2, id, 0, '해킹'), false);
  assert.equal(s.getMeeting(U1, id).segments[0].text, '하나');
  const itemId = m.items.find((i) => i.kind === 'action').id;
  assert.equal(s.updateItem(U2, itemId, { status: 'done' }), false);
  assert.equal(s.updateItem(U1, itemId, { status: 'done', owner: 'B', due: null }), true);
  const a = s.getMeeting(U1, id).items.find((i) => i.id === itemId);
  assert.deepEqual([a.status, a.owner, a.due], ['done', 'B', null]);
  assert.equal(s.deleteMeeting(U2, id), false);
  assert.equal(s.ownsItem(U2, itemId), false);
  assert.deepEqual(s.listMeetings(U2), []);
  assert.deepEqual(s.actions(U2), []);
  assert.deepEqual(s.allSegments(U2), []);
});

test('DB: 근거 구간이 없는 항목은 저장 자체가 거부된다(복합 외래키) + 트랜잭션 롤백', () => {
  const s = new Store();
  assert.throws(() => s.saveMeeting(U1, sample({ items: [{ kind: 'issue', text: 'x', segIdx: 9, method: 'rule' }] })));
  assert.equal(s.stats().meetings, 0); // 회의·구간도 함께 취소됨
  assert.throws(() => s.saveMeeting(U1, sample({ items: [{ kind: 'bogus', text: 'x', segIdx: 0, method: 'rule' }] })));
  assert.equal(s.stats().segments, 0);
});

test('DB: 회의 삭제·사용자 전체 삭제는 구간·요약·항목·평가까지 연쇄 삭제', () => {
  const s = new Store();
  const a = s.saveMeeting(U1, sample()), b = s.saveMeeting(U1, sample({ title: 'T2' })); s.saveMeeting(U2, sample());
  const it = s.getMeeting(U1, a).items[0].id; s.saveFeedback(U1, it, true); s.saveFeedback(U1, it, false); // 같은 항목 재평가는 덮어쓰기
  assert.equal(s.stats().feedbackTotal, 1);
  assert.equal(s.deleteMeeting(U1, a), true);
  assert.equal(s.stats().feedbackTotal, 0); assert.equal(s.getMeeting(U1, a), null);
  assert.deepEqual(s.deleteUser(U1), { meetings: 1 });
  assert.equal(s.getMeeting(U1, b), null);
  const st = s.stats();
  assert.deepEqual([st.users, st.meetings, st.segments, st.items], [1, 1, 2, 2]); // U2 것만 남음
});

test('DB: 다시 정리하면 항목은 새로 만들되 같은 문장의 완료 상태는 유지', () => {
  const s = new Store();
  const id = s.saveMeeting(U1, sample());
  const act = s.getMeeting(U1, id).items.find((i) => i.kind === 'action');
  s.updateItem(U1, act.id, { status: 'done' });
  assert.equal(s.replaceDerived(U2, id, { body: 'x', method: 'rule' }, []), false);
  s.replaceDerived(U1, id, { body: '새 요약', method: 'llm' }, [{ kind: 'action', text: '둘', segIdx: 1, method: 'rule' }, { kind: 'issue', text: '하나', segIdx: 0, method: 'rule' }]);
  const m = s.getMeeting(U1, id);
  assert.equal(m.summary.body, '새 요약');
  assert.equal(m.items.find((i) => i.kind === 'action').status, 'done');
  assert.equal(m.items.find((i) => i.kind === 'issue').status, 'open');
});

test('DB: 할 일 모아보기는 열린 것만(기본), 기한 빠른 순·기한 없음은 뒤로', () => {
  const s = new Store();
  const id = s.saveMeeting(U1, sample({ items: [
    { kind: 'action', text: 'a', due: '2026-12-09', segIdx: 0, method: 'rule' },
    { kind: 'action', text: 'b', due: null, segIdx: 0, method: 'rule' },
    { kind: 'action', text: 'c', due: '2026-12-02', segIdx: 1, method: 'rule' }] }));
  s.updateItem(U1, s.getMeeting(U1, id).items.find((i) => i.text === 'a').id, { status: 'done' });
  assert.deepEqual(s.actions(U1).map((x) => x.text), ['c', 'b']);
  assert.deepEqual(s.actions(U1, { status: 'all' }).map((x) => x.text), ['c', 'a', 'b']);
});

// ── 서비스 + HTTP ───────────────────────────────────────────
let svc, server, base, tmp;
const sttFake = (over = {}) => ({
  available: true, label: 'fake-stt', lastError: null, check: async () => true,
  toWav: async (i, o) => o,
  transcribeWav: async () => ({ segments: [{ start: 0, end: 3, text: '제가 내일까지 테스트 결과를 올리겠습니다.' }, { start: 3, end: 6, text: '결제 일정은 아직 정해지지 않았습니다.' }], duration: 6, language: 'ko', engine: 'fake-stt' }),
  ...over,
});
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mm-test-'));
  svc = await createApp({ llm: off, stt: sttFake(), tmpDir: tmp });
  server = createServer(createHandler(svc, { minGapMs: 0, maxAudioBytes: 1024 * 1024 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(tmp, { recursive: true, force: true }); });

const call = async (path, { method = 'GET', body, raw, headers = {} } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const ct = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : await res.text() };
};
const waitJob = async (userId, jobId) => { await svc.idle(); return (await call(`/api/jobs/status?userId=${userId}&jobId=${jobId}`)).data; };

test('HTTP: 글 대본 → 작업 → 회의 조회 → 내려받기', async () => {
  const r = await call('/api/meetings/text', { method: 'POST', body: { userId: U1, title: '주간', heldAt: '2026-11-30', text: SCRIPT, useLlm: false } });
  assert.equal(r.status, 202);
  const j = await waitJob(U1, r.data.jobId);
  assert.equal(j.status, 'done');
  const m = (await call(`/api/meetings/get?userId=${U1}&id=${j.meetingId}`)).data;
  assert.equal(m.title, '주간');
  const act = m.items.filter((i) => i.kind === 'action');
  assert.deepEqual(act.map((a) => [a.owner, a.due]), [['이서연', '2026-12-01'], ['최유나', '2026-12-07']]);
  assert.equal(m.items.filter((i) => i.kind === 'decision').length, 1);
  assert.equal(m.items.filter((i) => i.kind === 'issue').length, 1);
  const md = await call(`/api/meetings/export?userId=${U1}&id=${j.meetingId}`);
  assert.equal(md.status, 200); assert.match(md.headers.get('content-disposition'), /attachment/u);
  assert.match(md.data, /## 결정 사항[\s\S]*## 할 일[\s\S]*- \[ \] .*담당: 이서연 \(기한 2026-12-01\)/u);
});

test('HTTP: 음성 업로드 → (가짜 STT) → 구간·항목, 임시 음성 파일은 삭제된다', async () => {
  const r = await call(`/api/meetings/audio?userId=${U1}&title=녹음&heldAt=2026-11-30&useLlm=0`, { method: 'POST', raw: wavBytes() });
  assert.equal(r.status, 202);
  const j = await waitJob(U1, r.data.jobId);
  assert.equal(j.status, 'done', j.error);
  const m = (await call(`/api/meetings/get?userId=${U1}&id=${j.meetingId}`)).data;
  assert.equal(m.source, 'audio'); assert.equal(m.durationSec, 6); assert.equal(m.sttEngine, 'fake-stt');
  const a = m.items.find((i) => i.kind === 'action');
  assert.equal(a.owner, null); assert.equal(a.due, '2026-12-01'); // 화자 정보가 없으니 담당자는 비어 있음
  assert.deepEqual(readdirSync(tmp), []);
});

test('HTTP: 음성이 아닌 파일은 415, 너무 크면 413, 사용자 ID 없으면 400', async () => {
  assert.equal((await call(`/api/meetings/audio?userId=${U1}`, { method: 'POST', raw: Buffer.from('MZ' + 'x'.repeat(100)) })).status, 415);
  assert.equal((await call(`/api/meetings/audio?userId=${U1}`, { method: 'POST', raw: Buffer.alloc(1024 * 1024 + 10, 1) })).status, 413);
  assert.equal((await call('/api/meetings/audio', { method: 'POST', raw: wavBytes() })).status, 400);
  assert.deepEqual(readdirSync(tmp), []); // 거부된 업로드는 디스크에 남지 않음
});

test('작업 실패: STT 오류·말 없음·STT 불가는 사용자에게 일반 문구, 임시 파일 정리', async () => {
  const run = async (stt, expectMsg) => {
    const s = await createApp({ llm: off, stt, tmpDir: tmp });
    const id = s.submitAudio(U1, { title: 't', heldAt: '2026-11-30', bytes: wavBytes() });
    await s.idle();
    const j = s.job(U1, id);
    assert.equal(j.status, 'error'); assert.match(j.error, expectMsg);
    assert.doesNotMatch(j.error, /Traceback|stderr|C:\\/u); assert.deepEqual(readdirSync(tmp), []);
  };
  await run(sttFake({ transcribeWav: async () => { throw Object.assign(new Error('stt failed'), { detail: 'Traceback secret path C:\\x' }); } }), /오류가 발생했습니다/u);
  await run(sttFake({ transcribeWav: async () => ({ segments: [], duration: 3, language: 'ko', engine: 'f' }) }), /말을 찾지 못했습니다/u);
  await run(sttFake({ check: async () => false, lastError: 'faster-whisper가 설치되어 있지 않습니다' }), /faster-whisper/u);
});

test('HTTP: 남의 작업·회의·항목·구간은 404(존재 여부도 숨김)', async () => {
  const r = await call('/api/meetings/text', { method: 'POST', body: { userId: U1, title: '비밀', heldAt: '2026-11-30', text: SCRIPT, useLlm: false } });
  const j = await waitJob(U1, r.data.jobId);
  assert.equal((await call(`/api/jobs/status?userId=${U2}&jobId=${r.data.jobId}`)).status, 404);
  assert.equal((await call(`/api/meetings/get?userId=${U2}&id=${j.meetingId}`)).status, 404);
  assert.equal((await call(`/api/meetings/export?userId=${U2}&id=${j.meetingId}`)).status, 404);
  assert.equal((await call('/api/meetings/delete', { method: 'POST', body: { userId: U2, id: j.meetingId } })).status, 404);
  assert.equal((await call('/api/segments/edit', { method: 'POST', body: { userId: U2, meetingId: j.meetingId, idx: 0, text: 'x' } })).status, 404);
  assert.equal((await call('/api/meetings/reextract', { method: 'POST', body: { userId: U2, id: j.meetingId } })).status, 404);
  const m = (await call(`/api/meetings/get?userId=${U1}&id=${j.meetingId}`)).data;
  assert.equal((await call('/api/items/update', { method: 'POST', body: { userId: U2, itemId: m.items[0].id, status: 'done' } })).status, 404);
  assert.equal((await call('/api/feedback', { method: 'POST', body: { userId: U2, itemId: m.items[0].id, helpful: true } })).status, 404);
  assert.equal((await call(`/api/meetings?userId=${U2}`)).data.length, 0);
  assert.equal((await call(`/api/search?userId=${U2}&q=${encodeURIComponent('배포')}`)).data.length, 0);
});

test('HTTP: 구간 교정 → 다시 정리하면 새 문장 기준으로 항목이 바뀐다', async () => {
  const r = await call('/api/meetings/text', { method: 'POST', body: { userId: U1, title: '교정', heldAt: '2026-11-30', text: '김민수: 서버 폐포는 12월 3일로 하기로 했습니다.\n이서연: 네 알겠습니다.', useLlm: false } });
  const j = await waitJob(U1, r.data.jobId);
  assert.equal((await call(`/api/meetings/get?userId=${U1}&id=${j.meetingId}`)).data.items[0].kind, 'decision');
  assert.equal((await call('/api/segments/edit', { method: 'POST', body: { userId: U1, meetingId: j.meetingId, idx: 0, text: '서버 배포는 날짜를 아직 정하지 못했습니다. 논의가 필요합니다.' } })).status, 200);
  const r2 = await call('/api/meetings/reextract', { method: 'POST', body: { userId: U1, id: j.meetingId, useLlm: false } });
  assert.equal((await waitJob(U1, r2.data.jobId)).status, 'done');
  const m = (await call(`/api/meetings/get?userId=${U1}&id=${j.meetingId}`)).data;
  assert.deepEqual(m.items.map((i) => i.kind), ['issue']);
  assert.equal(m.segments[0].edited, 1);
  assert.equal((await call('/api/segments/edit', { method: 'POST', body: { userId: U1, meetingId: j.meetingId, idx: 0, text: '   ' } })).status, 400);
  assert.equal((await call('/api/segments/edit', { method: 'POST', body: { userId: U1, meetingId: j.meetingId, idx: 99, text: '없는 구간' } })).status, 404);
});

test('HTTP: 항목 수정 검증(상태·기한 형식), 평가, 할 일 모아보기, 검색', async () => {
  const r = await call('/api/meetings/text', { method: 'POST', body: { userId: U2, title: '검색용', heldAt: '2026-11-30', text: SCRIPT, useLlm: false } });
  const j = await waitJob(U2, r.data.jobId);
  const m = (await call(`/api/meetings/get?userId=${U2}&id=${j.meetingId}`)).data;
  const act = m.items.find((i) => i.kind === 'action');
  const up = (body) => call('/api/items/update', { method: 'POST', body: { userId: U2, itemId: act.id, ...body } });
  assert.equal((await up({ status: 'weird' })).status, 400);
  assert.equal((await up({ due: '내일' })).status, 400);
  assert.equal((await up({ itemId: -1 })).status, 400);
  assert.equal((await up({ status: 'done', due: '2026-12-20', owner: '박지훈' })).status, 200);
  assert.equal((await call('/api/feedback', { method: 'POST', body: { userId: U2, itemId: act.id, helpful: true } })).status, 200);
  const open = (await call(`/api/actions?userId=${U2}`)).data;
  assert.ok(!open.some((a) => a.id === act.id)); // 완료 처리했으니 열린 목록에는 없음
  assert.ok((await call(`/api/actions?userId=${U2}&status=all`)).data.some((a) => a.id === act.id && a.owner === '박지훈'));
  const hits = (await call(`/api/search?userId=${U2}&q=${encodeURIComponent('결제 일정')}`)).data;
  assert.ok(hits.length && /결제/u.test(hits[0].text) && hits[0].meetingTitle === '검색용');
});

test('HTTP: 입력 검증 — 날짜 형식, 너무 짧은 대본, JSON이 아닌 본문, 깨진 주소', async () => {
  const post = (body) => call('/api/meetings/text', { method: 'POST', body });
  assert.equal((await post({ userId: U1, heldAt: '2026-02-30', text: SCRIPT })).status, 400);
  assert.equal((await post({ userId: U1, heldAt: '내일', text: SCRIPT })).status, 400);
  assert.equal((await post({ userId: U1, text: '한 줄' })).status, 400);
  assert.equal((await post({ userId: U1, text: '' })).status, 400);
  assert.equal((await post({ userId: 'x', text: SCRIPT })).status, 400);
  assert.equal((await call('/api/meetings/text', { method: 'POST', headers: { 'content-type': 'application/json' }, raw: 'null' })).status, 400);
  assert.equal((await call('/api/meetings/text', { method: 'POST', headers: { 'content-type': 'application/json' }, raw: '{깨짐' })).status, 400);
  assert.equal((await call('/%E0%A4%A')).status, 400);
  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/api/status', { method: 'POST' })).status, 404);
  assert.equal((await call('/', { method: 'DELETE' })).status, 405);
});

test('HTTP: 대본 속 HTML/스크립트는 그대로 글자로 저장(화면은 textContent), 제목의 제어문자 제거', async () => {
  const evil = '<script>alert(1)</script> 박지훈: 제가 내일까지 <img src=x onerror=alert(1)> 정리하겠습니다.\n김민수: 네 알겠습니다.';
  const r = await call('/api/meetings/text', { method: 'POST', body: { userId: U1, title: '제목\u0000\u0007<b>', heldAt: '2026-11-30', text: evil, useLlm: false } });
  const j = await waitJob(U1, r.data.jobId);
  const m = (await call(`/api/meetings/get?userId=${U1}&id=${j.meetingId}`)).data;
  assert.ok(m.segments[0].text.includes('<script>')); // 저장은 원문 그대로, 출력할 때 이스케이프하는 방식
  assert.ok(!/[\u0000-\u001f]/u.test(m.title));
});

test('HTTP: 정적 파일 — 경로 이탈 차단, 보안 헤더, 샘플', async () => {
  const idx = await call('/');
  assert.equal(idx.status, 200); assert.match(idx.headers.get('content-security-policy'), /default-src 'self'/u);
  assert.equal(idx.headers.get('x-frame-options'), 'DENY');
  assert.equal((await call('/..%2fserver.mjs')).status, 404);
  assert.equal((await call('/%2e%2e/package.json')).status, 404);
  const s = (await call('/api/sample')).data;
  assert.ok(s.title && s.text.includes('김민수:'));
});

test('HTTP: 상태 · 통계 · 요청 간격 제한(429)', async () => {
  const st = (await call('/api/status')).data;
  assert.equal(st.stt, 'fake-stt'); assert.equal(st.sttAvailable, true); assert.equal(st.limits.audioMinutes, 60);
  assert.ok((await call('/api/stats')).data.meetings >= 1);
  const strict = createServer(createHandler(svc, { minGapMs: 60000 })); await new Promise((r) => strict.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${strict.address().port}`;
  const go = () => fetch(b + '/api/meetings/text', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'user-throttle', text: SCRIPT, heldAt: '2026-11-30', useLlm: false }) });
  assert.equal((await go()).status, 202); assert.equal((await go()).status, 429);
  await svc.idle(); strict.close();
});

test('HTTP: 내 기록 전부 삭제는 confirm 필요, 삭제 후에는 아무것도 남지 않는다', async () => {
  const U = 'user-forget1';
  const r = await call('/api/meetings/text', { method: 'POST', body: { userId: U, title: 'x', heldAt: '2026-11-30', text: SCRIPT, useLlm: false } });
  await waitJob(U, r.data.jobId);
  assert.equal((await call('/api/forget', { method: 'POST', body: { userId: U } })).status, 400);
  assert.equal((await call(`/api/meetings?userId=${U}`)).data.length, 1);
  const del = await call('/api/forget', { method: 'POST', body: { userId: U, confirm: true } });
  assert.deepEqual(del.data.deleted, { meetings: 1 });
  assert.equal((await call(`/api/meetings?userId=${U}`)).data.length, 0);
  assert.equal((await call(`/api/search?userId=${U}&q=${encodeURIComponent('배포')}`)).data.length, 0);
});

test('작업 큐: 한 번에 하나씩 순서대로 처리, 사용자 ID가 없는 상태 조회는 400', async () => {
  const order = []; let running = 0, maxRunning = 0;
  const s = await createApp({ llm: off, stt: sttFake({ transcribeWav: async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise((r) => setTimeout(r, 30)); running--; order.push(1); return { segments: [{ start: 0, end: 1, text: '네 알겠습니다 그렇게 합시다' }], duration: 1, language: 'ko', engine: 'f' }; } }), tmpDir: tmp });
  const ids = [1, 2, 3].map(() => s.submitAudio(U1, { title: 't', heldAt: '2026-11-30', bytes: wavBytes() }));
  await s.idle();
  assert.equal(maxRunning, 1); assert.equal(order.length, 3);
  assert.ok(ids.every((id) => s.job(U1, id).status === 'done'));
  assert.equal((await call('/api/jobs/status?jobId=x')).status, 400);
});
