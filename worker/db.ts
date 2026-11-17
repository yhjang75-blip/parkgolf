// 회원·포인트·혜택·대회 자료 보관 (Cloudflare D1 = 무료 SQLite 데이터베이스).
// 표는 처음 요청 때 자동으로 만든다 (따로 설정할 것 없음). 표를 바꾸면 SCHEMA_VERSION 을 올린다.
import { Env, Row, randomToken } from "./lib";

const SCHEMA_VERSION = "3";
// 표를 고칠 때: 이미 있는 데이터베이스에 덧붙일 문장 (버전 → 문장들)
const MIGRATIONS: Record<number, string[]> = {
  // 2026-11-17 아이디·비밀번호 회원가입
  2: [
    `ALTER TABLE users ADD COLUMN login_id TEXT`,
    `ALTER TABLE users ADD COLUMN pw_hash TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_users_login_id ON users (login_id)`,
    `CREATE TABLE IF NOT EXISTS login_fail (login_id TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)`,
  ],
  // 2026-11-17 게시판: 사진 정보(사진 파일은 KV 'PHOTOS'), 이모티콘 공감
  3: [
    `CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      width INTEGER, height INTEGER, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ix_images_post ON images (post_id)`,
    `CREATE TABLE IF NOT EXISTS reactions (post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (post_id, user_id, emoji))`,
    `CREATE INDEX IF NOT EXISTS ix_posts_list ON posts (hidden, category, id)`,
    `CREATE INDEX IF NOT EXISTS ix_posts_course ON posts (course_id, id)`,
    `CREATE INDEX IF NOT EXISTS ix_posts_user ON posts (user_id)`,
    `CREATE INDEX IF NOT EXISTS ix_comments_post ON comments (post_id)`,
  ],
};
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kakao_id TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, profile_img TEXT,
    points INTEGER NOT NULL DEFAULT 0, earned INTEGER NOT NULL DEFAULT 0, fav_sido TEXT, fav_sigungu TEXT,
    agreed_at TEXT, marketing INTEGER DEFAULT 0, last_attend TEXT, banned INTEGER DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS favorites (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    course_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, course_id))`,
  // 게시판 표 (지금은 게시판을 닫아 두었지만, 다시 열 때를 위해 만들어 둠)
  `CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, course_id TEXT, views INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, photos INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS likes (post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (post_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT, done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS point_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL, reason TEXT NOT NULL, day TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ix_point_log_user ON point_log (user_id, day)`,
  `CREATE TABLE IF NOT EXISTS benefits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, partner TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
    cost INTEGER NOT NULL, min_grade INTEGER NOT NULL DEFAULT 0, stock INTEGER, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    benefit_id INTEGER NOT NULL REFERENCES benefits(id), cost INTEGER NOT NULL, contact TEXT,
    status TEXT NOT NULL DEFAULT '신청', created_at TEXT NOT NULL, done_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS comps (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, play_date TEXT NOT NULL, open_date TEXT NOT NULL,
    close_date TEXT NOT NULL, venue TEXT NOT NULL, course_id TEXT, host TEXT, contact TEXT, divisions TEXT NOT NULL,
    fee INTEGER NOT NULL DEFAULT 0, pay_info TEXT, capacity INTEGER NOT NULL DEFAULT 0,
    play_courses TEXT NOT NULL DEFAULT 'A,B,C,D', group_size INTEGER NOT NULL DEFAULT 4,
    start_time TEXT NOT NULL DEFAULT '08:00', wave_gap INTEGER NOT NULL DEFAULT 30, format TEXT, body TEXT,
    closed INTEGER NOT NULL DEFAULT 0, groups_open INTEGER NOT NULL DEFAULT 0, results_open INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, comp_id INTEGER NOT NULL REFERENCES comps(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, phone TEXT NOT NULL,
    gender TEXT NOT NULL, birth_year INTEGER, club TEXT, division TEXT NOT NULL, memo TEXT,
    status TEXT NOT NULL DEFAULT '신청', group_no INTEGER, start_spot TEXT, tee_time TEXT, scores TEXT, total INTEGER,
    rank INTEGER, created_at TEXT NOT NULL, paid_at TEXT, UNIQUE (comp_id, user_id))`,
  `CREATE INDEX IF NOT EXISTS ix_entries_comp ON entries (comp_id)`,
];

export class DB {
  constructor(public d1: D1Database) {}
  q(sql: string, ...args: any[]) { return this.d1.prepare(sql).bind(...args.map((a) => (a === undefined ? null : a))); }
  async all(sql: string, ...args: any[]): Promise<Row[]> { return (await this.q(sql, ...args).all()).results as Row[]; }
  async one(sql: string, ...args: any[]): Promise<Row | null> { return (await this.q(sql, ...args).first()) as Row | null; }
  async val(sql: string, ...args: any[]): Promise<any> {
    const r = await this.one(sql, ...args);
    return r ? Object.values(r)[0] : null;
  }
  async run(sql: string, ...args: any[]) { return this.q(sql, ...args).run(); }
  /** 여러 문장을 한꺼번에 (전부 성공하거나 전부 취소) */
  async batch(stmts: D1PreparedStatement[]) { return stmts.length ? this.d1.batch(stmts) : []; }
}

let ready = false;
/** 표가 사라진 경우(데이터베이스 초기화 등) 다음 요청에서 다시 만들도록 */
export function schemaLost(e: unknown) {
  if (String(e).includes("no such table")) ready = false;
}
export async function openDb(env: Env) {
  const db = new DB(env.DB);
  if (!ready) {
    let ver = null;
    try { ver = await db.val("SELECT value FROM settings WHERE key = 'schema'"); } catch { /* 처음: 표 없음 */ }
    const cur = ver ? parseInt(ver, 10) : 0, latest = parseInt(SCHEMA_VERSION, 10);
    if (cur < latest) {
      if (cur < 1) await db.batch(SCHEMA.map((s) => db.q(s)));
      // 여러 서버가 동시에 고칠 수 있으므로 한 문장씩, '이미 있음' 오류는 무시
      for (let v = Math.max(2, cur + 1); v <= latest; v++) {
        for (const s of MIGRATIONS[v] || []) {
          try { await db.run(s); } catch (e) { if (!/duplicate column|already exists/i.test(String(e))) throw e; }
        }
      }
      await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema', ?)", SCHEMA_VERSION);
    }
    ready = true;
  }
  return db;
}

/** 로그인 유지용 비밀값: SECRET_KEY 비밀값이 있으면 그것, 없으면 처음 한 번 만들어 데이터베이스에 보관 */
let _secret: string | null = null;
export async function secretKey(env: Env, db: DB) {
  if (env.SECRET_KEY) return env.SECRET_KEY;
  if (_secret) return _secret;
  let s = await db.val("SELECT value FROM settings WHERE key = 'secret_key'");
  if (!s) {
    await db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('secret_key', ?)", randomToken(32));
    s = await db.val("SELECT value FROM settings WHERE key = 'secret_key'");
  }
  return (_secret = s);
}

/** 외부 자료(날씨·뉴스·영상) 보관: 이 서버 기억 → 데이터베이스 → 새로 가져오기. 실패하면 지난 자료라도. */
const mem = new Map<string, { at: number; value: any }>();
export async function cached<T>(db: DB, key: string, ttlSec: number, fn: () => Promise<T>): Promise<T | null> {
  const t = Date.now();
  let hit = mem.get(key) || null;
  if (hit && t - hit.at < ttlSec * 1000) return hit.value;
  if (!hit) {
    const r = await db.one("SELECT value, at FROM cache WHERE key = ?", key).catch(() => null);
    if (r) {
      hit = { at: r.at, value: JSON.parse(r.value) };
      mem.set(key, hit);
      if (t - hit.at < ttlSec * 1000) return hit.value;
    }
  }
  let out: T;
  try { out = await fn(); } catch { return hit ? hit.value : null; }
  const empty = !out || (Array.isArray(out) && !out.length);
  if (empty) return hit ? hit.value : out;
  mem.set(key, { at: t, value: out });
  await db.run("INSERT OR REPLACE INTO cache (key, value, at) VALUES (?, ?, ?)", key, JSON.stringify(out), t).catch(() => {});
  return out;
}
