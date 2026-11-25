// ─────────────────────────────────────────────────────────────────────────────
// app.mjs — 서비스 계층: 처리 순서(파이프라인)와 작업 큐를 조립합니다. HTTP·화면과 무관한 "업무 로직"입니다.
//
// [파이프라인]  입력(음성/글) → (음성이면) 변환·받아쓰기 → 구간 목록 → 정리(요약·결정·할 일·미결) → DB 저장
//
// [왜 작업 큐(Job)인가]
//   받아쓰기는 수십 초~수 분이 걸립니다. 요청 한 번에 기다리면 브라우저가 시간 초과되고 서버가 막힙니다.
//   그래서 요청은 즉시 jobId를 돌려주고, 실제 처리는 뒤에서 "한 번에 하나씩" 하며, 화면은 jobId로 진행 상황을 물어봅니다.
//   한 번에 하나씩 하는 이유: Whisper는 CPU를 거의 다 쓰므로 동시에 여러 개를 돌리면 모두 느려지고 메모리가 모자랍니다.
//
// [개인정보] 업로드한 음성 파일은 받아쓰기가 끝나면(성공·실패 모두) 즉시 삭제합니다. DB에는 마스킹된 텍스트만 남습니다.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.mjs';
import { LLM } from './llm.mjs';
import { SpeechToText, sniffAudio } from './stt.mjs';
import { toSegments, clock } from './transcript.mjs';
import { analyzeMeeting } from './extract.mjs';
import { searchSegments } from './search.mjs';
import { HttpError } from './errors.mjs';
import { isValidDate } from './dates.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const JOB_TTL_MS = 3600000;

