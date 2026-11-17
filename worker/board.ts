// 게시판: 구장 후기·사진·이야기, 사진 첨부, 댓글, 이모티콘 공감, 신고.
// 사진은 휴대폰(브라우저)에서 미리 줄여 JPEG 로 보낸다 (서버는 무료 요금제 계산 한도 10ms 라 사진 처리를 못 함).
// 줄일 때 사진 속 위치(GPS) 등 부가 정보는 빠진다. 사진 파일은 KV(PHOTOS), 크기 정보는 D1 images 표.
import { DB } from "./db";
import { abort, CATEGORIES, courseById, courses, Ctx, gradeOf, json, now, redirect, Row } from "./lib";
import { addPoints, needLogin } from "./members";

const PAGE = 20;
const MAX_PHOTOS = 4;
const MAX_FULL = 1_500_000, MAX_THUMB = 300_000;  // 줄인 사진 크기 한도 (바이트)
const HIDE_AFTER_REPORTS = 3;
export const REACTIONS: [string, string][] = [["👍", "좋아요"], ["❤️", "공감"], ["😂", "웃겨요"], ["👏", "대단해요"], ["⛳", "굿샷"]];
const fv = (f: FormData, k: string) => String(f.get(k) ?? "");
const isCat = (k: string) => Object.prototype.hasOwnProperty.call(CATEGORIES, k);
const ph = (a: any[]) => a.map(() => "?").join(",");

const POST_SQL = `SELECT p.*, u.nickname, u.earned FROM posts p JOIN users u ON u.id = p.user_id`;
const withGrade = (r: Row) => ({ ...r, grade: gradeOf(r.earned) });

async function firstImages(db: DB, ids: number[]) {
  if (!ids.length) return {};
  const rows = await db.all(`SELECT post_id, MIN(id) AS img FROM images WHERE post_id IN (${ph(ids)}) GROUP BY post_id`, ...ids);
  return Object.fromEntries(rows.map((r) => [r.post_id, r.img]));
}

// ---------------------------------------------------------------- 목록
export async function boardPage(ctx: Ctx, db: DB) {
  const cat = isCat(ctx.arg("cat")) ? ctx.arg("cat") : "";
  const q = ctx.arg("q").trim().slice(0, 40);
  const cid = ctx.arg("course");
  const course = cid ? courseById[cid] || null : null;
  const page = Math.max(1, parseInt(ctx.arg("page"), 10) || 1);
  const cond = ["p.hidden = 0"], args: any[] = [];
  if (cat) { cond.push("p.category = ?"); args.push(cat); }
  if (course) { cond.push("p.course_id = ?"); args.push(course.id); }
  if (q) { cond.push("(p.title LIKE ? OR p.body LIKE ?)"); args.push(`%${q}%`, `%${q}%`); }
  const where = cond.join(" AND ");
  const [total, rows, catRows, photos] = await Promise.all([
    db.val(`SELECT COUNT(*) FROM posts p WHERE ${where}`, ...args),
    db.all(`${POST_SQL} WHERE ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`, ...args, PAGE, (page - 1) * PAGE),
    // 분류별 글 수 (분류 카드에 표시)
    course ? db.all("SELECT category, COUNT(*) AS n FROM posts WHERE hidden = 0 AND course_id = ? GROUP BY category", course.id)
      : db.all("SELECT category, COUNT(*) AS n FROM posts WHERE hidden = 0 GROUP BY category"),
    // 첫 화면의 '최근 사진' 줄
    !cat && !q && page === 1
      ? db.all(`SELECT i.id, i.post_id, p.title FROM images i JOIN posts p ON p.id = i.post_id WHERE p.hidden = 0
          ${course ? "AND p.course_id = ?" : ""} ORDER BY i.id DESC LIMIT 8`, ...(course ? [course.id] : []))
      : Promise.resolve([]),
  ]);
  const catCounts: Row = Object.fromEntries(catRows.map((r) => [r.category, r.n]));
  catCounts.all = catRows.reduce((s, r) => s + r.n, 0);
  const excerpt = (s: string) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > 70 ? t.slice(0, 70) + "…" : t; };
  const qs = (n: number) => new URLSearchParams({ ...(cat && { cat }), ...(q && { q }), ...(course && { course: course.id }), page: String(n) }).toString();
  return ctx.render("board.html", {
    rows: rows.map((r) => ({ ...withGrade(r), excerpt: excerpt(r.body) })), cat, q, course, page,
    pages: Math.max(1, Math.ceil(total / PAGE)), total, cat_counts: catCounts, photos,
    first_img: await firstImages(db, rows.map((r) => r.id)), byid: courseById, qs,
    write_url: `/board/write?${new URLSearchParams({ ...(cat && { cat }), ...(course && { course: course.id }) })}`,
  });
}

