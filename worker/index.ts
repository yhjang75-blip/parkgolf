// 나이스파크 — Cloudflare Workers (무료 요금제) 서버.
//
// - 구장 자료·화면 꾸밈 파일(public/)은 Cloudflare 가 직접 내보냄 (무료·무제한, 이 코드까지 오지 않음)
// - 이 코드는 화면(HTML)·회원·대회·날씨·뉴스 요청만 처리
// - 회원·대회 자료는 D1 데이터베이스(binding: DB)에 보관
import * as compete from "./compete";
import { openDb, schemaLost, secretKey } from "./db";
import * as feeds from "./feeds";
import { abort, Ctx, Env, HttpError, json, loadSession, redirect, saveSession } from "./lib";
import * as m from "./members";

type Handler = (ctx: Ctx, db: any, p: string[]) => Promise<Response> | Response;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp("^" + path.replace(/:int/g, "(\\d+)").replace(/:str/g, "([^/]+)") + "$"), h]);
const n = (s: string) => parseInt(s, 10);

// ---------------------------------------------------------------- 공개 화면
on("GET", "/", async (ctx, db) => ctx.render("index.html", { open_comps: await compete.openComps(db) }));
on("GET", "/score", (ctx) => ctx.render("score.html"));
on("GET", "/tournament", (ctx) => feeds.tournamentPage(ctx));
on("GET", "/terms", (ctx) => ctx.render("terms.html"));
on("GET", "/privacy", (ctx) => ctx.render("privacy.html"));
on("GET", "/benefits", (ctx, db) => m.benefitsPage(ctx, db));
on("GET", "/favicon.ico", () => new Response(null, { status: 204 }));
on("GET", "/healthz", () => new Response("ok"));

// ---------------------------------------------------------------- 자료 (구장 자료는 정적 파일을 그대로 넘김)
const asset = (ctx: Ctx, path: string) => ctx.env.ASSETS.fetch(new Request(new URL(path, ctx.url.origin)));
on("GET", "/api/courses", (ctx) => asset(ctx, "/data/courses.json"));
on("GET", "/api/meta", (ctx) => asset(ctx, "/data/meta.json"));
on("GET", "/api/courses/:str", async (ctx, _db, [cid]) => {
  const r = await asset(ctx, `/data/course/${encodeURIComponent(cid)}.json`);
  return r.ok ? r : abort(404);
});
on("GET", "/api/courses/:str/posts", (ctx, db, [cid]) => m.apiCoursePosts(ctx, db, cid));
on("GET", "/api/weather/:str", (ctx, db, [cid]) => feeds.weather(ctx, db, cid));
on("GET", "/api/news", (ctx, db) => feeds.news(ctx, db));
on("GET", "/api/videos", (ctx, db) => feeds.videos(ctx, db));
on("GET", "/api/tournaments", () => feeds.tournamentsApi());
on("GET", "/status", async (ctx, db) => json({
  "데이터베이스": `연결됨 (Cloudflare D1, 회원 ${await db.val("SELECT COUNT(*) FROM users")}명)`, "회원기능": true,
  "로그인방식": "아이디·비밀번호", "관리자지정": !!(ctx.env.ADMIN_IDS || ctx.env.ADMIN_KAKAO_IDS),
  "로그인비밀값": ctx.env.SECRET_KEY ? "직접 입력함" : "자동 생성됨", "서버": "Cloudflare Workers (무료)",
}));

// ---------------------------------------------------------------- 회원
on("GET|POST", "/login", (ctx, db) => m.login(ctx, db));
on("GET|POST", "/join", (ctx, db) => m.signup(ctx, db));
on("POST", "/me/password", (ctx, db) => m.changePassword(ctx, db));
on("POST", "/admin/user/:int/resetpw", (ctx, db, [u]) => m.adminResetPw(ctx, db, n(u)));
on("GET", "/auth/kakao", (ctx) => m.kakaoStart(ctx));
on("GET", "/auth/kakao/callback", (ctx, db) => m.kakaoCallback(ctx, db));
on("GET", "/auth/dev", (ctx, db) => m.devLoginRoute(ctx, db));
on("GET|POST", "/join/agree", (ctx, db) => m.agree(ctx, db));
on("POST", "/logout", (ctx) => m.logout(ctx));
on("GET|POST", "/me", (ctx, db) => m.mePage(ctx, db));
on("POST", "/me/withdraw", (ctx, db) => m.withdraw(ctx, db));
on("GET", "/api/me", (ctx, db) => m.apiMe(ctx, db));
on("POST", "/api/me/favorites/:str", (ctx, db, [cid]) => m.toggleFav(ctx, db, cid));
on("POST", "/benefits/:int/redeem", (ctx, db, [b]) => m.redeem(ctx, db, n(b)));
on("GET", "/admin", (ctx, db) => m.adminPage(ctx, db));
on("POST", "/admin/benefit", (ctx, db) => m.adminBenefit(ctx, db));
on("POST", "/admin/redemption/:int/:str", (ctx, db, [r, a]) => m.adminRedemption(ctx, db, n(r), a));
on("POST", "/admin/post/:int/:str", (ctx, db, [p, a]) => m.adminPost(ctx, db, n(p), a));
on("POST", "/admin/report/:int/done", (ctx, db, [r]) => m.adminReportDone(ctx, db, n(r)));
on("POST", "/admin/user/:int/ban", (ctx, db, [u]) => m.adminBan(ctx, db, n(u)));

