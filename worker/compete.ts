// 나이스파크 대회 참가 시스템 (compete.py 를 옮김).
//  1. 대회 개설 → 2. 참가 신청 → 3. 입금 확인 → 4. 조 편성 → 5. 점수·순위 → 6. 결과 발표
// 공개 화면에서는 참가자 이름 가운데 글자를 가린다 (예: 김*수). 연락처는 관리자만 본다.
import { DB } from "./db";
import { abort, courseById, Ctx, dayDiff, json, mask, now, redirect, Row, today } from "./lib";
import { addPoints, needAdmin, needLogin } from "./members";

const ACTIVE = ["신청", "입금확인"];          // 자리를 차지하는 신청
const STATUS_ALL = ["신청", "입금확인", "취소요청", "취소"];
const HOLES_PER_COURSE = 9;
const ph = (a: any[]) => a.map(() => "?").join(",");
const splitList = (s: any) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const fv = (f: FormData, k: string) => String(f.get(k) ?? "");
const isDigits = (s: string) => /^\d+$/.test(s);

async function counts(db: DB, cid: number) {
  const rows = await db.all("SELECT status, COUNT(*) AS n FROM entries WHERE comp_id = ? GROUP BY status", cid);
  const c: Row = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  c.active = ACTIVE.reduce((s, k) => s + (c[k] || 0), 0);
  return c;
}

/** 대회 자료에 상태·부문 목록·신청 수를 붙인다. */
async function decorate(db: DB, c: Row) {
  const cnt = await counts(db, c.id);
  const t = today();
  c.div_list = splitList(c.divisions);
  c.course_list = splitList(c.play_courses);
  if (!c.course_list.length) c.course_list = ["A"];
  c.holes = c.course_list.length * HOLES_PER_COURSE;
  c.cnt = cnt;
  c.full = !!c.capacity && cnt.active >= c.capacity;
  c.can_apply = false;
  if (c.hidden) [c.state, c.tone] = ["준비 중", "gray"];
  else if (t < c.open_date) [c.state, c.tone] = [`접수 예정 (${c.open_date.slice(5).replace("-", "/")}부터)`, "warn"];
  else if (t <= c.close_date && !c.closed && !c.full) [c.state, c.tone, c.can_apply] = ["접수 중", "ok", true];
  else if (t < c.play_date) [c.state, c.tone] = [c.full ? "정원 마감" : "접수 마감", "gray"];
  else if (t === c.play_date) [c.state, c.tone] = ["오늘 대회", "live"];
  else [c.state, c.tone] = [c.results_open ? "결과 발표" : "대회 종료", "gray"];
  c.dday = c.can_apply ? dayDiff(c.close_date, t) : null;
  return c;
}

async function getComp(ctx: Ctx, db: DB, cid: number, admin = false) {
  const c = await db.one("SELECT * FROM comps WHERE id = ?", cid);
  if (!c || (c.hidden && !admin && !ctx.user?.is_admin)) abort(404);
  return decorate(db, c!);
}

/** 첫 화면용: 접수 중·예정이거나 곧 열릴 대회 */
export async function openComps(db: DB, limit = 6) {
  try {
    const rows = await db.all("SELECT * FROM comps WHERE hidden = 0 AND play_date >= ? ORDER BY play_date LIMIT ?", today(), limit);
    return Promise.all(rows.map((c) => decorate(db, c)));
  } catch { return []; }
}

const myEntry = (ctx: Ctx, db: DB, cid: number) =>
  ctx.user ? db.one("SELECT * FROM entries WHERE comp_id = ? AND user_id = ?", cid, ctx.user.id) : Promise.resolve(null);

function parseScores(s: any, n: number): (number | null)[] {
  const vals = String(s || "").split(",").map((x) => x.trim());
  return Array.from({ length: n }, (_, i) => (isDigits(vals[i] || "") ? parseInt(vals[i], 10) : null));
}

const cmpArr = (a: any[], b: any[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] ?? -1) - (b[i] ?? -1);
  return 0;
};