// ---------------------------------------------------------------- 글 보기
export async function viewPage(ctx: Ctx, db: DB, pid: number) {
  const p = await db.one(`${POST_SQL} WHERE p.id = ?`, pid);
  const me = ctx.user;
  if (!p || (p.hidden && !(me && (me.is_admin || me.id === p.user_id)))) abort(404);
  const seen: number[] = ctx.session.seen || [];
  if (!seen.includes(pid)) {  // 같은 사람이 새로고침해도 조회수는 한 번만
    await db.run("UPDATE posts SET views = views + 1 WHERE id = ?", pid);
    ctx.set("seen", [...seen, pid].slice(-30));
    p!.views += 1;
  }
  const [imgs, cmts, reacts, mine] = await Promise.all([
    db.all("SELECT id, width, height FROM images WHERE post_id = ? ORDER BY id", pid),
    db.all(`SELECT c.*, u.nickname, u.earned FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id`, pid),
    db.all("SELECT emoji, COUNT(*) AS n FROM reactions WHERE post_id = ? GROUP BY emoji", pid),
    me ? db.all("SELECT emoji FROM reactions WHERE post_id = ? AND user_id = ?", pid, me.id) : Promise.resolve([]),
  ]);
  const counts = Object.fromEntries(reacts.map((r) => [r.emoji, r.n]));
  const myset = new Set(mine.map((r) => r.emoji));
  return ctx.render("post.html", {
    p: withGrade(p!), imgs, cmts: cmts.map(withGrade), course: p!.course_id ? courseById[p!.course_id] || null : null,
    reactions: REACTIONS.map(([e, label], i) => ({ i, e, label, n: counts[e] || 0, on: myset.has(e) })),
    can_edit: !!me && (me.id === p!.user_id || me.is_admin),
  });
}

// ---------------------------------------------------------------- 글쓰기·고치기
type Pic = { full: ArrayBuffer; thumb: ArrayBuffer; w: number; h: number };
const isJpeg = (b: ArrayBuffer) => { const u = new Uint8Array(b, 0, 3); return u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff; };

async function readPics(f: FormData): Promise<Pic[]> {
  const fulls = f.getAll("photo").filter((x) => typeof x !== "string") as File[];
  const thumbs = f.getAll("thumb").filter((x) => typeof x !== "string") as File[];
  const sizes = f.getAll("size").map(String);
  const out: Pic[] = [];
  for (let i = 0; i < Math.min(fulls.length, MAX_PHOTOS); i++) {
    const full = await fulls[i].arrayBuffer(), thumb = await (thumbs[i] || fulls[i]).arrayBuffer();
    if (!full.byteLength) continue;
    if (!isJpeg(full) || !isJpeg(thumb)) throw new Error("사진 파일만 올릴 수 있습니다.");
    if (full.byteLength > MAX_FULL || thumb.byteLength > MAX_THUMB) throw new Error("사진이 너무 큽니다. 다시 골라 주세요.");
    const [w, h] = (sizes[i] || "").split("x").map((n) => Math.min(4000, parseInt(n, 10) || 0));
    out.push({ full, thumb, w: w || 0, h: h || 0 });
  }
  return out;
}

async function savePics(ctx: Ctx, db: DB, pid: number, pics: Pic[]) {
  for (const p of pics) {
    const r = await db.one("INSERT INTO images (post_id, width, height, created_at) VALUES (?, ?, ?, ?) RETURNING id", pid, p.w || null, p.h || null, now());
    await Promise.all([
      ctx.env.PHOTOS.put(`img/${r!.id}/full`, p.full, { metadata: { post: pid } }),
      ctx.env.PHOTOS.put(`img/${r!.id}/thumb`, p.thumb, { metadata: { post: pid } }),
    ]);
  }
}

