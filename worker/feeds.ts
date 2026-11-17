// 바깥 자료: 날씨(Open-Meteo), 뉴스(구글 뉴스 RSS), 영상(유튜브 RSS), 대회 일정(data/media.json).
import MEDIA from "../data/media.json";
import { cached, DB } from "./db";
import { abort, courseById, courses, Ctx, dayDiff, fmtKst, json, Row, today } from "./lib";

const media: Row = MEDIA as Row;
const UA = { "User-Agent": "Mozilla/5.0 (parkgolf-map)" };
const NEWS_TTL = 30 * 60, VIDEO_TTL = 60 * 60, WEATHER_TTL = 30 * 60;

// ---------------------------------------------------------------- 날씨
export async function weather(ctx: Ctx, db: DB, cid: string) {
  const c = courseById[cid];
  if (!c || c.lat == null) return json({ error: "위치 정보가 없어 날씨를 조회할 수 없습니다." }, 404);
  const out = await cached(db, `weather:${cid}`, WEATHER_TTL, async () => {
    const p = new URLSearchParams({
      latitude: String(c.lat), longitude: String(c.lng), timezone: "Asia/Seoul",
      current: "temperature_2m,precipitation,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      forecast_days: "3", wind_speed_unit: "ms",
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(String(r.status));
    const j: Row = await r.json();
    return { current: j.current, daily: j.daily, source: "Open-Meteo", fetched: fmtKst(Date.now()) };
  });
  return out ? json(out) : json({ error: "날씨 정보를 잠시 가져올 수 없습니다." }, 502);
}

// ---------------------------------------------------------------- 주변 관광지·숙소·음식점 (한국관광공사 TourAPI)
// 비밀값 TOUR_API_KEY = 공공데이터포털 '한국관광공사_국문 관광정보 서비스_GW' 일반 인증키 (Decoding).
// 구장마다 7일 동안 보관 (관광 정보는 자주 바뀌지 않고, 개발용 키는 하루 1,000건까지라서).
const NEARBY_TTL = 7 * 86400;
const NEARBY_TYPES: [string, string][] = [["tour", "12"], ["stay", "32"], ["food", "39"]];  // 관광지·숙박·음식점

async function tourList(key: string, lat: number, lng: number, typeId: string) {
  const p = new URLSearchParams({ serviceKey: key, MobileOS: "ETC", MobileApp: "nicepark", _type: "json",
    mapX: String(lng), mapY: String(lat), radius: "10000", contentTypeId: typeId, arrange: "E", numOfRows: "6", pageNo: "1" });
  const r = await fetch(`https://apis.data.go.kr/B551011/KorService2/locationBasedList2?${p}`, { signal: AbortSignal.timeout(8000) });
  const text = await r.text();
  if (!r.ok || !text.trim().startsWith("{")) throw new Error(`tourapi ${r.status} ${text.slice(0, 120)}`);
  const j: Row = JSON.parse(text);
  const head = j.response?.header;
  if (!head || head.resultCode !== "0000") throw new Error(`tourapi ${JSON.stringify(head || j).slice(0, 160)}`);
  let items = j.response.body?.items?.item || [];
  if (!Array.isArray(items)) items = [items];
  const https = (u: string) => (u ? String(u).replace(/^http:/, "https:") : null);
  return items.map((x: Row) => ({
    title: x.title, addr: [x.addr1, x.addr2].filter(Boolean).join(" "), tel: x.tel || null,
    img: https(x.firstimage2 || x.firstimage), dist: x.dist ? Math.round(Number(x.dist)) : null,
  }));
}

export async function nearby(ctx: Ctx, db: DB, cid: string) {
  const c = courseById[cid];
  if (!c) abort(404);
  const key = ctx.env.TOUR_API_KEY;
  if (!key || c!.lat == null) return json({ enabled: false });
  const out = await cached(db, `nearby:${cid}`, NEARBY_TTL, async () => {
    const lists = await Promise.all(NEARBY_TYPES.map(async ([k, t]) => [k, await tourList(key, c!.lat, c!.lng, t)] as const));
    return { ...Object.fromEntries(lists), source: "한국관광공사", fetched: fmtKst(Date.now()).slice(0, 10) };
  }).catch((e) => { console.log("nearby", cid, String(e)); return null; });
  if (!out) return json({ enabled: true, error: "주변 정보를 잠시 가져올 수 없습니다." }, 502);
  return json({ enabled: true, ...out }, 200, { "cache-control": "public, max-age=3600" });
}

// ---------------------------------------------------------------- XML 읽기 (간단한 RSS·Atom 용)
const decode = (s: string) => s
  .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&").trim();
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};
const blocks = (xml: string, name: string) => xml.match(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, "g")) || [];

