// 회원 기능: 카카오 로그인·가입 동의, 내 정보, 즐겨찾기, 포인트·등급, 제휴 혜택, 관리자 화면.
// (게시판은 2026-11-17 사용자 요청으로 닫아 두어 옮기지 않음 — 표는 db.ts 에 남겨 둠)
import { DB } from "./db";
import { abort, courseById, Ctx, gradeOf, GRADES, json, now, redirect, Row, safeNext, today, randomToken } from "./lib";

// 포인트 규칙: [점수, 하루 최대 횟수]
export const RULES: Record<string, [number, number]> = {
  "가입 축하": [20, 1], "출석": [1, 1], "글쓰기": [10, 3], "사진 올리기": [5, 3], "댓글": [2, 10], "추천 받음": [1, 20],
  "대회 참가": [30, 3],
};
const BOARD_RULES = ["글쓰기", "사진 올리기", "댓글", "추천 받음"];

const adminIds = (ctx: Ctx) => new Set((ctx.env.ADMIN_KAKAO_IDS || "").split(",").map((x) => x.trim()).filter(Boolean));
const devLogin = (ctx: Ctx) => ctx.env.DEV_LOGIN === "1" && ["localhost", "127.0.0.1"].includes(ctx.url.hostname);

/** 규칙에 따라 포인트를 준다. 하루 최대 횟수를 넘으면 주지 않는다. */
export async function addPoints(db: DB, uid: number, reason: string, n = 1) {
  const [pts, cap] = RULES[reason];
  const day = today();
  const used = await db.val("SELECT COUNT(*) FROM point_log WHERE user_id = ? AND reason = ? AND day = ?", uid, reason, day);
  if (used >= cap) return 0;
  await db.batch([
    db.q("INSERT INTO point_log (user_id, delta, reason, day, created_at) VALUES (?, ?, ?, ?, ?)", uid, pts * n, reason, day, now()),
    db.q("UPDATE users SET points = points + ?, earned = earned + ? WHERE id = ?", pts * n, pts * n, uid),
  ]);
  return pts * n;
}

/** 요청마다: 로그인한 회원을 불러오고, 오늘 첫 방문이면 출석 포인트 */
export async function loadUser(ctx: Ctx, db: DB) {
  const uid = ctx.session.uid;
  if (!uid) return;
  const u = await db.one("SELECT * FROM users WHERE id = ?", uid);
  if (!u || u.banned) { ctx.pop("uid"); return; }
  u.grade = gradeOf(u.earned);
  const ids = adminIds(ctx), kid = String(u.kakao_id);
  u.is_admin = ids.has(kid) || ids.has(kid.replace(/^kakao:/, "")) || (devLogin(ctx) && kid === "dev:시험회원");
  ctx.user = u;
  if (u.agreed_at && u.last_attend !== today()) {
    await db.run("UPDATE users SET last_attend = ? WHERE id = ?", today(), uid);
    const got = await addPoints(db, uid, "출석");
    u.points += got; u.earned += got;
  }
}

/** 로그인이 필요한 화면: 안 했으면 로그인으로, 가입 동의 전이면 동의 화면으로 (돌려줄 응답이 있으면 반환) */
export function needLogin(ctx: Ctx): Response | null {
  if (!ctx.user) {
    if (ctx.path.startsWith("/api/")) return json({ error: "로그인이 필요합니다." }, 401);
    return redirect(`/login?next=${encodeURIComponent(ctx.fullPath)}`);
  }
  if (!ctx.user.agreed_at) return redirect(`/join/agree?next=${encodeURIComponent(ctx.fullPath)}`);
  return null;
}
export function needAdmin(ctx: Ctx): Response | null {
  const r = needLogin(ctx);
  if (r) return r;
  if (!ctx.user!.is_admin) abort(403);
  return null;
}

const cleanNick = (s: any) => {
  const v = String(s || "").replace(/\s+/g, " ").trim().slice(0, 20);
  return v.length >= 2 ? v : null;
};
const fv = (f: FormData, k: string) => String(f.get(k) ?? "");

// ---------------------------------------------------------------- 로그인 (카카오)
export function login(ctx: Ctx) {
  if (ctx.user) return redirect(safeNext(ctx.arg("next")));
  return ctx.render("login.html", { next: safeNext(ctx.arg("next")), kakao_ready: !!ctx.env.KAKAO_REST_API_KEY, dev_login: devLogin(ctx) });
}