async function dropPics(ctx: Ctx, ids: number[]) {
  await Promise.all(ids.flatMap((id) => [ctx.env.PHOTOS.delete(`img/${id}/full`), ctx.env.PHOTOS.delete(`img/${id}/thumb`)]));
}

export async function writePage(ctx: Ctx, db: DB, pid: number | null) {
  const r0 = needLogin(ctx); if (r0) return r0;
  const me = ctx.user!;
  const old = pid ? await db.one("SELECT * FROM posts WHERE id = ?", pid) : null;
  if (pid && (!old || (old.user_id !== me.id && !me.is_admin))) abort(403);
  if (ctx.req.method === "GET") {
    const cid = ctx.arg("course") || old?.course_id || "";
    const cat = (isCat(ctx.arg("cat")) ? ctx.arg("cat") : "") || old?.category || "review";
    return ctx.render("write.html", {
      old, cat, course: cid ? courseById[cid] || null : null,
      old_imgs: old ? await db.all("SELECT id FROM images WHERE post_id = ? ORDER BY id", pid) : [],
      course_names: [...new Set(courses.map((c) => c.name))].sort(),
    });
  }
  const f = await ctx.req.formData();
  // 사진을 줄여 보내는 글쓰기 화면은 fetch 로 보냄 → 이동할 주소를 JSON 으로 알려 준다 (알림 문구가 미리 소비되지 않게)
  const go = (to: string) => (ctx.req.headers.get("x-requested-with") === "fetch" ? json({ redirect: to }) : redirect(to));
  const back = (msg: string) => { ctx.flash(msg); return go(ctx.fullPath); };
  const title = fv(f, "title").trim().slice(0, 100), body = fv(f, "body").trim().slice(0, 5000);
  const cat = isCat(fv(f, "category")) ? fv(f, "category") : "free";
  if (title.length < 2 || body.length < 2) return back("제목과 내용을 적어 주세요.");
  if (!old) {
    const last = await db.val("SELECT MAX(created_at) FROM posts WHERE user_id = ?", me.id);
    if (last && Date.now() - Date.parse(last.replace(" ", "T") + "+09:00") < 30_000) return back("글은 30초에 한 번 쓸 수 있습니다.");
  }
  // 구장 연결: 구장 번호 또는 구장 이름
  let cid: string | null = fv(f, "course_id") || null;
  if (!cid && fv(f, "course_name").trim()) cid = courses.find((c) => c.name === fv(f, "course_name").trim())?.id || null;
  if (cid && !courseById[cid]) cid = null;
  let pics: Pic[];
  try { pics = await readPics(f); } catch (e) { return back((e as Error).message); }

  if (old) {
    const keep = new Set(f.getAll("keep_img").map((x) => parseInt(String(x), 10)));
    const have = (await db.all("SELECT id FROM images WHERE post_id = ?", pid)).map((r) => r.id as number);
    const drop = have.filter((i) => !keep.has(i));
    if (drop.length) {
      await db.run(`DELETE FROM images WHERE id IN (${ph(drop)})`, ...drop);
      await dropPics(ctx, drop);
    }
    pics = pics.slice(0, Math.max(0, MAX_PHOTOS - (have.length - drop.length)));
    await savePics(ctx, db, pid!, pics);
    await db.run("UPDATE posts SET title = ?, body = ?, category = ?, course_id = ?, updated_at = ?, photos = ? WHERE id = ?",
      title, body, cat, cid, now(), have.length - drop.length + pics.length, pid);
    ctx.flash("글을 고쳤습니다.");
    return go(`/board/${pid}`);
  }
  const r = await db.one(`INSERT INTO posts (user_id, category, title, body, course_id, photos, views, likes, comments, hidden, reports, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?) RETURNING id`, me.id, cat, title, body, cid, pics.length, now());
  await savePics(ctx, db, r!.id, pics);
  const got = (await addPoints(db, me.id, "글쓰기")) + (pics.length ? await addPoints(db, me.id, "사진 올리기") : 0);
  ctx.flash(got ? `글을 올렸습니다. ${got}포인트를 드렸습니다.` : "글을 올렸습니다.");
  return go(`/board/${r!.id}`);
}

