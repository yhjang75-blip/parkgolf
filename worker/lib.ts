// 공통 도구: 시간(한국), 로그인 유지 쿠키(서명), 알림 메시지, 화면 그리기, 응답 만들기.
// @ts-ignore — UMD 묶음 (실행 중 코드 생성 없이 미리 번역한 화면 틀만 씀)
import nunjucks from "nunjucks/browser/nunjucks-slim.js";
// @ts-ignore — scripts/build-worker.mjs 가 만든 파일
import templates from "./gen/templates.js";
import COURSES from "./gen/courses-lite.json";
import SITE from "../data/site.json";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SECRET_KEY?: string;
  KAKAO_REST_API_KEY?: string;
  KAKAO_CLIENT_SECRET?: string;
  ADMIN_KAKAO_IDS?: string;
  ADMIN_IDS?: string;  // 관리자 가입 아이디 (쉼표로 여러 명)
  DEV_LOGIN?: string;
}

export type Row = Record<string, any>;

// ---------------------------------------------------------------- 시간 (한국 시각)
const kstDate = () => new Date(Date.now() + 9 * 3600e3);
export const today = () => kstDate().toISOString().slice(0, 10);
export const now = () => kstDate().toISOString().slice(0, 19).replace("T", " ");
export const fmtKst = (t: number) => new Date(t + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
export const dayDiff = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86400e3);

// ---------------------------------------------------------------- 구장 자료 (서버용 최소 항목)
export const courses: Row[] = COURSES as Row[];
export const courseById: Record<string, Row> = Object.fromEntries(courses.map((c) => [c.id, c]));
let _regions: Record<string, string[]> | null = null;
export function regions() {
  if (!_regions) {
    const out: Record<string, Set<string>> = {};
    for (const c of courses) (out[c.sido] ??= new Set()).add(c.sigungu);
    _regions = Object.fromEntries(Object.keys(out).sort().map((s) => [s, [...out[s]].filter(Boolean).sort()]));
  }
  return _regions;
}

// ---------------------------------------------------------------- 등급·포인트 규칙
export const GRADES: [number, string, string][] = [[0, "새싹", "🌱"], [100, "버디", "🐦"], [300, "이글", "🦅"],
  [700, "알바트로스", "🕊️"], [1500, "홀인원", "⛳"]];
export function gradeOf(earned: number) {
  let lv = 0;
  GRADES.forEach(([need], i) => { if ((earned || 0) >= need) lv = i; });
  return { level: lv, name: GRADES[lv][1], icon: GRADES[lv][2], next: lv + 1 < GRADES.length ? GRADES[lv + 1][0] : null };
}
export const CATEGORIES = { free: "자유게시판", review: "구장 후기", photo: "사진 자랑", tour: "대회 이야기", qna: "질문·정보" };