export async function createApp({ dbPath = ':memory:', llm, stt, tmpDir = join(ROOT, 'data', 'tmp'), today = () => new Date().toISOString().slice(0, 10) } = {}) {
  const store = new Store(dbPath);
  llm ??= await new LLM({ timeoutMs: 120000 }).init(); // 긴 회의는 LLM 응답이 오래 걸릴 수 있어 시간 제한을 넉넉히
  stt ??= new SpeechToText();
  mkdirSync(tmpDir, { recursive: true });

  // ── 작업 큐 ───────────────────────────────────────────────
  const jobs = new Map();
  let chain = Promise.resolve();
  const newId = () => randomBytes(8).toString('hex');
  const setJob = (j, patch) => Object.assign(j, patch, { updatedAt: Date.now() });
  const prune = () => { const cut = Date.now() - JOB_TTL_MS; for (const [id, j] of jobs) if (j.updatedAt < cut && (j.status === 'done' || j.status === 'error')) jobs.delete(id); };

  function enqueue(userId, label, work) {
    prune();
    const id = newId();
    const job = { id, userId, label, status: 'queued', step: '대기 중', meetingId: null, error: null, updatedAt: Date.now() };
    jobs.set(id, job);
    chain = chain.then(async () => {
      try { await work(job); setJob(job, { status: 'done', step: '완료' }); }
      catch (e) {
        // 사용자에게는 일반 문구만. 원인은 서버 로그에만 남깁니다(내부 경로·시스템 정보 노출 방지).
        console.error('[job error]', label, e.detail ?? e.message);
        setJob(job, { status: 'error', step: '실패', error: e instanceof HttpError ? e.message : '처리 중 오류가 발생했습니다. 파일 형식과 길이를 확인하고 다시 시도해 주세요.' });
      }
    });
    return id;
  }

  const cleanTitle = (t, fallback) => String(t ?? '').replace(/[\u0000-\u001f]/gu, ' ').trim().slice(0, 80) || fallback;
  const cleanDate = (d) => { const s = String(d ?? '').trim() || today(); if (!isValidDate(s)) throw new HttpError(400, '회의 날짜는 YYYY-MM-DD 형식이어야 합니다.'); return s; };

  // 정리 단계(공통): 구간 → 요약·항목 → 저장
  async function finish(job, userId, meta, segments, piiFound, extra = {}) {
    setJob(job, { status: 'analyzing', step: llm.available ? '요약·할 일 정리 중(AI)' : '요약·할 일 정리 중(규칙)' });
    const r = await analyzeMeeting({ segments, heldAt: meta.heldAt, llm, useLlm: meta.useLlm !== false });
    const id = store.saveMeeting(userId, { ...meta, ...extra, piiFound, segments, summary: r.summary, items: r.items });
    setJob(job, { meetingId: id, llm: r.llm });
    return id;
  }

  const svc = {
    store, llm, stt, jobs,

    // 글 대본(txt/srt/vtt) 제출 → jobId
    submitText(userId, { title, heldAt, text, useLlm = true }) {
      const date = cleanDate(heldAt);
      let parsed;
      try { parsed = toSegments(text); } catch (e) { if (e instanceof RangeError) throw new HttpError(413, e.message); throw e; }
      if (parsed.segments.length < 2) throw new HttpError(400, '대본이 너무 짧습니다. 두 줄 이상 입력해 주세요.');
      return enqueue(userId, 'text', (job) => finish(job, userId, { title: cleanTitle(title, '제목 없는 회의'), heldAt: date, source: 'text', useLlm }, parsed.segments, parsed.piiFound));
    },

    // 음성 파일(바이트) 제출 → jobId. 형식은 파일 내용으로 판별하고, 처리 후 임시 파일을 지웁니다.
    submitAudio(userId, { title, heldAt, bytes, useLlm = true }) {
      const date = cleanDate(heldAt);
      const ext = sniffAudio(bytes);
      if (!ext) throw new HttpError(415, '지원하지 않는 파일입니다. wav·mp3·m4a·ogg·flac·webm 음성만 올릴 수 있습니다.');
      const base = join(tmpDir, newId()); // 파일명은 서버가 만든 난수(사용자 입력이 경로에 들어가지 않음)
      const src = `${base}.${ext}`, wav = `${base}.16k.wav`;
      writeFileSync(src, bytes);
      return enqueue(userId, 'audio', async (job) => {
        try {
          if (!(await stt.check())) throw new HttpError(503, stt.lastError ?? '받아쓰기를 사용할 수 없습니다. 텍스트 대본으로 올려 주세요.');
          setJob(job, { status: 'converting', step: '음성 변환 중' });
          await stt.toWav(src, wav);
          setJob(job, { status: 'transcribing', step: '받아쓰기 중(오래 걸릴 수 있음)' });
          const t = await stt.transcribeWav(wav);
          const parsed = toSegments(t.segments);
          if (!parsed.segments.length) throw new HttpError(422, '음성에서 말을 찾지 못했습니다. 녹음 상태를 확인해 주세요.');
          await finish(job, userId, { title: cleanTitle(title, '제목 없는 회의'), heldAt: date, source: 'audio', useLlm }, parsed.segments, parsed.piiFound, { durationSec: t.duration, language: t.language, sttEngine: t.engine });
        } finally { rmSync(src, { force: true }); rmSync(wav, { force: true }); } // 음성은 남기지 않습니다
      });
    },

    job(userId, jobId) {
      const j = jobs.get(String(jobId));
      if (!j || j.userId !== userId) return null; // 남의 작업은 "없음"으로(존재 여부도 알려 주지 않음)
      const { id, status, step, meetingId, error, llm: l } = j;
      return { id, status, step, meetingId, error, llm: l ?? null };
    },
    idle() { return chain; }, // 테스트에서 "큐가 비었는지" 기다릴 때 사용

    meetings: (userId) => store.listMeetings(userId),
    meeting: (userId, id) => store.getMeeting(userId, id),
    actions: (userId, status) => store.actions(userId, { status }),
    search: (userId, q) => searchSegments(store.allSegments(userId), q).map((r) => ({ ...r, time: clock(r.start) })),

    // 받아쓰기 교정 → 필요하면 다시 정리
    editSegment(userId, meetingId, idx, text) {
      const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
      if (!clean || clean.length > 2000) throw new HttpError(400, '문장은 1~2000자여야 합니다.');
      return store.updateSegment(userId, meetingId, idx, clean);
    },
    reextract(userId, meetingId, useLlm = true) {
      if (!store.ownsMeeting(userId, meetingId)) throw new HttpError(404, '회의를 찾을 수 없습니다.');
      return enqueue(userId, 'reextract', async (job) => {
        const segments = store.segmentsOf(meetingId).map((s) => ({ ...s }));
        const r = await analyzeMeeting({ segments, heldAt: store.heldAtOf(meetingId), llm, useLlm });
        store.replaceDerived(userId, meetingId, r.summary, r.items);
        setJob(job, { meetingId, llm: r.llm });
      });
    },

    // 회의록 내보내기(마크다운). 결정·할 일·미결·요약·전체 대본.
    exportMarkdown(userId, meetingId) {
      const m = store.getMeeting(userId, meetingId);
      if (!m) return null;
      const L = [`# ${m.title}`, '', `- 일시: ${m.heldAt}${m.durationSec ? ` · 길이 ${clock(m.durationSec)}` : ''}`, '', '## 요약', m.summary?.body ?? '', ''];
      const sect = (title, kind, fmt) => { const xs = m.items.filter((i) => i.kind === kind); L.push(`## ${title}`); L.push(...(xs.length ? xs.map(fmt) : ['- 없음']), ''); };
      sect('결정 사항', 'decision', (i) => `- ${i.text}`);
      sect('할 일', 'action', (i) => `- [${i.status === 'done' ? 'x' : ' '}] ${i.text}${i.owner ? ` — 담당: ${i.owner}` : ''}${i.due ? ` (기한 ${i.due})` : ''}`);
      sect('미결 사항', 'issue', (i) => `- ${i.text}`);
      L.push('## 전체 대본', ...m.segments.map((s) => `- ${s.start != null ? `[${clock(s.start)}] ` : ''}${s.speaker ? `${s.speaker}: ` : ''}${s.text}`), '');
      return L.join('\n');
    },
  };
  return svc;
}