export async function deletePost(ctx: Ctx, db: DB, pid: number) {
  const r0 = needLogin(ctx); if (r0) return r0;
  const p = await db.one("SELECT * FROM posts WHERE id = ?", pid);
  if (!p || (p.user_id !== ctx.user!.id && !ctx.user!.is_admin)) abort(403);
  await deletePostsData(ctx, db, [pid]);
  ctx.flash("글을 지웠습니다.");
  return redirect(`/board?cat=${p!.category}`);
}

/** 글 여러 개와 딸린 사진·댓글·공감을 지운다 (탈퇴 때도 씀) */
export async function deletePostsData(ctx: Ctx, db: DB, pids: number[]) {
  if (!pids.length) return;
  const imgs = (await db.all(`SELECT id FROM images WHERE post_id IN (${ph(pids)})`, ...pids)).map((r) => r.id as number);
  await db.batch(["images", "comments", "reactions", "likes"].map((t) => db.q(`DELETE FROM ${t} WHERE post_id IN (${ph(pids)})`, ...pids))
    .concat(db.q(`DELETE FROM posts WHERE id IN (${ph(pids)})`, ...pids)));
  await dropPics(ctx, imgs);
}

// ---------------------------------------------------------------- 댓글·공감·신고
export async function addComment(ctx: Ctx, db: DB, pid: number) {
  const r0 = needLogin(ctx); if (r0) return r0;
  const f = await ctx.req.formData();
  const body = fv(f, "body").trim().slice(0, 1000);
  if (body && await db.one("SELECT 1 FROM posts WHERE id = ?", pid)) {
    await db.batch([
      db.q("INSERT INTO comments (post_id, user_id, body, hidden, created_at) VALUES (?, ?, ?, 0, ?)", pid, ctx.user!.id, body, now()),
      db.q("UPDATE posts SET comments = comments + 1 WHERE id = ?", pid),
    ]);
    await addPoints(db, ctx.user!.id, "댓글");
  }
  return redirect(`/board/${pid}#comments`);
}

export async function deleteComment(ctx: Ctx, db: DB, cid: number) {
  const r0 = needLogin(ctx); if (r0) return r0;
  const c = await db.one("SELECT * FROM comments WHERE id = ?", cid);
  if (!c || (c.user_id !== ctx.user!.id && !ctx.user!.is_admin)) abort(403);
  await db.batch([db.q("DELETE FROM comments WHERE id = ?", cid),
    db.q("UPDATE posts SET comments = MAX(0, comments - 1) WHERE id = ?", c!.post_id)]);
  return redirect(`/board/${c!.post_id}#comments`);
}

/** 이모티콘 공감: 누르면 켜고, 다시 누르면 끈다. 글 목록의 '공감 수'는 posts.likes */
export async function react(ctx: Ctx, db: DB, pid: number, idx: number) {
  const r0 = needLogin(ctx); if (r0) return r0;
  const emo = REACTIONS[idx]?.[0];
  const p = await db.one("SELECT id, user_id FROM posts WHERE id = ?", pid);
  if (!emo || !p) abort(404);
  const uid = ctx.user!.id;
  const had = await db.one("SELECT 1 FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?", pid, uid, emo);
  if (had) {
    await db.batch([db.q("DELETE FROM reactions WHERE post_id = ? AND user_id = ? AND emoji = ?", pid, uid, emo),
      db.q("UPDATE posts SET likes = MAX(0, likes - 1) WHERE id = ?", pid)]);
  } else {
    const first = !(await db.one("SELECT 1 FROM reactions WHERE post_id = ? AND user_id = ?", pid, uid));
    await db.batch([db.q("INSERT OR IGNORE INTO reactions (post_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)", pid, uid, emo, now()),
      db.q("UPDATE posts SET likes = likes + 1 WHERE id = ?", pid)]);
    if (first && p!.user_id !== uid) await addPoints(db, p!.user_id, "공감 받음");
  }
  if ((ctx.req.headers.get("accept") || "").includes("application/json")) {
    const rows = await db.all("SELECT emoji, COUNT(*) AS n FROM reactions WHERE post_id = ? GROUP BY emoji", pid);
    return json({ on: !had, counts: Object.fromEntries(rows.map((r) => [r.emoji, r.n])) });
  }
  return redirect(`/board/${pid}#react`);
}