// ---------------------------------------------------------------- 화면 그리기
nunjucks.installJinjaCompat();
// 파이썬(Jinja)과 같게 맞추기 ①: 글자 자르기 s[5:7] 은 글자로 (기본은 글자 배열이 됨)
const rt = nunjucks.runtime;
const compatLookup = rt.memberLookup;
rt.memberLookup = function (this: any, obj: any, ...rest: any[]) {
  const r = compatLookup.call(this, obj, ...rest);
  return rest.length === 3 && typeof obj === "string" && Array.isArray(r) ? r.join("") : r;
};
// 파이썬(Jinja)과 같게 맞추기 ②: 빈 목록·빈 묶음은 '없음'으로 (scripts/build-worker.mjs 가 if 문을 runtime.jt 로 감쌈)
rt.jt = (v: any) => {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof rt.SafeString) return String(v).length > 0;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.keys(v).length > 0;
  return !!v;
};
const nj =new nunjucks.Environment(new nunjucks.PrecompiledLoader(templates), { autoescape: true });
const comma = (n: any) => (n == null || n === "" ? "" : Number(n).toLocaleString("en-US"));
nj.addFilter("comma", comma);
nj.addFilter("min", (a: number[]) => Math.min(...a));
nj.addFilter("tojson", (v: any) => new nunjucks.runtime.SafeString(
  JSON.stringify(v ?? null).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")));
nj.addFilter("format", (fmt: string, ...args: any[]) => {  // 파이썬 '%d', '%+d', '%s' 형식
  let i = 0;
  return String(fmt).replace(/%([+]?)([ds])/g, (_m, plus, t) => {
    const v = args[i++];
    if (t === "s") return String(v);
    const n = Math.trunc(Number(v));
    return (plus && n >= 0 ? "+" : "") + n;
  });
});
nj.addTest("none", (v: any) => v === null || v === undefined);
nj.addGlobal("GRADES", GRADES);
nj.addGlobal("CATEGORIES", CATEGORIES);
nj.addGlobal("site", SITE);
nj.addGlobal("grade_of", gradeOf);
nj.addGlobal("regions", regions);
nj.addGlobal("db_on", true);

export function mask(name: string) {
  name = (name || "").trim();
  if (name.length <= 1) return name;
  if (name.length === 2) return name[0] + "*";
  return name[0] + "*".repeat(name.length - 2) + name[name.length - 1];
}

// ---------------------------------------------------------------- 요청 하나의 상태
export class Ctx {
  url: URL;
  session: Row = {};
  dirty = false;
  user: Row | null = null;
  constructor(public req: Request, public env: Env, public exec: ExecutionContext) {
    this.url = new URL(req.url);
  }
  get path() { return this.url.pathname; }
  get fullPath() { return this.url.pathname + "?" + this.url.searchParams.toString(); }
  arg(k: string) { return this.url.searchParams.get(k) || ""; }
  set(k: string, v: any) { this.session[k] = v; this.dirty = true; }
  pop(k: string) { const v = this.session[k]; if (k in this.session) { delete this.session[k]; this.dirty = true; } return v; }
  flash(msg: string) { this.set("_flashes", [...(this.session._flashes || []), msg]); }
  csrf() {
    if (!this.session.csrf) this.set("csrf", randomToken(24));
    return this.session.csrf;
  }
  render(name: string, vars: Row = {}, status = 200) {
    const flashes = this.pop("_flashes") || [];
    const html = nj.render(name, { me: this.user, csrf: this.csrf(), flashes, mask, ...vars });
    return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  notice(title: string, msg: string, status = 200) { return this.render("notice.html", { title, msg }, status); }
}

export class HttpError extends Error {
  constructor(public status: number, msg = "") { super(msg); }
}
export const abort = (status: number, msg = ""): never => { throw new HttpError(status, msg); };

export const json = (data: any, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
export const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

export function safeNext(n: string | null | undefined) {
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/";
}

// ---------------------------------------------------------------- 로그인 유지 쿠키 (서명해서 위조 방지)
const enc = new TextEncoder();
export function randomToken(n: number) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return b64url(b);
}
function b64url(b: Uint8Array) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
let _key: { secret: string; key: CryptoKey } | null = null;
async function hmacKey(secret: string) {
  if (_key?.secret !== secret) {
    _key = { secret, key: await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]) };
  }
  return _key.key;
}
const COOKIE = "np_session";
const MAX_AGE = 30 * 86400;

export async function loadSession(ctx: Ctx, secret: string) {
  const m = (ctx.req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return;
  const [body, sig] = m[1].split(".");
  if (!body || !sig) return;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(body));
    if (!ok) return;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (data._exp && data._exp < Date.now() / 1000) return;
    ctx.session = data;
  } catch { /* 깨진 쿠키는 무시 */ }
}

export async function saveSession(ctx: Ctx, secret: string, resp: Response) {
  if (!ctx.dirty) return resp;
  const r = new Response(resp.body, resp);
  const secure = ctx.url.protocol === "https:" ? "; Secure" : "";
  if (!Object.keys(ctx.session).length) {
    r.headers.append("set-cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
    return r;
  }
  ctx.session._exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const body = b64url(enc.encode(JSON.stringify(ctx.session)));
  const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body))));
  r.headers.append("set-cookie", `${COOKIE}=${body}.${sig}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${secure}`);
  return r;
}
