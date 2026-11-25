// ─────────────────────────────────────────────────────────────────────────────
// db.mjs — 데이터 저장소(SQLite). 데이터정의서·ERD 문서의 실제 구현체입니다.
//
// [왜 SQLite인가] 서버 설치 없이 파일 하나로 동작하고 Node.js 24 내장(node:sqlite)이라 npm 설치가 필요 없습니다.
//
// [테이블 6개]
//   users ─1:N─ meetings ─1:N─ segments (받아쓴 구간)
//                 │└─1:1─ summaries (요약)
//                 └─1:N─ items (결정·할 일·미결) ── 복합 외래키 → segments  (근거 구간 추적)
//   users ─1:N─ feedback ─N:1─ items (항목이 도움이 됐는지 평가)
//
// [설계 포인트]
//   · items(meeting_id, seg_idx) → segments(meeting_id, idx) 복합 외래키: "근거 없는 항목"이 DB 수준에서 불가능합니다.
//   · 모든 사용자 데이터가 users에 ON DELETE CASCADE로 달려 있어 "내 기록 모두 삭제"가 한 문장으로 끝납니다.
//   · 음성 파일 자체는 저장하지 않습니다(받아쓰기 직후 삭제). 저장되는 것은 마스킹된 텍스트뿐입니다.
//   · 모든 조회·수정 함수는 userId를 함께 받아 "내 것만" 접근하게 합니다(IDOR 방지).
// ─────────────────────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  meeting_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title TEXT NOT NULL, held_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('audio','text')),
  duration_sec REAL, language TEXT, stt_engine TEXT,
  pii_found TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
  segment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, start_sec REAL, end_sec REAL, speaker TEXT, text TEXT NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,
  UNIQUE (meeting_id, idx)
);
CREATE TABLE IF NOT EXISTS summaries (
  meeting_id INTEGER PRIMARY KEY REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  body TEXT NOT NULL, method TEXT NOT NULL CHECK (method IN ('rule','llm')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('decision','action','issue')),
  text TEXT NOT NULL, owner TEXT, due TEXT, due_expr TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  method TEXT NOT NULL CHECK (method IN ('rule','llm')),
  seg_idx INTEGER NOT NULL,
  FOREIGN KEY (meeting_id, seg_idx) REFERENCES segments(meeting_id, idx) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS feedback (
  feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  helpful INTEGER NOT NULL CHECK (helpful IN (0,1)), created_at TEXT NOT NULL,
  UNIQUE (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS ix_meetings_user ON meetings(user_id, held_at DESC);
CREATE INDEX IF NOT EXISTS ix_items_meeting ON items(meeting_id, kind);
`;

const now = () => new Date().toISOString();

export class Store {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;'); // SQLite는 외래키 검사가 기본 꺼짐 → 켜야 CASCADE가 동작
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }

  // 트랜잭션: 하나라도 실패하면 전부 취소(회의만 저장되고 구간이 없는 반쪽 상태 방지)
  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  ensureUser(userId) { this.db.prepare('INSERT OR IGNORE INTO users(user_id, created_at) VALUES (?, ?)').run(userId, now()); }

  // 회의 한 건 저장(회의+구간+요약+항목을 한 트랜잭션으로)
  saveMeeting(userId, { title, heldAt, source, durationSec = null, language = null, sttEngine = null, piiFound = [], segments, summary, items }) {
    this.ensureUser(userId);
    return this.tx(() => {
      const r = this.db.prepare('INSERT INTO meetings(user_id,title,held_at,source,duration_sec,language,stt_engine,pii_found,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(userId, title, heldAt, source, durationSec, language, sttEngine, JSON.stringify(piiFound), now());
      const id = Number(r.lastInsertRowid);
      const seg = this.db.prepare('INSERT INTO segments(meeting_id,idx,start_sec,end_sec,speaker,text) VALUES (?,?,?,?,?,?)');
      for (const s of segments) seg.run(id, s.idx, s.start ?? null, s.end ?? null, s.speaker ?? null, s.text);
      this.#saveDerived(id, summary, items);
      return id;
    });
  }

  #saveDerived(meetingId, summary, items, keep = new Map()) {
    this.db.prepare('INSERT OR REPLACE INTO summaries(meeting_id,body,method,created_at) VALUES (?,?,?,?)').run(meetingId, summary.body, summary.method, now());
    const ins = this.db.prepare('INSERT INTO items(meeting_id,kind,text,owner,due,due_expr,status,method,seg_idx) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const it of items) ins.run(meetingId, it.kind, it.text, it.owner ?? null, it.due ?? null, it.dueExpr ?? null, keep.get(`${it.kind}|${it.text}`) ?? 'open', it.method, it.segIdx);
  }

  // 받아쓰기를 고친 뒤 "다시 정리": 요약·항목을 새로 만들되, 이미 완료 처리한 항목은 같은 문장이면 완료 상태를 유지합니다.
  replaceDerived(userId, meetingId, summary, items) {
    if (!this.ownsMeeting(userId, meetingId)) return false;
    return this.tx(() => {
      const keep = new Map(this.db.prepare("SELECT kind, text, status FROM items WHERE meeting_id = ?").all(meetingId).map((r) => [`${r.kind}|${r.text}`, r.status]));
      this.db.prepare('DELETE FROM items WHERE meeting_id = ?').run(meetingId);
      this.#saveDerived(meetingId, summary, items, keep);
      return true;
    });
  }

  ownsMeeting(userId, meetingId) { return !!this.db.prepare('SELECT 1 FROM meetings WHERE meeting_id = ? AND user_id = ?').get(meetingId, userId); }

  listMeetings(userId) {
    return this.db.prepare(`SELECT m.meeting_id AS id, m.title, m.held_at AS heldAt, m.source, m.duration_sec AS durationSec, m.created_at AS createdAt,
        (SELECT COUNT(*) FROM items i WHERE i.meeting_id = m.meeting_id AND i.kind = 'decision') AS decisions,
        (SELECT COUNT(*) FROM items i WHERE i.meeting_id = m.meeting_id AND i.kind = 'action') AS actions,
        (SELECT COUNT(*) FROM items i WHERE i.meeting_id = m.meeting_id AND i.kind = 'action' AND i.status = 'open') AS openActions,
        (SELECT COUNT(*) FROM items i WHERE i.meeting_id = m.meeting_id AND i.kind = 'issue') AS issues
      FROM meetings m WHERE m.user_id = ? ORDER BY m.held_at DESC, m.meeting_id DESC`).all(userId);
  }

  getMeeting(userId, meetingId) {
    const m = this.db.prepare('SELECT meeting_id AS id, title, held_at AS heldAt, source, duration_sec AS durationSec, language, stt_engine AS sttEngine, pii_found AS pii, created_at AS createdAt FROM meetings WHERE meeting_id = ? AND user_id = ?').get(meetingId, userId);
    if (!m) return null;
    return {
      ...m, pii: JSON.parse(m.pii),
      segments: this.db.prepare('SELECT idx, start_sec AS start, end_sec AS end, speaker, text, edited FROM segments WHERE meeting_id = ? ORDER BY idx').all(meetingId),
      summary: this.db.prepare('SELECT body, method FROM summaries WHERE meeting_id = ?').get(meetingId) ?? null,
      items: this.db.prepare('SELECT item_id AS id, kind, text, owner, due, due_expr AS dueExpr, status, method, seg_idx AS segIdx FROM items WHERE meeting_id = ? ORDER BY seg_idx, item_id').all(meetingId),
    };
  }

  // 구간 문장 교정(받아쓰기 오류 수정). 교정한 구간은 edited=1로 표시합니다.
  updateSegment(userId, meetingId, idx, text) {
    if (!this.ownsMeeting(userId, meetingId)) return false;
    return Number(this.db.prepare('UPDATE segments SET text = ?, edited = 1 WHERE meeting_id = ? AND idx = ?').run(text, meetingId, idx).changes) > 0;
  }

  segmentsOf(meetingId) { return this.db.prepare('SELECT idx, start_sec AS start, end_sec AS end, speaker, text FROM segments WHERE meeting_id = ? ORDER BY idx').all(meetingId); }
  heldAtOf(meetingId) { return this.db.prepare('SELECT held_at AS h FROM meetings WHERE meeting_id = ?').get(meetingId)?.h ?? null; }

  // 항목 수정(완료 체크·담당자·기한). 내 회의의 항목만.
  updateItem(userId, itemId, patch) {
    const row = this.db.prepare('SELECT i.item_id FROM items i JOIN meetings m ON m.meeting_id = i.meeting_id WHERE i.item_id = ? AND m.user_id = ?').get(itemId, userId);
    if (!row) return false;
    const sets = [], vals = [];
    for (const [col, key] of [['status', 'status'], ['owner', 'owner'], ['due', 'due']]) if (key in patch) { sets.push(`${col} = ?`); vals.push(patch[key]); }
    if (!sets.length) return true;
    this.db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE item_id = ?`).run(...vals, itemId);
    return true;
  }

  // 내 모든 회의의 할 일(열린 것 먼저, 기한 빠른 순)
  actions(userId, { status = 'open' } = {}) {
    return this.db.prepare(`SELECT i.item_id AS id, i.text, i.owner, i.due, i.status, i.meeting_id AS meetingId, m.title AS meetingTitle, m.held_at AS heldAt, i.seg_idx AS segIdx
      FROM items i JOIN meetings m ON m.meeting_id = i.meeting_id
      WHERE m.user_id = ? AND i.kind = 'action' AND (? = 'all' OR i.status = ?)
      ORDER BY (i.due IS NULL), i.due, m.held_at DESC, i.item_id`).all(userId, status, status);
  }

  // 교차 회의 검색용: 내 모든 구간
  allSegments(userId) {
    return this.db.prepare(`SELECT s.meeting_id AS meetingId, m.title AS meetingTitle, m.held_at AS heldAt, s.idx, s.start_sec AS start, s.speaker, s.text
      FROM segments s JOIN meetings m ON m.meeting_id = s.meeting_id WHERE m.user_id = ?`).all(userId);
  }

  deleteMeeting(userId, meetingId) {
    return Number(this.db.prepare('DELETE FROM meetings WHERE meeting_id = ? AND user_id = ?').run(meetingId, userId).changes) > 0;
  }

  // 내 기록 전부 삭제(복구 불가). CASCADE로 회의·구간·요약·항목·평가가 함께 지워집니다.
  deleteUser(userId) {
    const meetings = Number(this.db.prepare('SELECT COUNT(*) AS n FROM meetings WHERE user_id = ?').get(userId).n);
    this.db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
    return { meetings };
  }

  ownsItem(userId, itemId) { return !!this.db.prepare('SELECT 1 FROM items i JOIN meetings m ON m.meeting_id = i.meeting_id WHERE i.item_id = ? AND m.user_id = ?').get(itemId, userId); }
  saveFeedback(userId, itemId, helpful) {
    this.db.prepare('INSERT INTO feedback(user_id,item_id,helpful,created_at) VALUES (?,?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET helpful = excluded.helpful').run(userId, itemId, helpful ? 1 : 0, now());
  }

  stats() {
    const n = (sql) => Number(this.db.prepare(sql).get().n);
    return {
      users: n('SELECT COUNT(*) AS n FROM users'), meetings: n('SELECT COUNT(*) AS n FROM meetings'), segments: n('SELECT COUNT(*) AS n FROM segments'),
      items: n('SELECT COUNT(*) AS n FROM items'), feedbackHelpful: n('SELECT COUNT(*) AS n FROM feedback WHERE helpful = 1'), feedbackTotal: n('SELECT COUNT(*) AS n FROM feedback'),
    };
  }
}