export async function report(ctx: Ctx, db: DB, kind: string, tid: number) {
  const r0 = needLogin(ctx); if (r0) return r0;
  if (kind !== "post" && kind !== "comment") abort(404);
  const t = kind === "post" ? "posts" : "comments";
  const target = await db.one(`SELECT * FROM ${t} WHERE id = ?`, tid);
  if (!target) abort(404);
  const f = await ctx.req.formData();
  const uid = ctx.user!.id;
  if (await db.one("SELECT 1 FROM reports WHERE kind = ? AND target_id = ? AND user_id = ?", kind, tid, uid)) {
    ctx.flash("이미 신고하셨습니다.");
  } else {
    await db.run("INSERT INTO reports (kind, target_id, user_id, reason, done, created_at) VALUES (?, ?, ?, ?, 0, ?)",
      kind, tid, uid, fv(f, "reason").slice(0, 200), now());
    const n = await db.val("SELECT COUNT(*) FROM reports WHERE kind = ? AND target_id = ?", kind, tid);
    if (kind === "post") {
      await db.run("UPDATE posts SET reports = ?, hidden = CASE WHEN ? >= ? THEN 1 ELSE hidden END WHERE id = ?", n, n, HIDE_AFTER_REPORTS, tid);
    } else if (n >= HIDE_AFTER_REPORTS) {
      await db.run("UPDATE comments SET hidden = 1 WHERE id = ?", tid);  // 신고가 쌓이면 운영자 확인 전까지 숨김
    }
    ctx.flash("신고가 접수되었습니다. 운영자가 확인하겠습니다.");
  }
  return redirect(`/board/${kind === "post" ? tid : target!.post_id}`);
}

// ---------------------------------------------------------------- 사진 보내기
export async function image(ctx: Ctx, db: DB, iid: number, size: string) {
  const r = await db.one("SELECT p.hidden, p.user_id FROM images i JOIN posts p ON p.id = i.post_id WHERE i.id = ?", iid);
  if (!r) abort(404);
  if (r!.hidden && !(ctx.user && (ctx.user.is_admin || ctx.user.id === r!.user_id))) abort(404);  // 숨긴 글의 사진은 작성자·관리자만
  const data = await ctx.env.PHOTOS.get(`img/${iid}/${size === "thumb" ? "thumb" : "full"}`, "arrayBuffer");
  if (!data) abort(404);
  return new Response(data, { headers: { "content-type": "image/jpeg",
    "cache-control": r!.hidden ? "private, max-age=3600" : "public, max-age=31536000, immutable" } });
}

// ---------------------------------------------------------------- 구장 상세·첫 화면용
export async function coursePosts(ctx: Ctx, db: DB, cid: string) {
  const [fav, rows] = await Promise.all([
    ctx.user ? db.one("SELECT 1 FROM favorites WHERE user_id = ? AND course_id = ?", ctx.user.id, cid) : Promise.resolve(null),
    db.all(`${POST_SQL} WHERE p.course_id = ? AND p.hidden = 0 ORDER BY p.id DESC LIMIT 5`, cid),
  ]);
  const imgs = await firstImages(db, rows.map((r) => r.id));
  const total = rows.length < 5 ? rows.length : await db.val("SELECT COUNT(*) FROM posts WHERE course_id = ? AND hidden = 0", cid);
  return json({ enabled: true, favorite: !!fav, login: !!ctx.user, total,
    items: rows.map((p) => ({ id: p.id, title: p.title, nickname: p.nickname, date: String(p.created_at).slice(0, 10),
      photos: p.photos, comments: p.comments, likes: p.likes, img: (imgs as Row)[p.id] || null })) });
}