/** 부문별 순위표. 참가 확정자 중 타수를 모두 넣은 사람만, 동타면 마지막 코스부터 비교 (백카운트). */
async function ranked(db: DB, c: Row) {
  const rows = await db.all("SELECT * FROM entries WHERE comp_id = ? AND status = '입금확인'", c.id);
  const n = c.course_list.length;
  const extra = [...new Set(rows.map((r) => r.division))].filter((d) => !c.div_list.includes(d)).sort();
  const out = [];
  for (const d of [...c.div_list, ...extra]) {
    const done: Row[] = [], todo: Row[] = [];
    for (const r of rows) {
      if (r.division !== d) continue;
      r.score_list = parseScores(r.scores, n);
      (r.total != null ? done : todo).push(r);
    }
    const key = (r: Row) => [r.total, ...[...r.score_list].reverse()];
    done.sort((a, b) => cmpArr(key(a), key(b)));
    let prev: any[] | null = null, rank = 0;
    done.forEach((r, i) => {
      const k = key(r);
      if (!prev || cmpArr(k, prev) !== 0) { rank = i + 1; prev = k; }
      r.place = rank;
    });
    if (done.length || todo.length) out.push({ division: d, rows: done, todo });
  }
  return out;
}

async function groupsOf(db: DB, c: Row) {
  const rows = await db.all(`SELECT * FROM entries WHERE comp_id = ? AND group_no IS NOT NULL AND status IN (${ph(ACTIVE)})
    ORDER BY group_no, id`, c.id, ...ACTIVE);
  const out = new Map<number, Row>();
  for (const r of rows) {
    if (!out.has(r.group_no)) out.set(r.group_no, { no: r.group_no, spot: r.start_spot, time: r.tee_time, division: r.division, players: [] });
    out.get(r.group_no)!.players.push(r);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- 참가자 화면
export async function listPage(ctx: Ctx, db: DB) {
  const rows = await db.all("SELECT * FROM comps WHERE hidden = 0 ORDER BY play_date DESC LIMIT 60");
  const t = today();
  const items = await Promise.all(rows.map((c) => decorate(db, c)));
  const upcoming = items.filter((c) => c.play_date >= t).sort((a, b) => a.play_date.localeCompare(b.play_date));
  const past = items.filter((c) => c.play_date < t);
  const mine: Row = {};
  if (ctx.user) for (const e of await db.all("SELECT * FROM entries WHERE user_id = ?", ctx.user.id)) mine[e.comp_id] = e;
  return ctx.render("compete_list.html", { upcoming, past, mine });
}

export async function viewPage(ctx: Ctx, db: DB, cid: number) {
  const c = await getComp(ctx, db, cid);
  const lst = await db.all(`SELECT name, club, division, status FROM entries WHERE comp_id = ? AND status IN (${ph(ACTIVE)}) ORDER BY id`,
    cid, ...ACTIVE);
  const byDiv: Record<string, Row[]> = {};
  for (const e of lst) (byDiv[e.division] ??= []).push(e);
  return ctx.render("compete_view.html", {
    c, my: await myEntry(ctx, db, cid), by_div: byDiv, course: c.course_id ? courseById[c.course_id] || null : null,
    groups: c.groups_open ? await groupsOf(db, c) : [], results: c.results_open ? await ranked(db, c) : [],
  });
}

function cleanPhone(s: string) {
  const d = (s || "").replace(/\D/g, "");
  if (!/^01\d{8,9}$/.test(d)) return null;
  return `${d.slice(0, 3)}-${d.slice(3, -4)}-${d.slice(-4)}`;
}

export async function applyPage(ctx: Ctx, db: DB, cid: number) {
  const r0 = needLogin(ctx); if (r0) return r0;
  const c = await getComp(ctx, db, cid);
  const my = await myEntry(ctx, db, cid);
  const editing = !!my && ACTIVE.includes(my.status);
  if (!c.can_apply && !(editing && today() <= c.close_date)) {
    ctx.flash("지금은 이 대회에 신청할 수 없습니다.");
    return redirect(`/compete/${cid}`);
  }
  if (ctx.req.method === "POST") {
    const f = await ctx.req.formData();
    const form = Object.fromEntries([...f.keys()].map((k) => [k, fv(f, k)]));
    const name = fv(f, "name").replace(/\s+/g, "").slice(0, 30);
    const phone = cleanPhone(fv(f, "phone"));
    const gender = ["남", "여"].includes(fv(f, "gender")) ? fv(f, "gender") : null;
    const byS = fv(f, "birth_year");
    const by = isDigits(byS) && +byS >= 1920 && +byS <= 2015 ? +byS : null;
    const div = c.div_list.includes(fv(f, "division")) ? fv(f, "division") : null;
    const err = name.length < 2 ? "이름을 정확히 적어 주세요."
      : !phone ? "휴대폰 번호를 정확히 적어 주세요. (예: 010-1234-5678)"
      : !gender ? "성별을 골라 주세요."
      : !by ? "출생연도를 4자리로 적어 주세요. (예: 1958)"
      : !div ? "참가 부문을 골라 주세요."
      : !f.get("agree") ? "개인정보 수집·이용에 동의해 주셔야 신청할 수 있습니다." : null;
    if (err) {
      ctx.flash(err);
      return ctx.render("compete_apply.html", { c, my, form });
    }
    const club = fv(f, "club").replace(/\s+/g, " ").trim().slice(0, 60) || null;
    const memo = fv(f, "memo").trim().slice(0, 300) || null;
    if (my) {
      if (!editing) {  // 취소했던 신청을 다시 접수
        if (!c.can_apply) abort(400);
        await db.run(`UPDATE entries SET name=?, phone=?, gender=?, birth_year=?, club=?, division=?, memo=?, status='신청',
          group_no=NULL, start_spot=NULL, tee_time=NULL, scores=NULL, total=NULL, rank=NULL, paid_at=NULL, created_at=? WHERE id=?`,
          name, phone, gender, by, club, div, memo, now(), my.id);
      } else {
        await db.run("UPDATE entries SET name=?, phone=?, gender=?, birth_year=?, club=?, division=?, memo=? WHERE id=?",
          name, phone, gender, by, club, div, memo, my.id);
      }
    } else {
      await db.run(`INSERT INTO entries (comp_id, user_id, name, phone, gender, birth_year, club, division, memo, status, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'신청',?)`, cid, ctx.user!.id, name, phone, gender, by, club, div, memo, now());
    }
    ctx.flash(editing ? "신청 내용을 고쳤습니다." : c.fee
      ? "참가 신청이 접수되었습니다. 참가비를 입금하시면 주최 측 확인 후 '참가 확정'으로 바뀝니다."
      : "참가 신청이 접수되었습니다. 주최 측 확인 후 '참가 확정'으로 바뀝니다.");
    return redirect(`/compete/${cid}#my-entry`);
  }
  const form = my ? { ...my } : { name: "", division: c.div_list.length === 1 ? c.div_list[0] : "" };
  return ctx.render("compete_apply.html", { c, my, form });
}

export async function cancel(ctx: Ctx, db: DB, cid: number) {
  const r0 = needLogin(ctx); if (r0) return r0;
  const my = await myEntry(ctx, db, cid);
  if (!my || !ACTIVE.includes(my.status)) abort(400);
  // 입금 전이면 바로 취소, 입금 후면 환불이 필요하므로 '취소 요청'
  const st = my!.status === "신청" ? "취소" : "취소요청";
  await db.run("UPDATE entries SET status = ?, group_no = NULL, start_spot = NULL, tee_time = NULL WHERE id = ?", st, my!.id);
  ctx.flash(st === "취소" ? "신청을 취소했습니다." : "취소를 요청했습니다. 참가비 환불은 주최 측이 확인 후 연락드립니다.");
  return redirect(`/compete/${cid}`);
}

export async function printPage(ctx: Ctx, db: DB, cid: number, kind: string) {
  const c = await getComp(ctx, db, cid);
  const admin = !!ctx.user?.is_admin;
  if (kind === "groups" && (c.groups_open || admin)) return ctx.render("compete_print.html", { c, kind, groups: await groupsOf(db, c), admin });
  if (kind === "results" && (c.results_open || admin)) return ctx.render("compete_print.html", { c, kind, results: await ranked(db, c), admin });
  if (kind === "cards" && admin) return ctx.render("compete_print.html", { c, kind, groups: await groupsOf(db, c), admin });
  return abort(404);
}

// ---------------------------------------------------------------- 관리자: 대회 개설·관리
export async function adminList(ctx: Ctx, db: DB) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  const rows = await db.all("SELECT * FROM comps ORDER BY play_date DESC");
  return ctx.render("compete_admin.html", { items: await Promise.all(rows.map((c) => decorate(db, c))) });
}

const COMP_FIELDS = ["title", "venue", "play_date", "open_date", "close_date", "course_id", "host", "contact", "divisions", "fee",
  "pay_info", "capacity", "play_courses", "group_size", "start_time", "wave_gap", "format", "body", "hidden"];

export async function adminEdit(ctx: Ctx, db: DB, cid: number | null) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  let c = cid ? await db.one("SELECT * FROM comps WHERE id = ?", cid) : null;
  if (cid && !c) abort(404);
  if (ctx.req.method === "POST") {
    const f = await ctx.req.formData();
    const s = (k: string, n: number) => fv(f, k).trim().slice(0, n);
    const int = (k: string, d = 0) => parseInt(fv(f, k), 10) || d;
    const v: Row = {
      title: s("title", 120), venue: s("venue", 120), play_date: fv(f, "play_date"), open_date: fv(f, "open_date"),
      close_date: fv(f, "close_date"), course_id: s("course_id", 20) || null, host: s("host", 120) || null,
      contact: s("contact", 120) || null, divisions: splitList(fv(f, "divisions")).join(",").slice(0, 200),
      fee: Math.max(0, int("fee")), pay_info: s("pay_info", 300) || null, capacity: Math.max(0, int("capacity")),
      play_courses: splitList(fv(f, "play_courses")).map((x) => x.toUpperCase()).join(",").slice(0, 40) || "A",
      group_size: Math.min(6, Math.max(2, int("group_size", 4))), start_time: (fv(f, "start_time") || "08:00").slice(0, 5),
      wave_gap: Math.max(0, int("wave_gap")), format: s("format", 200) || null, body: s("body", 8000) || null,
      hidden: f.get("hidden") ? 1 : 0,
    };
    const dateOk = (x: string) => /^\d{4}-\d{2}-\d{2}$/.test(x);
    let bad = !v.title || !v.venue || !v.divisions || !["play_date", "open_date", "close_date"].every((k) => dateOk(v[k]))
      || !/^\d{2}:\d{2}$/.test(v.start_time);
    if (!bad && !(v.open_date <= v.close_date && v.close_date <= v.play_date)) {
      ctx.flash("날짜 순서를 확인해 주세요: 접수 시작 ≤ 접수 마감 ≤ 대회일");
      bad = true;
    }
    if (bad) {
      ctx.flash("대회 이름·장소·부문·날짜·출발 시각을 빠짐없이 바르게 적어 주세요.");
      return ctx.render("compete_edit.html", { c: { ...v, id: cid } });
    }
    const vals = COMP_FIELDS.map((k) => v[k]);
    if (cid) await db.run(`UPDATE comps SET ${COMP_FIELDS.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...vals, cid);
    else cid = (await db.one(`INSERT INTO comps (${COMP_FIELDS.join(", ")}, created_at) VALUES (${ph(COMP_FIELDS)}, ?) RETURNING id`,
      ...vals, now()))!.id;
    ctx.flash("대회 정보를 저장했습니다.");
    return redirect(`/admin/compete/${cid}`);
  }
  if (!c) c = { title: "", venue: "", play_date: "", open_date: today(), close_date: "", divisions: "남자부,여자부", fee: 20000,
    capacity: 0, play_courses: "A,B,C,D", group_size: 4, start_time: "08:00", wave_gap: 30,
    format: "36홀 스트로크 (4개 코스 × 9홀), 개인전", hidden: true };
  return ctx.render("compete_edit.html", { c });
}

export async function adminManage(ctx: Ctx, db: DB, cid: number) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  const c = await getComp(ctx, db, cid, true);
  const rows = await db.all(`SELECT e.*, u.nickname FROM entries e JOIN users u ON u.id = e.user_id WHERE e.comp_id = ?
    ORDER BY e.group_no IS NULL, e.group_no, e.division, e.id`, cid);
  for (const r of rows) r.score_list = parseScores(r.scores, c.course_list.length);
  const st = ctx.arg("status");
  const shown = rows.filter((r) => !st || r.status === st);
  return ctx.render("compete_manage.html", { c, rows: shown, all_count: rows.length, st, STATUS_ALL, results: await ranked(db, c) });
}

const back = (ctx: Ctx, cid: number) => redirect(`/admin/compete/${cid}?status=${encodeURIComponent(ctx.arg("status"))}#entries`);

export async function adminEntry(ctx: Ctx, db: DB, cid: number, eid: number, action: string) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  const e = await db.one("SELECT * FROM entries WHERE id = ? AND comp_id = ?", eid, cid);
  if (!e) abort(404);
  const sql: Record<string, [string, any[]]> = {
    paid: ["status = '입금확인', paid_at = ?", [now()]],
    unpaid: ["status = '신청', paid_at = NULL", []],
    cancel: ["status = '취소', group_no = NULL, start_spot = NULL, tee_time = NULL", []],
    restore: ["status = '신청'", []],
  };
  if (!sql[action]) abort(400);
  await db.run(`UPDATE entries SET ${sql[action][0]} WHERE id = ?`, ...sql[action][1], eid);
  if (action === "paid" && e!.status !== "입금확인") await addPoints(db, e!.user_id, "대회 참가");
  return back(ctx, cid);
}

export async function adminToggle(ctx: Ctx, db: DB, cid: number, field: string) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  if (!["closed", "groups_open", "results_open", "hidden"].includes(field)) abort(400);
  await db.run(`UPDATE comps SET ${field} = 1 - COALESCE(${field}, 0) WHERE id = ?`, cid);
  return redirect(`/admin/compete/${cid}`);
}

export async function adminDelete(ctx: Ctx, db: DB, cid: number) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  await db.batch([db.q("DELETE FROM entries WHERE comp_id = ?", cid), db.q("DELETE FROM comps WHERE id = ?", cid)]);
  ctx.flash("대회와 신청 자료를 모두 지웠습니다.");
  return redirect("/admin/compete");
}