// ---------------------------------------------------------------- 뉴스
async function googleNews(query: string, limit = 12) {
  const p = new URLSearchParams({ q: `${query} when:30d`, hl: "ko", gl: "KR", ceid: "KR:ko" });
  // 구글 뉴스가 Cloudflare 서버에 가끔 '자동 요청 차단'(503)을 주므로 한 번 더 시도
  let xml = "";
  for (let i = 0; i < 2 && !xml.includes("<item>"); i++) {
    try {
      const r = await fetch(`https://news.google.com/rss/search?${p}`, { headers: UA, signal: AbortSignal.timeout(6000) });
      xml = await r.text();
      if (!r.ok || !xml.includes("<item>")) console.log("google news", query, r.status, xml.slice(0, 150).replace(/\s+/g, " "));
      if (!r.ok) xml = "";
    } catch (e) { console.log("google news", query, String(e)); xml = ""; }
  }
  if (!xml) throw new Error("google news unavailable");
  const items = blocks(xml, "item").map((it) => {
    const source = tag(it, "source");
    let title = tag(it, "title");
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const t = Date.parse(tag(it, "pubDate"));
    return { title, url: tag(it, "link"), source, date: isNaN(t) ? null : fmtKst(t), _t: isNaN(t) ? 0 : t };
  });
  items.sort((a, b) => b._t - a._t);
  const seen = new Set<string>(), out: Row[] = [];
  for (const x of items) {  // 같은 보도자료를 여러 신문이 실은 경우 하나만
    const k = x.title.replace(/[^가-힣A-Za-z0-9]/g, "").slice(0, 18);
    if (seen.has(k)) continue;
    seen.add(k);
    const { _t, ...rest } = x;
    out.push(rest);
  }
  return out.slice(0, limit);
}

/** 20분마다 (wrangler.jsonc 의 triggers.crons): 주요 뉴스·영상을 미리 받아 둔다.
 *  구글이 Cloudflare 서버를 가끔 '자동 요청'으로 막기(503) 때문에, 방문자 요청 때 받지 못해도
 *  마지막으로 성공한 자료를 보여 줄 수 있게 한다. 실패하면 이전 자료를 그대로 둔다. */
export async function refreshFeeds(db: DB) {
  for (const topic of ["news", "tournament", "winner"]) {
    await cached(db, `news:${topic}`, 0, () => googleNews(media.news_queries[topic], 30));
  }
  await cached(db, "videos", 0, youtubeVideos);
}

const WIN_RE =/우승|정상|챔피언|1위|금메달|대상 수상|패권/;

export async function news(ctx: Ctx, db: DB) {
  const topic = ctx.arg("topic") || "news";
  if (topic === "local") {  // 회원 관심 지역 소식: 구장이 있는 시·도/시·군·구 이름만 받는다
    const region = ctx.arg("region");
    const known = new Set(courses.flatMap((c) => [c.sido, c.sigungu]).filter(Boolean));
    if (!known.has(region)) abort(404);
    const q = `파크골프 ${region}`;
    const items = (await cached(db, `news:local:${region}`, NEWS_TTL, () => googleNews(q, 10))) || [];
    return json({ items: items.slice(0, 6), source: "Google 뉴스", query: q });
  }
  const q = media.news_queries[topic];
  if (!q) abort(404);
  let items = (await cached(db, `news:${topic}`, NEWS_TTL, () => googleNews(q, 30))) || [];
  if (topic === "winner") items = items.filter((x) => WIN_RE.test(x.title));
  else if (topic === "tournament") items = items.filter((x) => x.title.includes("대회"));
  return json({ items: items.slice(0, 10), source: "Google 뉴스", query: q });
}

