"use strict";

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
const NONE = '<span class="none">정보 없음</span>';
const val = (v) => (v === null || v === undefined || v === "" ? NONE : esc(v));
const isMobile = () => window.matchMedia("(max-width: 820px)").matches;

const state = { all: [], shown: [], markers: new Map(), active: null, byId: new Map() };

/* ---------- 지도 ---------- */
const map = L.map("map", { zoomControl: true }).setView([36.3, 127.8], 7);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45 });
map.addLayer(cluster);

const precise = (c) => c.coord_source && !c.coord_source.startsWith("대략");
const pinIcon = (c) => L.divIcon({ className: "", html: `<div class="pin${precise(c) ? "" : " approx"}"></div>`, iconSize: [16, 16] });

/* ---------- 예약 단계·대표 사진 ---------- */
const LEVEL_BADGE = {
  online: '<span class="badge ok">온라인 예약</span>',
  portal: '<span class="badge portal">지자체 예약</span>',
  phone: '<span class="badge">전화·현장</span>',
  unknown: '<span class="badge gray">확인 필요</span>',
};

// 사진이 없는 구장은 구장마다 색이 조금씩 다른 그림을 보여 준다 (사진이 아님을 표시)
function hashNum(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; }
function courseArt(c, small) {
  const h = hashNum(c.id), hue = 95 + (h % 50), sky = 195 + (h % 25), fx = 40 + (h % 120);
  const label = small ? "" : `<text x="12" y="22" font-size="13" fill="#fff" opacity=".9" font-family="sans-serif">대표 사진 준비 중</text>`;
  return `<svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(c.name)} 그림">
    <defs><linearGradient id="s${c.id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${sky},70%,62%)"/><stop offset="1" stop-color="hsl(${sky},60%,86%)"/></linearGradient></defs>
    <rect width="320" height="180" fill="url(#s${c.id})"/>
    <circle cx="${260 - (h % 60)}" cy="38" r="16" fill="#fff6c8" opacity=".9"/>
    <path d="M0 105 Q80 70 160 98 T320 88 V180 H0Z" fill="hsl(${hue},35%,48%)"/>
    <path d="M0 128 Q90 104 190 124 T320 116 V180 H0Z" fill="hsl(${hue},48%,42%)"/>
    <ellipse cx="${fx + 90}" cy="150" rx="70" ry="13" fill="hsl(${hue},55%,58%)"/>
    <line x1="${fx + 120}" y1="150" x2="${fx + 120}" y2="112" stroke="#fff" stroke-width="2.5"/>
    <path d="M${fx + 120} 112 l22 7 l-22 7z" fill="#e53935"/>
    <circle cx="${fx + 78}" cy="152" r="3.5" fill="#fff"/>
    ${label}</svg>`;
}
function photoHtml(c, small) {
  const p = c.photo;
  const src = p && safeUrl(small ? (p.thumb || p.url) : (p.url || p.thumb));
  if (!src) return courseArt(c, small);
  // 사진을 못 불러오면 작은 미리보기 사진 → 그림 순서로 바꾼다
  return `<img src="${esc(src)}" alt="${esc(c.name)} 사진" loading="lazy" referrerpolicy="no-referrer"
           data-id="${esc(c.id)}" data-small="${small ? 1 : 0}" onerror="photoFail(this)">`;
}
function photoFail(img) {
  const c = state.byId.get(img.dataset.id) || { id: "x", name: "" };
  const thumb = c.photo && safeUrl(c.photo.thumb);
  if (thumb && img.src !== thumb) { img.src = thumb; return; }
  img.outerHTML = courseArt(c, img.dataset.small === "1");
}