// ---------------------------------------------------------------- 대회 참가
on("GET", "/compete", (ctx, db) => compete.listPage(ctx, db));
on("GET", "/compete/:int", (ctx, db, [c]) => compete.viewPage(ctx, db, n(c)));
on("GET|POST", "/compete/:int/apply", (ctx, db, [c]) => compete.applyPage(ctx, db, n(c)));
on("POST", "/compete/:int/cancel", (ctx, db, [c]) => compete.cancel(ctx, db, n(c)));
on("GET", "/compete/:int/print/:str", (ctx, db, [c, k]) => compete.printPage(ctx, db, n(c), k));
on("GET", "/admin/compete", (ctx, db) => compete.adminList(ctx, db));
on("GET|POST", "/admin/compete/new", (ctx, db) => compete.adminEdit(ctx, db, null));
on("GET|POST", "/admin/compete/:int/edit", (ctx, db, [c]) => compete.adminEdit(ctx, db, n(c)));
on("GET", "/admin/compete/:int", (ctx, db, [c]) => compete.adminManage(ctx, db, n(c)));
on("POST", "/admin/compete/:int/entry/:int/:str", (ctx, db, [c, e, a]) => compete.adminEntry(ctx, db, n(c), n(e), a));
on("POST", "/admin/compete/:int/toggle/:str", (ctx, db, [c, f]) => compete.adminToggle(ctx, db, n(c), f));
on("POST", "/admin/compete/:int/delete", (ctx, db, [c]) => compete.adminDelete(ctx, db, n(c)));
on("POST", "/admin/compete/:int/groups", (ctx, db, [c]) => compete.adminGroups(ctx, db, n(c)));
on("POST", "/admin/compete/:int/save", (ctx, db, [c]) => compete.adminSave(ctx, db, n(c)));
on("GET", "/admin/compete/:int/csv", (ctx, db, [c]) => compete.adminCsv(ctx, db, n(c)));

// 회원 정보가 필요 없는 요청 (빠르게)
const NO_USER = /^\/(api\/(courses$|meta$|weather\/|news$|videos$|tournaments$)|healthz$|favicon\.ico$|api\/courses\/[^/]+$)/;

const ERR: Record<number, [string, string]> = {
  400: ["잘못된 요청", "요청을 처리할 수 없습니다. 새로고침 후 다시 시도해 주세요."],
  403: ["권한 없음", "이 화면은 관리자만 볼 수 있습니다."],
  404: ["페이지를 찾을 수 없습니다", "주소가 바뀌었거나 없는 페이지입니다."],
  405: ["잘못된 요청", "이 주소에서는 할 수 없는 요청입니다."],
};

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const ctx = new Ctx(req, env, exec);
    let matched: [Handler, string[]] | null = null, wrongMethod = false;
    for (const [method, re, h] of routes) {
      const mm = ctx.path.match(re);
      if (!mm) continue;
      if (!method.split("|").includes(req.method === "HEAD" ? "GET" : req.method)) { wrongMethod = true; continue; }
      matched = [h, mm.slice(1).map(decodeURIComponent)];
      break;
    }
    // 예전 주소: 게시판은 닫혀 있음
    if (!matched) {
      const [t, msg] = ERR[wrongMethod ? 405 : 404];
      if (ctx.path.startsWith("/api/")) return json({ error: t }, wrongMethod ? 405 : 404);
      return ctx.render("notice.html", { title: t, msg }, wrongMethod ? 405 : 404);
    }
    let db: any = null, secret = "";
    try {
      db = await openDb(env);
      if (!NO_USER.test(ctx.path)) {
        secret = await secretKey(env, db);
        await loadSession(ctx, secret);
        // 위조 요청 막기: 글을 보내는(POST) 요청은 화면에 심어 둔 확인값이 맞아야 한다
        if (req.method === "POST") {
          let token = req.headers.get("X-CSRF");
          if (!token && (req.headers.get("content-type") || "").match(/form/)) token = String((await req.clone().formData()).get("csrf") || "");
          if (!token || token !== ctx.session.csrf) abort(400, "보안 확인값이 맞지 않습니다. 새로고침 후 다시 시도해 주세요.");
        }
        await m.loadUser(ctx, db);
      }
      const resp = await matched[0](ctx, db, matched[1]);
      return secret ? await saveSession(ctx, secret, resp) : resp;
    } catch (e) {
      let status = 500, t = "잠시 문제가 생겼습니다", msg = "잠시 후 다시 시도해 주세요.";
      if (e instanceof HttpError) {
        status = e.status;
        [t, msg] = ERR[status] || [t, msg];
        if (e.message) msg = e.message;
      } else {
        schemaLost(e);
        console.error("error", ctx.path, String((e as Error)?.stack || e));
      }
      if (ctx.path.startsWith("/api/")) return json({ error: msg }, status);
      const resp = ctx.render("notice.html", { title: t, msg }, status);
      return secret ? await saveSession(ctx, secret, resp) : resp;
    }
  },
  /** 20분마다: 뉴스·영상 미리 받아 두기 (wrangler.jsonc triggers.crons) */
  async scheduled(_ev: ScheduledController, env: Env, exec: ExecutionContext) {
    exec.waitUntil(openDb(env).then((db) => feeds.refreshFeeds(db)));
  },
} satisfies ExportedHandler<Env>;

void redirect;