// ---------------------------------------------------------------- 영상
async function youtubeVideos() {
  const results = await Promise.all(media.youtube_channels.map(async (ch: Row) => {
    try {
      const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(ch.id)}`,
        { headers: UA, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return [];
      return blocks(await r.text(), "entry").map((e) => ({
        id: tag(e, "yt:videoId"), title: tag(e, "title"), channel: ch.name, published: tag(e, "published").slice(0, 10),
      })).filter((v) => v.title.replace(/\s/g, "").includes("파크골프"));
    } catch { return []; }
  }));
  const since = fmtKst(Date.now() - 120 * 86400e3).slice(0, 10);  // 최근 4개월 영상만
  const vids = results.flat().filter((v) => v.published >= since);
  vids.sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0));
  return vids.slice(0, 8);
}

const LIVE_RE = /LIVE|라이브|생중계|실시간/i;
const GAME_RE = /대회|결승|라운드|오픈|최강전|선수권|챔피언|예선|본선/;

export async function videos(ctx: Ctx, db: DB) {
  let vids: Row[] = (await cached(db, "videos", VIDEO_TTL, youtubeVideos)) || [];
  const fallback = !vids.length;
  if (fallback) vids = media.fallback_videos.map((v: Row) => ({ ...v, published: null }));
  const recent = fmtKst(Date.now() - 36 * 3600e3).slice(0, 10);
  vids = vids.map((v) => ({
    ...v,
    // 제목에 LIVE 가 있어도 지난 생중계(다시보기)는 LIVE 로 표시하지 않는다
    live: LIVE_RE.test(v.title) && !!v.published && v.published >= recent,
    game: GAME_RE.test(v.title),
  }));
  // 생중계 > 대회 영상 > 기타 순서 (같은 묶음 안에서는 최신순 유지)
  vids = vids.map((v, i) => ({ v, i })).sort((a, b) =>
    (+!a.v.live - +!b.v.live) || (+!a.v.game - +!b.v.game) || a.i - b.i).map((x) => x.v);
  return json({ items: vids, fallback });
}

// ---------------------------------------------------------------- 대회 일정
export function tournamentItems() {
  const t = today();
  const items = media.tournaments.map((x: Row) => {
    const status = !x.start ? "예정" : x.start > t ? "예정" : (x.end || x.start) >= t ? "진행 중" : "종료";
    return { ...x, status, days: x.start ? dayDiff(x.start, t) : null };
  });
  // 진행 중·예정은 가까운 날짜부터(날짜 미정은 뒤로), 종료는 최근에 끝난 것부터
  const ahead = items.filter((x: Row) => x.status !== "종료").sort((a: Row, b: Row) => (a.start || "9999").localeCompare(b.start || "9999"));
  const done = items.filter((x: Row) => x.status === "종료").sort((a: Row, b: Row) => (b.end || "").localeCompare(a.end || ""));
  return { items: [...ahead, ...done], today: t };
}

export function tournamentsApi() {
  return json(tournamentItems());
}

export function tournamentPage(ctx: Ctx) {
  const { items, today: t } = tournamentItems();
  for (const x of items) x.when_short = (x.when || "").split("(")[0].replace("2026년", "").trim();
  const byDesc = (k: string) => items.filter((x: Row) => x[k]).sort((a: Row, b: Row) => b[k] - a[k]);
  return ctx.render("tournament.html", {
    items, today: t,
    upcoming: items.filter((x: Row) => x.status !== "종료"),
    ended: items.filter((x: Row) => x.status === "종료"),
    by_n: byDesc("players_n"), by_p: byDesc("prize_man"),
    stat_rows: items.filter((x: Row) => x.players_n || x.prize_man),
  });
}