/* ---------- 데이터 ---------- */
async function load() {
  const [courses, meta] = await Promise.all([
    fetch("/api/courses").then((r) => r.json()),
    fetch("/api/meta").then((r) => r.json()),
  ]);
  state.all = courses;
  for (const c of courses) state.byId.set(c.id, c);
  const regions = Object.values(meta.counts).filter((n) => n > 0).length;
  const lv = (k) => courses.filter((c) => c.reserve_level === k).length;
  $("#summary").textContent = `공개 자료 기준 전국 파크골프장 ${meta.total.toLocaleString()}곳 · ${regions}개 시·도 · 자료 정리일 ${meta.built}`;
  $("#stats").innerHTML = `
    <span class="stat"><b>${lv("online")}</b>곳 온라인 예약</span>
    <span class="stat"><b>${lv("portal")}</b>곳 지자체 통합예약</span>
    <span class="stat"><b>${lv("phone") + lv("unknown")}</b>곳 전화·현장</span>`;
  $("#finder-sum").textContent = `인터넷 예약 가능 ${lv("online") + lv("portal")}곳 / 전체 ${meta.total}곳`;

  const sidoSel = $("#sido");
  for (const [s, n] of Object.entries(meta.counts)) {
    const o = document.createElement("option");
    o.value = s; o.textContent = n ? `${s} (${n})` : `${s} (자료 없음)`;
    o.disabled = n === 0;
    sidoSel.appendChild(o);
  }
  const missing = Object.entries(meta.counts).filter(([, n]) => n === 0).map(([s]) => s);
  $("#gap").innerHTML = missing.length
    ? `<b>아직 공개 자료가 없는 지역:</b> ${missing.map(esc).join(", ")}<br>
       이 지역은 지자체가 파크골프장 자료를 공공데이터포털에 올리면 추가됩니다.`
    : "";

  for (const c of courses) {
    if (c.lat == null) continue;
    const m = L.marker([c.lat, c.lng], { icon: pinIcon(c), title: c.name });
    m.bindTooltip(`${c.name} · ${c.holes ?? "?"}홀`);
    m.on("click", () => openDetail(c.id));
    state.markers.set(c.id, m);
  }
  readHash();
  render();
}