const callbackUrl = (ctx: Ctx) => `${ctx.url.origin}/auth/kakao/callback`;

export function kakaoStart(ctx: Ctx) {
  if (!ctx.env.KAKAO_REST_API_KEY) return ctx.notice("준비 중", "카카오 로그인 설정이 아직 되지 않았습니다.", 503);
  const state = randomToken(16);
  ctx.set("oauth_state", state);
  ctx.set("after_login", safeNext(ctx.arg("next")));
  const q = new URLSearchParams({ client_id: ctx.env.KAKAO_REST_API_KEY, redirect_uri: callbackUrl(ctx), response_type: "code", state });
  return redirect(`https://kauth.kakao.com/oauth/authorize?${q}`);
}

export async function kakaoCallback(ctx: Ctx, db: DB) {
  if (ctx.arg("error")) { ctx.flash("카카오 로그인을 취소했습니다."); return redirect("/login"); }
  const expected = ctx.pop("oauth_state");
  if (!ctx.arg("state") || ctx.arg("state") !== expected) abort(400, "로그인 확인값이 맞지 않습니다. 다시 시도해 주세요.");
  const data = new URLSearchParams({ grant_type: "authorization_code", client_id: ctx.env.KAKAO_REST_API_KEY || "",
    code: ctx.arg("code"), redirect_uri: callbackUrl(ctx) });
  if (ctx.env.KAKAO_CLIENT_SECRET) data.set("client_secret", ctx.env.KAKAO_CLIENT_SECRET);
  let me: Row;
  try {
    const t = await fetch("https://kauth.kakao.com/oauth/token", { method: "POST", body: data, signal: AbortSignal.timeout(10000) });
    if (!t.ok) throw new Error(`token ${t.status}: ${(await t.text()).slice(0, 200)}`);
    const token = ((await t.json()) as Row).access_token;
    const r = await fetch("https://kapi.kakao.com/v2/user/me", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    me = await r.json();
    if (!me.id) throw new Error("no id");
  } catch (e) {
    console.error("kakao login failed", String(e));
    ctx.flash("카카오 로그인 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.");
    return redirect("/login");
  }
  const prof = (me.kakao_account || {}).profile || {}, props = me.properties || {};
  const nickname = String(prof.nickname || props.nickname || "파크골퍼").slice(0, 20);
  const img = prof.thumbnail_image_url || props.thumbnail_image || null;
  return finishLogin(ctx, db, `kakao:${me.id}`, nickname, img);
}

export async function devLoginRoute(ctx: Ctx, db: DB) {
  if (!devLogin(ctx)) abort(404);
  const name = (ctx.arg("name") || "시험회원").slice(0, 20);
  ctx.set("after_login", safeNext(ctx.arg("next")));
  return finishLogin(ctx, db, `dev:${name}`, name, null);
}

async function finishLogin(ctx: Ctx, db: DB, kakaoId: string, nickname: string, img: string | null) {
  const u = await db.one("SELECT * FROM users WHERE kakao_id = ?", kakaoId);
  let uid: number;
  if (u) {
    await db.run("UPDATE users SET profile_img = ? WHERE id = ?", img, u.id);
    uid = u.id;
  } else {
    const r = await db.one("INSERT INTO users (kakao_id, nickname, profile_img, points, earned, created_at) VALUES (?, ?, ?, 0, 0, ?) RETURNING id",
      kakaoId, nickname, img, now());
    uid = r!.id;
  }
  if (u && u.banned) { ctx.flash("이용이 제한된 계정입니다. 운영자에게 문의해 주세요."); return redirect("/"); }
  const nxt = ctx.session.after_login || "/";
  ctx.session = {}; ctx.dirty = true;  // 로그인 때 새로 시작 (세션 고정 공격 방지)
  ctx.set("uid", uid);
  if (!u || !u.agreed_at) return redirect(`/join/agree?next=${encodeURIComponent(safeNext(nxt))}`);
  return redirect(safeNext(nxt));
}

export async function agree(ctx: Ctx, db: DB) {
  const u = ctx.user;
  if (!u) return redirect("/login");
  if (ctx.req.method === "POST") {
    const f = await ctx.req.formData();
    if (!(f.get("terms") && f.get("privacy") && f.get("age14"))) {
      ctx.flash("필수 항목에 모두 동의해 주세요.");
      return redirect(ctx.fullPath);
    }
    const first = !u.agreed_at;
    await db.run("UPDATE users SET agreed_at = ?, nickname = ?, marketing = ?, fav_sido = ?, fav_sigungu = ? WHERE id = ?",
      now(), cleanNick(f.get("nickname")) || u.nickname, f.get("marketing") ? 1 : 0, fv(f, "fav_sido") || null,
      fv(f, "fav_sigungu") || null, u.id);
    if (first) {
      await addPoints(db, u.id, "가입 축하");
      ctx.flash("나이스파크 회원이 되신 것을 환영합니다! 가입 축하 20포인트를 드렸습니다.");
    }
    return redirect(safeNext(fv(f, "next")));
  }
  return ctx.render("agree.html", { next: safeNext(ctx.arg("next")) });
}

export function logout(ctx: Ctx) {
  ctx.session = {}; ctx.dirty = true;
  return redirect("/");
}

// ---------------------------------------------------------------- 내 정보
export async function mePage(ctx: Ctx, db: DB) {
  const r0 = needLogin(ctx); if (r0) return r0;
  const uid = ctx.user!.id;
  if (ctx.req.method === "POST") {
    const f = await ctx.req.formData();
    const nick = cleanNick(f.get("nickname"));
    if (!nick) ctx.flash("닉네임은 2~20자로 적어 주세요.");
    else {
      await db.run("UPDATE users SET nickname = ?, fav_sido = ?, fav_sigungu = ?, marketing = ? WHERE id = ?",
        nick, fv(f, "fav_sido") || null, fv(f, "fav_sigungu") || null, f.get("marketing") ? 1 : 0, uid);
      ctx.flash("저장했습니다.");
    }
    return redirect("/me");
  }
  const favRows = await db.all("SELECT course_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC", uid);
  const [log, reds, myComps] = await Promise.all([
    db.all("SELECT * FROM point_log WHERE user_id = ? ORDER BY id DESC LIMIT 15", uid),
    db.all(`SELECT r.*, b.title, b.partner FROM redemptions r JOIN benefits b ON b.id = r.benefit_id
            WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 10`, uid),
    db.all(`SELECT e.*, c.title, c.play_date, c.venue, c.groups_open FROM entries e JOIN comps c ON c.id = e.comp_id
            WHERE e.user_id = ? ORDER BY c.play_date DESC LIMIT 10`, uid),
  ]);
  return ctx.render("me.html", { favs: favRows.map((f) => courseById[f.course_id]).filter(Boolean), log, reds, my_comps: myComps });
}

export async function withdraw(ctx: Ctx, db: DB) {
  const r0 = needLogin(ctx); if (r0) return r0;
  const uid = ctx.user!.id;
  const pids = (await db.all("SELECT id FROM posts WHERE user_id = ?", uid)).map((r) => r.id);
  const stmts = [];
  if (pids.length) {
    const ph = pids.map(() => "?").join(",");
    for (const t of ["comments", "likes"]) stmts.push(db.q(`DELETE FROM ${t} WHERE post_id IN (${ph})`, ...pids));
  }
  for (const t of ["comments", "likes", "favorites", "point_log", "reports", "redemptions", "entries"])
    stmts.push(db.q(`DELETE FROM ${t} WHERE user_id = ?`, uid));
  stmts.push(db.q("DELETE FROM posts WHERE user_id = ?", uid), db.q("DELETE FROM users WHERE id = ?", uid));
  await db.batch(stmts);
  ctx.session = {}; ctx.dirty = true;
  ctx.flash("탈퇴했습니다. 회원 정보와 작성한 글이 모두 삭제되었습니다.");
  return redirect("/");
}

export async function apiMe(ctx: Ctx, db: DB) {
  const u = ctx.user;
  if (!u || !u.agreed_at) return json({ enabled: true, login: false });
  const favs = (await db.all("SELECT course_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC", u.id))
    .map((f) => courseById[f.course_id]).filter(Boolean)
    .map((c) => Object.fromEntries(["id", "name", "sido", "sigungu", "holes", "reserve_level", "reserve_url", "photo", "portal"].map((k) => [k, c[k] ?? null])));
  return json({ enabled: true, login: true, nickname: u.nickname, points: u.points, earned: u.earned, grade: u.grade,
    favorites: favs, fav_sido: u.fav_sido, fav_sigungu: u.fav_sigungu, admin: u.is_admin });
}

export async function toggleFav(ctx: Ctx, db: DB, cid: string) {
  const r0 = needLogin(ctx); if (r0) return r0;
  if (!courseById[cid]) abort(404);
  const uid = ctx.user!.id;
  if (await db.one("SELECT 1 FROM favorites WHERE user_id = ? AND course_id = ?", uid, cid)) {
    await db.run("DELETE FROM favorites WHERE user_id = ? AND course_id = ?", uid, cid);
    return json({ favorite: false });
  }
  await db.run("INSERT OR IGNORE INTO favorites (user_id, course_id, created_at) VALUES (?, ?, ?)", uid, cid, now());
  return json({ favorite: true });
}

/** 구장 상세 화면: 즐겨찾기 여부 (게시판이 닫혀 있어 글 목록은 비어 있음) */
export async function apiCoursePosts(ctx: Ctx, db: DB, cid: string) {
  const fav = !!(ctx.user && await db.one("SELECT 1 FROM favorites WHERE user_id = ? AND course_id = ?", ctx.user.id, cid));
  return json({ enabled: true, favorite: fav, login: !!ctx.user, items: [] });
}

// ---------------------------------------------------------------- 혜택
async function monthlyRanking(db: DB, n: number) {
  const rows = await db.all(`SELECT u.nickname, u.earned, SUM(p.delta) AS pts FROM point_log p JOIN users u ON u.id = p.user_id
    WHERE p.day LIKE ? AND p.delta > 0 AND u.banned = 0 GROUP BY u.id, u.nickname, u.earned ORDER BY pts DESC LIMIT ?`,
    `${today().slice(0, 7)}%`, n);
  return rows.map((r) => ({ nickname: r.nickname, points: r.pts, grade: gradeOf(r.earned) }));
}

export async function benefitsPage(ctx: Ctx, db: DB) {
  const rows = await db.all("SELECT * FROM benefits WHERE active = 1 ORDER BY cost");
  const rules = Object.entries(RULES).filter(([k]) => !BOARD_RULES.includes(k)).map(([k, [p, c]]) => [k, p, c]);
  return ctx.render("benefits.html", { rows, rules, ranking: await monthlyRanking(db, 10) });
}

export async function redeem(ctx: Ctx, db: DB, bid: number) {
  const r0 = needLogin(ctx); if (r0) return r0;
  const f = await ctx.req.formData();
  const contact = fv(f, "contact").trim().slice(0, 100);
  if (!contact) { ctx.flash("혜택을 받으실 연락처를 적어 주세요."); return redirect("/benefits"); }
  const b = await db.one("SELECT * FROM benefits WHERE id = ? AND active = 1", bid);
  if (!b) abort(404);
  const u = (await db.one("SELECT * FROM users WHERE id = ?", ctx.user!.id))!;
  let msg: string, ok = false;
  if (gradeOf(u.earned).level < b!.min_grade) msg = `${GRADES[b!.min_grade][1]} 등급부터 받을 수 있는 혜택입니다.`;
  else if (u.points < b!.cost) msg = `포인트가 부족합니다. (필요 ${b!.cost}, 보유 ${u.points})`;
  else if (b!.stock != null && b!.stock <= 0) msg = "준비된 수량이 모두 소진되었습니다.";
  else {
    const res = await db.batch([
      db.q("UPDATE users SET points = points - ? WHERE id = ? AND points >= ?", b!.cost, u.id, b!.cost),
      db.q("UPDATE benefits SET stock = stock - 1 WHERE id = ? AND stock IS NOT NULL", bid),
      db.q("INSERT INTO point_log (user_id, delta, reason, day, created_at) VALUES (?, ?, '혜택 교환', ?, ?)", u.id, -b!.cost, today(), now()),
      db.q("INSERT INTO redemptions (user_id, benefit_id, cost, contact, status, created_at) VALUES (?, ?, ?, ?, '신청', ?)",
        u.id, bid, b!.cost, contact, now()),
    ]);
    ok = true;
    msg = `'${b!.title}' 교환을 신청했습니다. 운영자가 확인 후 보내 드립니다.`;
    void res;
  }
  ctx.flash(msg);
  return redirect(ok ? "/me" : "/benefits");
}

// ---------------------------------------------------------------- 관리자
export async function adminPage(ctx: Ctx, db: DB) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  const [bens, reds, reps, hidden, users_, nUsers, nPosts, nToday] = await Promise.all([
    db.all("SELECT * FROM benefits ORDER BY id DESC"),
    db.all(`SELECT r.*, u.nickname, b.title FROM redemptions r JOIN users u ON u.id = r.user_id
            JOIN benefits b ON b.id = r.benefit_id ORDER BY r.id DESC LIMIT 100`),
    db.all(`SELECT r.*, u.nickname FROM reports r JOIN users u ON u.id = r.user_id WHERE r.done = 0 ORDER BY r.id DESC LIMIT 100`),
    db.all(`SELECT p.*, u.nickname FROM posts p JOIN users u ON u.id = p.user_id WHERE p.hidden = 1 ORDER BY p.id DESC LIMIT 50`),
    db.all("SELECT * FROM users ORDER BY earned DESC LIMIT 50"),
    db.val("SELECT COUNT(*) FROM users"), db.val("SELECT COUNT(*) FROM posts"),
    db.val("SELECT COUNT(*) FROM users WHERE created_at LIKE ?", `${today()}%`),
  ]);
  return ctx.render("admin.html", { bens, bens_plus: [...bens, null], reds, reps, hidden, users_,
    stats: { "회원": nUsers, "글": nPosts, "오늘 가입": nToday } });
}