/** 부문별로 조를 만든다. 같은 클럽 회원은 되도록 다른 조로 흩어지게, 조 인원은 고르게. */
function makeGroups(c: Row, players: Row[]) {
  const out: Row[][] = [];
  const extra = [...new Set(players.map((p) => p.division))].filter((d) => !c.div_list.includes(d)).sort();
  for (const d of [...c.div_list, ...extra]) {
    const ps = players.filter((p) => p.division === d);
    if (!ps.length) continue;
    const k = Math.ceil(ps.length / c.group_size);
    const clubKey = (p: Row) => p.club || `#${p.id}`;
    const clubN: Record<string, number> = {};
    for (const p of ps) clubN[clubKey(p)] = (clubN[clubKey(p)] || 0) + 1;
    ps.sort((a, b) => (clubN[clubKey(b)] - clubN[clubKey(a)]) || (a.club || "").localeCompare(b.club || "") || a.id - b.id);
    const grps: Row[][] = Array.from({ length: k }, () => []);
    ps.forEach((p, i) => grps[i % k].push(p));  // 큰 클럽부터 한 명씩 돌아가며 배치
    out.push(...grps);
  }
  return out;
}

/** idx 번째 조(0부터)의 출발 위치·시각. 모든 코스·홀에서 동시에 출발(샷건)하고, 자리가 모자라면 다음 순번. */
function spotAndTime(c: Row, idx: number): [string, string] {
  const slots = c.course_list.flatMap((course: string) => Array.from({ length: HOLES_PER_COURSE }, (_, h) => `${course}-${h + 1}`));
  const wave = Math.floor(idx / slots.length), slot = idx % slots.length;
  const [hh, mm] = c.start_time.split(":").map(Number);
  const m = hh * 60 + mm + wave * c.wave_gap;
  return [slots[slot], `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`];
}