/* ---------- 검색·필터 ---------- */
function filtered() {
  const q = $("#q").value.trim().replace(/\s+/g, "");
  const sido = $("#sido").value, sgg = $("#sigungu").value;
  const minH = +$("#holes").value, online = $("#online").checked;
  return state.all.filter((c) => {
    if (sido && c.sido !== sido) return false;
    if (sgg && c.sigungu !== sgg) return false;
    if (minH && (c.holes ?? 0) < minH) return false;
    if (online && !["online", "portal"].includes(c.reserve_level)) return false;
    if (q) {
      const hay = `${c.name}${c.sido}${c.sigungu ?? ""}${c.address ?? ""}`.replace(/\s+/g, "");
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function fillSigungu() {
  const sido = $("#sido").value, sel = $("#sigungu");
  const keep = sel.value;
  sel.innerHTML = '<option value="">전체 시·군·구</option>';
  if (!sido) return;
  const counts = {};
  for (const c of state.all) if (c.sido === sido && c.sigungu) counts[c.sigungu] = (counts[c.sigungu] || 0) + 1;
  for (const s of Object.keys(counts).sort((a, b) => a.localeCompare(b, "ko"))) {
    const o = document.createElement("option");
    o.value = s; o.textContent = `${s} (${counts[s]})`;
    sel.appendChild(o);
  }
  if (counts[keep]) sel.value = keep;
}

function render() {
  const rows = filtered();
  state.shown = rows;
  $("#count").textContent = `${rows.length.toLocaleString()}곳`;
  const ul = $("#list");
  ul.innerHTML = rows.slice(0, 400).map((c) => {
    const reserve = LEVEL_BADGE[c.reserve_level] || LEVEL_BADGE.unknown;
    return `<li><button class="item${state.active === c.id ? " active" : ""}" data-id="${esc(c.id)}">
      <span class="thumb">${photoHtml(c, true)}</span>
      <span class="txt">
        <span class="name">${esc(c.name)}</span>
        <span class="meta"><span class="badge gray">${c.holes ?? "?"}홀</span>${esc(c.sido)} ${esc(c.sigungu ?? "")} ${reserve}</span>
      </span>
    </button></li>`;
  }).join("") + (rows.length > 400 ? `<li class="count">처음 400곳만 보입니다. 지역을 골라 좁혀 보세요.</li>` : "");

  cluster.clearLayers();
  const ms = rows.map((c) => state.markers.get(c.id)).filter(Boolean);
  cluster.addLayers(ms);
  fitShown();
  writeHash();
}

function fitShown() {
  if (!map.getSize().x) return; // 지도가 숨겨진 상태(휴대폰 목록 탭)면 나중에 맞춘다
  const ms = state.shown.map((c) => state.markers.get(c.id)).filter(Boolean);
  if (ms.length && ($("#sido").value || $("#sigungu").value || $("#q").value)) {
    map.fitBounds(L.featureGroup(ms).getBounds(), { padding: [30, 30], maxZoom: 13 });
  } else if (!ms.length || !$("#sido").value) {
    map.setView([36.3, 127.8], isMobile() ? 6 : 7);
  }
}

/* ---------- 상세 ---------- */
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
function closedToday(text) {
  if (!text) return false;
  const d = DAYS[new Date().getDay()];
  return new RegExp(`(^|[^~\\-])${d}요일`).test(text.replace(/\s+/g, ""));
}

async function openDetail(id) {
  state.active = id;
  const c = await fetch(`/api/courses/${encodeURIComponent(id)}`).then((r) => r.json());
  const url = safeUrl(c.reserve_url);
  const portal = c.portal && safeUrl(c.portal.url);
  const tel = c.reserve_phone || c.phone;
  const telHref = tel ? tel.split(/[,/]/)[0].replace(/[^\d-]/g, "") : null;
  const q = encodeURIComponent(c.name);
  const route = c.lat != null && precise(c)
    ? `https://map.kakao.com/link/to/${encodeURIComponent(c.name)},${c.lat},${c.lng}`
    : `https://map.kakao.com/link/search/${q}`;

  const closedNow = closedToday(c.closed_days);
  const diffParts = [c.course_length_m && `코스 길이 ${c.course_length_m.toLocaleString()}m`, c.par_info].filter(Boolean);
  const src = c.sources.map((s) =>
    `<li><a href="${esc(safeUrl(s.url) || "#")}" target="_blank" rel="noopener">${esc(s.title)}</a> (기준 ${esc(s.date ?? "-")}, ${esc(s.license ?? "")})</li>`).join("");

  const p = c.photo;
  const photoCap = p && safeUrl(p.url || p.thumb)
    ? `사진: ${safeUrl(p.source_url) ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">${esc(p.source_name || "출처")}</a>` : esc(p.source_name || "")}
       ${p.method === "직접" ? "" : " · 검색으로 찾은 사진이라 실제 구장과 다를 수 있습니다"}`
    : "대표 사진이 아직 없어 그림으로 보여 드립니다.";

  $("#detail-body").innerHTML = `
    <div class="photo">${photoHtml(c, false)}</div>
    <p class="photo-cap">${photoCap}</p>
    <div class="title-row">
      <h2>${esc(c.name)}</h2>
      <button class="fav" id="fav-btn" hidden aria-pressed="false">☆ 즐겨찾기</button>
    </div>
    <p class="region">${esc(c.sido)} ${esc(c.sigungu ?? "")}</p>

    <div class="facts">
      <div class="fact"><b>${c.holes ?? "?"}</b><span>홀</span></div>
      <div class="fact"><b>${c.course_count ?? "-"}</b><span>코스</span></div>
      <div class="fact"><b>${c.area_m2 ? Math.round(c.area_m2).toLocaleString() : "-"}</b><span>면적 ㎡</span></div>
    </div>

    <div class="box">
      <h3>예약 ${LEVEL_BADGE[c.reserve_level] || ""}</h3>
      ${reserveGuide(c, url, portal)}
      ${url ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">공식 예약 페이지로 이동 ↗</a>` : ""}
      ${portal ? `<a class="btn ${url ? "secondary" : "portal"}" href="${esc(portal)}" target="_blank" rel="noopener">${esc(c.portal.name)}에서 예약 ↗</a>` : ""}
      ${telHref ? `<a class="btn ${url || portal ? "secondary" : "primary"}" href="tel:${esc(telHref)}">📞 전화 문의 ${esc(tel)}</a>` : ""}
      <div class="btn-row">
        ${safeUrl(c.gov_home) ? `<a class="btn secondary" href="${esc(c.gov_home)}" target="_blank" rel="noopener">${esc(c.sigungu ?? "지자체")} 홈페이지</a>` : ""}
        <a class="btn secondary" href="https://search.naver.com/search.naver?query=${encodeURIComponent(`${c.sigungu ?? ""} ${c.name} 예약`)}" target="_blank" rel="noopener">예약 방법 검색</a>
      </div>
      <dl style="margin-top:10px">
        <dt>예약 방식</dt><dd>${val(c.reserve_method)}</dd>
        ${c.reserve_note ? `<dt>예약 안내</dt><dd>${esc(c.reserve_note)}</dd>` : ""}
        <dt>운영기관</dt><dd>${val(c.operator)}</dd>
      </dl>
    </div>

    <div class="box">
      <h3>필드 상태</h3>
      <dl>
        <dt>운영·휴장</dt>
        <dd>${closedNow ? '<span class="today-closed">오늘은 정기 휴무일입니다</span><br>' : ""}
            ${c.closed_days ? `정기 휴무: ${esc(c.closed_days)}` : NONE}</dd>
        <dt>운영시간</dt><dd>${val(c.hours)}</dd>
        <dt>잔디 상태</dt><dd>${val(c.turf)}</dd>
        <dt>코스 난이도</dt><dd>${diffParts.length ? esc(diffParts.join(" · ")) : NONE}</dd>
      </dl>
      <div id="wx"><p class="src">날씨 불러오는 중…</p></div>
      <p class="src">운영·휴장은 공개 자료의 정기 휴무 기준입니다 (자료 기준일 ${esc(c.data_date ?? "-")}). 임시 휴장·잔디 보수는 운영기관에 확인하세요.</p>
    </div>

    <div class="box">
      <h3>위치</h3>
      <dl>
        <dt>주소</dt><dd>${val(c.address)}${c.address_jibun ? `<br><span class="src">지번 ${esc(c.address_jibun)}</span>` : ""}</dd>
        <dt>지도 위치</dt><dd>${c.lat == null ? '<span class="none">좌표 없음 (지도에 표시 안 됨)</span>' : precise(c) ? "정확한 위치" : '<span class="badge warn">대략 위치</span> 읍·면·동 중심점'}</dd>
      </dl>
      <div class="btn-row" style="margin-top:10px">
        <a class="btn secondary" href="${route}" target="_blank" rel="noopener">카카오맵 길찾기</a>
        <a class="btn secondary" href="https://map.naver.com/p/search/${q}" target="_blank" rel="noopener">네이버 지도</a>
      </div>
    </div>

    <div class="box">
      <h3>이용 정보</h3>
      <dl>
        <dt>이용요금</dt><dd>${val(c.fee)}</dd>
        <dt>편의시설</dt><dd>${val(c.facilities)}</dd>
        <dt>대표 전화</dt><dd>${val(c.phone)}</dd>
        <dt>개장</dt><dd>${val(c.opened)}</dd>
        ${c.note ? `<dt>비고</dt><dd>${esc(c.note)}</dd>` : ""}
      </dl>
    </div>

    <div class="box" id="course-talk">
      <h3>💬 이 구장 이야기</h3>
      <p class="src">불러오는 중…</p>
    </div>

    <div class="box">
      <h3>자료 출처</h3>
      <ul class="src" style="padding-left:18px;margin:0">${src}</ul>
      ${c.coord_source ? `<p class="src">위치: ${esc(c.coord_source)}</p>` : ""}
    </div>`;

  $("#detail").hidden = false;
  document.querySelectorAll(".item.active").forEach((e) => e.classList.remove("active"));
  document.querySelector(`.item[data-id="${CSS.escape(id)}"]`)?.classList.add("active");
  const m = state.markers.get(id);
  if (m && !isMobile()) cluster.zoomToShowLayer(m, () => m.openTooltip());
  writeHash();
  loadWeather(c);
  loadCourseTalk(c);
}

/* 구장 상세: 즐겨찾기 버튼 + 이 구장 후기 글 */
async function loadCourseTalk(c) {
  const box = $("#course-talk"), fav = $("#fav-btn");
  let j;
  try { j = await fetch(`/api/courses/${encodeURIComponent(c.id)}/posts`).then((r) => r.json()); } catch { j = { enabled: false }; }
  if (state.active !== c.id) return;
  if (!j.enabled) { box.remove(); return; }
  const setFav = (on) => { fav.textContent = on ? "★ 즐겨찾기" : "☆ 즐겨찾기"; fav.classList.toggle("on", on); fav.setAttribute("aria-pressed", on); };
  fav.hidden = false;
  setFav(j.favorite);
  fav.onclick = async () => {
    if (!j.login) { location.href = `/login?next=${encodeURIComponent("/#id=" + c.id)}`; return; }
    const r = await fetch(`/api/me/favorites/${encodeURIComponent(c.id)}`, { method: "POST", headers: { "X-CSRF": window.CSRF } });
    if (r.ok) { setFav((await r.json()).favorite); loadMy(); }
  };
  box.innerHTML = `<h3>💬 이 구장 이야기</h3>
    ${j.items.length ? `<ul class="feed">${j.items.map((p) => `<li><a href="/board/${p.id}"><span class="t">${esc(p.title)}${p.photos ? " 📷" : ""}</span>
      <span class="m">${esc(p.nickname)} · ${esc(p.date)}</span></a></li>`).join("")}</ul>
      <p class="src"><a href="/board?course=${encodeURIComponent(c.id)}">이 구장 글 모두 보기 →</a></p>`
      : `<p class="src">아직 후기가 없습니다. 다녀오셨다면 첫 후기를 남겨 주세요!</p>`}
    <a class="btn secondary" href="/board/write?course=${encodeURIComponent(c.id)}">✏️ 이 구장 후기·사진 올리기 (+10P)</a>`;
}

function reserveGuide(c, url, portal) {
  if (url) return "";
  if (c.reserve_level === "online") return ""; // 카카오톡 채널 예약 등 — 예약 안내 칸에 표시
  if (portal) {
    return c.portal.parkgolf
      ? `<p class="guide">이 지자체 통합예약 사이트에 <b>파크골프</b> 예약 메뉴가 있습니다. 사이트에서 '${esc(c.name)}'을(를) 찾아 예약하세요.</p>`
      : `<p class="guide">지자체 통합예약 사이트입니다. 사이트에서 '파크골프'를 찾아보고, 목록에 없으면 전화로 문의하세요.</p>`;
  }
  return `<p class="guide warn">인터넷 예약 경로를 찾지 못했습니다. 이런 구장은 대부분 <b>현장 선착순</b>이거나 <b>전화 예약</b>입니다.
          방문 전에 전화로 확인하세요.</p>`;
}

const WMO = (code) => {
  if (code === 0) return ["☀️", "맑음"];
  if (code <= 2) return ["🌤️", "구름 조금"];
  if (code === 3) return ["☁️", "흐림"];
  if (code <= 48) return ["🌫️", "안개"];
  if (code <= 57) return ["🌦️", "이슬비"];
  if (code <= 67) return ["🌧️", "비"];
  if (code <= 77) return ["🌨️", "눈"];
  if (code <= 82) return ["🌧️", "소나기"];
  if (code <= 86) return ["🌨️", "눈"];
  return ["⛈️", "뇌우"];
};

/* 날씨: 이용자 브라우저에서 Open-Meteo 를 직접 조회 (무료 서버의 공용 IP 요청 제한을 피함).
   실패하면 서버(/api/weather)를 거쳐 한 번 더 시도한다. */
const wxCache = new Map();
async function fetchWeather(c) {
  const hit = wxCache.get(c.id);
  if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.w;
  const p = new URLSearchParams({
    latitude: c.lat, longitude: c.lng, timezone: "Asia/Seoul", forecast_days: 3, wind_speed_unit: "ms",
    current: "temperature_2m,precipitation,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
  });
  let w = null;
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
    if (r.ok) {
      const j = await r.json();
      const d = new Date();
      w = { current: j.current, daily: j.daily, source: "Open-Meteo",
            fetched: `${d.toLocaleDateString("sv-SE")} ${d.toTimeString().slice(0, 5)}` };
    }
  } catch { /* 아래에서 서버로 재시도 */ }
  if (!w) {
    try {
      const r = await fetch(`/api/weather/${encodeURIComponent(c.id)}`);
      if (r.ok) w = await r.json();
    } catch { /* 둘 다 실패 */ }
  }
  if (w) wxCache.set(c.id, { t: Date.now(), w });
  return w;
}

async function loadWeather(c) {
  const box = $("#wx");
  if (c.lat == null) { box.innerHTML = `<p class="src">위치 정보가 없어 날씨를 표시할 수 없습니다.</p>`; return; }
  try {
    const w = await fetchWeather(c);
    if (state.active !== c.id) return;
    if (!w) { box.innerHTML = `<p class="src">날씨 정보를 잠시 가져올 수 없습니다.</p>`; return; }
    const [ic, tx] = WMO(w.current.weather_code);
    const labels = ["오늘", "내일", "모레"];
    box.innerHTML = `
      <p style="margin:10px 0 0"><b>날씨</b> 지금 ${ic} ${tx}, ${Math.round(w.current.temperature_2m)}°C, 바람 ${w.current.wind_speed_10m} m/s</p>
      <div class="wx">${w.daily.time.map((_, i) => {
        const [di, dt] = WMO(w.daily.weather_code[i]);
        return `<div>${labels[i]}<b>${di}</b>${dt}<br>${Math.round(w.daily.temperature_2m_min[i])}~${Math.round(w.daily.temperature_2m_max[i])}°C<br>비 ${w.daily.precipitation_probability_max[i] ?? "-"}%</div>`;
      }).join("")}</div>
      <p class="src">날씨: ${esc(w.source)} (${esc(w.fetched)} 조회${precise(c) ? "" : ", 대략 위치 기준"})</p>`;
  } catch {
    box.innerHTML = `<p class="src">날씨 정보를 잠시 가져올 수 없습니다.</p>`;
  }
}

function closeDetail() {
  $("#detail").hidden = true;
  state.active = null;
  document.querySelectorAll(".item.active").forEach((e) => e.classList.remove("active"));
  writeHash();
}

/* ---------- 주소창 (#) 에 상태 저장: 링크 공유·뒤로가기 ---------- */
function writeHash() {
  const p = new URLSearchParams();
  if ($("#sido").value) p.set("sido", $("#sido").value);
  if ($("#sigungu").value) p.set("sgg", $("#sigungu").value);
  if ($("#q").value) p.set("q", $("#q").value);
  if (state.active) p.set("id", state.active);
  const h = p.toString();
  if (location.hash.slice(1) !== h) history.replaceState(null, "", h ? `#${h}` : location.pathname);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get("sido")) { $("#sido").value = p.get("sido"); fillSigungu(); }
  if (p.get("sgg")) $("#sigungu").value = p.get("sgg");
  if (p.get("q")) $("#q").value = p.get("q");
  if (p.get("id")) openDetail(p.get("id"));
}

/* ---------- 이벤트 ---------- */
let t;
$("#q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(render, 200); });
$("#sido").addEventListener("change", () => { fillSigungu(); render(); });
for (const id of ["#sigungu", "#holes", "#online"]) $(id).addEventListener("change", render);
$("#list").addEventListener("click", (e) => {
  const b = e.target.closest(".item");
  if (b) openDetail(b.dataset.id);
});
$("#close").addEventListener("click", closeDetail);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $(".layout").dataset.view = b.dataset.view;
  if (b.dataset.view === "map") setTimeout(() => { map.invalidateSize(); fitShown(); }, 50);
}));

load().catch(() => { $("#summary").textContent = "자료를 불러오지 못했습니다. 잠시 후 새로고침해 주세요."; });

/* ---------- 첫 화면 검색 → 구장 찾기 ---------- */
$("#hero-form").addEventListener("submit", (e) => {
  e.preventDefault();
  $("#q").value = $("#hero-q").value;
  render();
  $("#finder").scrollIntoView();
});

/* ---------- 소식: 대회 일정·대회 기사·우승 소식·뉴스 ---------- */
function ago(s) {
  if (!s) return "";
  const t = new Date(s.replace(" ", "T") + "+09:00").getTime();
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return `${Math.max(m, 1)}분 전`;
  if (m < 60 * 24) return `${Math.round(m / 60)}시간 전`;
  if (m < 60 * 24 * 7) return `${Math.round(m / 1440)}일 전`;
  return s.slice(0, 10);
}
const isFresh = (s) => s && Date.now() - new Date(s.replace(" ", "T") + "+09:00").getTime() < 24 * 3600 * 1000;

/* 소식은 한 줄씩 짧게: 제목(넘치면 …) + 오른쪽에 날짜 */
const briefLi = (url, title, meta, fresh, badge = "") => {
  const body = `<span class="t">${badge}${fresh ? '<span class="new">N</span>' : ""}${esc(title)}</span><span class="m">${esc(meta)}</span>`;
  const u = safeUrl(url);
  return `<li>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(title)}">${body}</a>` : `<span class="row" title="${esc(title)}">${body}</span>`}</li>`;
};
const getNews = (topic) => fetch(`/api/news?topic=${topic}`).then((r) => r.json()).then((j) => j.items).catch(() => null);

async function loadFeed(topics, el, limit) {
  const lists = await Promise.all(topics.map(getNews));
  if (lists.every((x) => x === null)) { el.innerHTML = `<li class="muted">소식을 잠시 불러올 수 없습니다.</li>`; return; }
  const seen = new Set();
  const items = lists.flat().filter((x) => x && !seen.has(x.title) && seen.add(x.title))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, limit);
  el.innerHTML = items.length ? items.map((x) => briefLi(x.url, x.title, ago(x.date), isFresh(x.date))).join("")
    : `<li class="muted">최근 30일 동안 관련 기사가 없습니다.</li>`;
}

const fmtDay = (d) => { const [, m, dd] = d.split("-"); return `${+m}월 ${+dd}일`; };
async function loadTournaments() {
  const el = $("#tour");
  try {
    const j = await fetch("/api/tournaments").then((r) => r.json());
    el.innerHTML = j.items.filter((t) => t.status !== "종료").concat(j.items.filter((t) => t.status === "종료")).slice(0, 4).map((t) => {
      const when = t.start ? fmtDay(t.start) : ((t.when || "미정").replace(/\s*\(.*\)\s*/, "").replace(/^\d{4}년\s*/, ""));
      const st = t.status === "진행 중" ? "진행" : t.status;
      return briefLi(t.source, t.name, when, false, `<span class="st ${st}">${esc(st)}</span>`);
    }).join("") || `<li class="muted">등록된 대회 일정이 없습니다.</li>`;
  } catch {
    el.innerHTML = `<li class="muted">대회 일정을 잠시 불러올 수 없습니다.</li>`;
  }
}

/* ---------- 회원 맞춤 정보 (로그인 전: 가입 안내) ---------- */
async function loadMy() {
  const box = $("#my");
  let j;
  try { j = await fetch("/api/me").then((r) => r.json()); } catch { return; }
  if (!j.enabled) return;
  box.hidden = false;
  if (!j.login) {
    box.className = "panel my join-cta";
    box.innerHTML = `<div><h2>⛳ 나이스파크 회원이 되어 보세요</h2>
      <p>⭐ 내 구장 즐겨찾기 · 📍 우리 동네 파크골프 소식 · 📸 후기·사진 공유 · 🎁 포인트로 제휴 혜택</p></div>
      <a class="btn kakao" href="/login">💬 카카오로 3초 가입 (+20P)</a>`;
    return;
  }
  const g = j.grade, region = j.fav_sigungu || j.fav_sido;
  const favs = j.favorites.slice(0, 6).map((c) => {
    const url = safeUrl(c.reserve_url) || (c.portal && safeUrl(c.portal.url));
    return `<li><button class="link" data-id="${esc(c.id)}">${esc(c.name)}</button>
      <span class="m">${esc(c.sigungu ?? c.sido)} · ${c.holes ?? "?"}홀</span>
      ${url ? `<a class="pill" href="${esc(url)}" target="_blank" rel="noopener">예약 ↗</a>` : ""}</li>`;
  }).join("");
  box.className = "panel my";
  box.innerHTML = `
    <div class="my-head">
      <h2>${esc(g.icon)} ${esc(j.nickname)}님의 나이스파크</h2>
      <a class="pill" href="/me">${esc(g.name)} · ${j.points}P · 내 정보 →</a>
    </div>
    <div class="grid2 in">
      <div><h3 class="sub-h">⭐ 즐겨찾기 구장</h3>
        ${favs ? `<ul class="favs">${favs}</ul>` : `<p class="muted">구장 상세 화면에서 ☆ 즐겨찾기를 누르면 여기 모입니다.</p>`}</div>
      <div><h3 class="sub-h">📍 ${region ? esc(region) + " 파크골프 소식" : "우리 동네 소식"}</h3>
        ${region ? `<ul class="feed" id="feed-local"><li class="muted">불러오는 중…</li></ul>`
                 : `<p class="muted"><a href="/me">내 정보</a>에서 관심 지역을 정하면 그 지역 소식을 보여 드립니다.</p>`}</div>
    </div>`;
  box.querySelectorAll("button.link").forEach((b) => b.addEventListener("click", () => openDetail(b.dataset.id)));
  if (region) {
    const el = $("#feed-local");
    try {
      const r = await fetch(`/api/news?topic=local&region=${encodeURIComponent(region)}`).then((x) => x.json());
      el.innerHTML = r.items.slice(0, 5).map((x) => `<li><a href="${esc(safeUrl(x.url) || "#")}" target="_blank" rel="noopener">
        <span class="t">${esc(x.title)}</span><span class="m">${esc(x.source)} · ${esc(ago(x.date))}</span></a></li>`).join("")
        || `<li class="muted">최근 30일 동안 ${esc(region)} 파크골프 기사가 없습니다.</li>`;
    } catch { el.innerHTML = `<li class="muted">소식을 잠시 불러올 수 없습니다.</li>`; }
  }
}

/* ---------- 커뮤니티 요약 ---------- */
async function loadCommunity() {
  if (!$("#comm-posts")) return;
  try {
    const j = await fetch("/api/community/latest").then((r) => r.json());
    $("#comm-posts").innerHTML = j.posts.map((p) => `<li><a href="/board/${p.id}">
        <span class="t"><span class="pc">${esc(p.cat)}</span> ${esc(p.title)}${p.comments ? ` <span class="cc">[${p.comments}]</span>` : ""}${p.photos ? " 📷" : ""}</span>
        <span class="m">${esc(p.grade)} ${esc(p.nickname)} · ${esc(p.date)}</span></a></li>`).join("")
      || `<li class="muted">아직 글이 없습니다. <a href="/board/write">첫 글을 남겨 주세요!</a></li>`;
    $("#comm-photos").innerHTML = j.photos.map((x) => `<a href="/board/${x.post_id}" title="${esc(x.title)}">
        <img src="/img/${x.id}/thumb" alt="${esc(x.title)}" loading="lazy"></a>`).join("")
      || `<p class="muted">📸 구장 사진을 올려 주시면 여기에 모입니다.</p>`;
    $("#comm-rank").innerHTML = j.ranking.map((r) => `<li>${esc(r.grade.icon)} <b>${esc(r.nickname)}</b> <span class="muted">${r.points}P</span></li>`).join("")
      || `<li class="muted">이번 달 첫 주인공이 되어 보세요.</li>`;
  } catch { $("#comm-posts").innerHTML = `<li class="muted">잠시 불러올 수 없습니다.</li>`; }
}

loadMy();
loadCommunity();
loadTournaments();
loadFeed(["winner"], $("#feed-winner"), 4);
loadFeed(["tournament", "news"], $("#feed-news"), 4);