export async function adminBenefit(ctx: Ctx, db: DB) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  const f = await ctx.req.formData();
  const int = (k: string) => parseInt(fv(f, k), 10) || 0;
  const vals = [fv(f, "partner").slice(0, 60), fv(f, "title").slice(0, 120), fv(f, "description").slice(0, 2000),
    Math.max(0, int("cost")), Math.min(4, Math.max(0, int("min_grade"))),
    fv(f, "stock").trim() ? int("stock") : null, f.get("active") ? 1 : 0];
  if (fv(f, "id")) await db.run("UPDATE benefits SET partner=?, title=?, description=?, cost=?, min_grade=?, stock=?, active=? WHERE id=?", ...vals, int("id"));
  else await db.run("INSERT INTO benefits (partner, title, description, cost, min_grade, stock, active, created_at) VALUES (?,?,?,?,?,?,?,?)", ...vals, now());
  ctx.flash("혜택을 저장했습니다.");
  return redirect("/admin");
}

export async function adminRedemption(ctx: Ctx, db: DB, rid: number, action: string) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  const r = await db.one("SELECT * FROM redemptions WHERE id = ?", rid);
  if (!r || r.status !== "신청" || !["done", "cancel"].includes(action)) abort(400);
  if (action === "done") {  // 지급 후 연락처는 지운다 (개인정보 최소 보관)
    await db.run("UPDATE redemptions SET status = '지급완료', done_at = ?, contact = NULL WHERE id = ?", now(), rid);
  } else {  // 취소: 포인트 돌려줌
    await db.batch([
      db.q("UPDATE redemptions SET status = '취소', done_at = ?, contact = NULL WHERE id = ?", now(), rid),
      db.q("UPDATE users SET points = points + ? WHERE id = ?", r!.cost, r!.user_id),
      db.q("INSERT INTO point_log (user_id, delta, reason, day, created_at) VALUES (?, ?, '교환 취소 환불', ?, ?)", r!.user_id, r!.cost, today(), now()),
      db.q("UPDATE benefits SET stock = stock + 1 WHERE id = ? AND stock IS NOT NULL", r!.benefit_id),
    ]);
  }
  return redirect("/admin");
}

export async function adminPost(ctx: Ctx, db: DB, pid: number, action: string) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  const stmts = [];
  if (action === "show") stmts.push(db.q("UPDATE posts SET hidden = 0, reports = 0 WHERE id = ?", pid));
  else if (action === "hide") stmts.push(db.q("UPDATE posts SET hidden = 1 WHERE id = ?", pid));
  stmts.push(db.q("UPDATE reports SET done = 1 WHERE kind = 'post' AND target_id = ?", pid));
  await db.batch(stmts);
  return redirect("/admin");
}

export async function adminReportDone(ctx: Ctx, db: DB, rid: number) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  await db.run("UPDATE reports SET done = 1 WHERE id = ?", rid);
  return redirect("/admin");
}

export async function adminBan(ctx: Ctx, db: DB, uid: number) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  await db.run("UPDATE users SET banned = 1 - COALESCE(banned, 0) WHERE id = ?", uid);
  return redirect("/admin");
}