export async function adminGroups(ctx: Ctx, db: DB, cid: number) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  const c = await getComp(ctx, db, cid, true);
  const f = await ctx.req.formData();
  const sts = f.get("only_paid") ? ["입금확인"] : ACTIVE;
  const players = await db.all(`SELECT * FROM entries WHERE comp_id = ? AND status IN (${ph(sts)})`, cid, ...sts);
  const grps = makeGroups(c, players);
  const stmts = [db.q("UPDATE entries SET group_no = NULL, start_spot = NULL, tee_time = NULL WHERE comp_id = ?", cid)];
  grps.forEach((grp, i) => {
    const [spot, tm] = spotAndTime(c, i);
    for (const p of grp) stmts.push(db.q("UPDATE entries SET group_no = ?, start_spot = ?, tee_time = ? WHERE id = ?", i + 1, spot, tm, p.id));
  });
  await db.batch(stmts);
  ctx.flash(`${players.length}명을 ${grps.length}개 조로 편성했습니다. 표에서 조·출발 위치를 직접 고칠 수도 있습니다.`);
  return redirect(`/admin/compete/${cid}#entries`);
}

/** 표에서 고친 조 번호·출발 위치·시각과 코스별 타수를 한꺼번에 저장 */
export async function adminSave(ctx: Ctx, db: DB, cid: number) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  const c = await getComp(ctx, db, cid, true);
  const n = c.course_list.length;
  const f = await ctx.req.formData();
  const ids = f.getAll("eid").map(String).filter(isDigits).map(Number);
  const stmts = ids.map((eid) => {
    const sc = Array.from({ length: n }, (_, i) => {
      const v = fv(f, `s_${eid}_${i}`).trim();
      return isDigits(v) && +v > 0 && +v < 200 ? +v : null;
    });
    const g = fv(f, `g_${eid}`).trim();
    return db.q("UPDATE entries SET group_no = ?, start_spot = ?, tee_time = ?, scores = ?, total = ? WHERE id = ? AND comp_id = ?",
      isDigits(g) ? +g : null, fv(f, `spot_${eid}`).trim().slice(0, 10) || null, fv(f, `time_${eid}`).trim().slice(0, 5) || null,
      sc.some((s) => s != null) ? sc.map((s) => (s == null ? "" : String(s))).join(",") : null,
      sc.every((s) => s != null) ? sc.reduce((a, b) => a! + b!, 0) : null, eid, cid);
  });
  await db.batch(stmts);
  ctx.flash("저장했습니다.");
  return back(ctx, cid);
}

export async function adminCsv(ctx: Ctx, db: DB, cid: number) {
  const r0 = needAdmin(ctx); if (r0) return r0;
  const c = await getComp(ctx, db, cid, true);
  const rows = await db.all("SELECT * FROM entries WHERE comp_id = ? ORDER BY id", cid);
  const cell = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [["접수번호", "이름", "휴대폰", "성별", "출생연도", "소속", "부문", "상태", "조", "출발", "시각",
    ...c.course_list.map((x: string) => `${x}코스`), "합계", "요청사항", "신청일", "입금확인일"]];
  for (const r of rows) lines.push([r.id, r.name, r.phone, r.gender, r.birth_year, r.club || "", r.division, r.status,
    r.group_no || "", r.start_spot || "", r.tee_time || "", ...parseScores(r.scores, c.course_list.length).map((s) => s ?? ""),
    r.total ?? "", r.memo || "", r.created_at, r.paid_at || ""]);
  const data = "﻿" + lines.map((l) => l.map(cell).join(",")).join("\r\n") + "\r\n";  // 엑셀에서 한글이 깨지지 않도록
  return new Response(data, { headers: { "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename=entries_${cid}.csv` } });
}

export { json };
