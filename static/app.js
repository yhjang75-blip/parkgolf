"use strict";

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
const NONE = '<span class="none">정보 없음</span>';
const val = (v) => (v === null || v === undefined || v === "" ? NONE : esc(v));
const isMobile = () => window.matchMedia("(max-width: 820px)").matches;

const state = { all: [], shown: [], markers: new Map(), active: null };

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

/* ---------- 데이터 ---------- */
async function load() {
  const [courses, meta] = await Promise.all([
    fetch("/api/courses").then((r) => r.json()),
    fetch("/api/meta").then((r) => r.json()),
  ]);
  state.all = courses;
  const regions = Object.values(meta.counts).filter((n) => n > 0).length;
  $("#summary").textContent = `공개 자료 기준 ${meta.total.toLocaleString()}곳 · ${regions}개 시·도 · 자료 정리일 ${meta.built}`;

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
    if (online && !safeUrl(c.reserve_url)) return false;
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
    const reserve = safeUrl(c.reserve_url)
      ? '<span class="badge ok">온라인 예약</span>'
      : (c.reserve_phone || c.phone) ? '<span class="badge">전화 문의</span>' : '<span class="badge gray">예약 정보 없음</span>';
    return `<li><button class="item${state.active === c.id ? " active" : ""}" data-id="${esc(c.id)}">
      <span class="name">${esc(c.name)}</span>
      <span class="meta"><span class="badge">${c.holes ?? "?"}홀</span>${esc(c.sido)} ${esc(c.sigungu ?? "")} ${reserve}</span>
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

  $("#detail-body").innerHTML = `
    <h2>${esc(c.name)}</h2>
    <p class="region">${esc(c.sido)} ${esc(c.sigungu ?? "")}</p>

    <div class="facts">
      <div class="fact"><b>${c.holes ?? "?"}</b><span>홀</span></div>
      <div class="fact"><b>${c.course_count ?? "-"}</b><span>코스</span></div>
      <div class="fact"><b>${c.area_m2 ? Math.round(c.area_m2).toLocaleString() : "-"}</b><span>면적 ㎡</span></div>
    </div>

    <div class="box">
      <h3>예약</h3>
      ${url ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">공식 예약 페이지로 이동 ↗</a>` : ""}
      ${telHref ? `<a class="btn ${url ? "secondary" : "primary"}" href="tel:${esc(telHref)}">📞 전화 문의 ${esc(tel)}</a>` : ""}
      <dl>
        <dt>예약 방식</dt><dd>${val(c.reserve_method)}</dd>
        ${c.reserve_note ? `<dt>예약 안내</dt><dd>${esc(c.reserve_note)}</dd>` : ""}
        <dt>운영기관</dt><dd>${val(c.operator)}</dd>
      </dl>
      ${!url && !telHref ? `<p class="src">공개 자료에 예약 방법이 없습니다. 운영기관(${esc(c.operator ?? c.sigungu ?? "지자체")})에 문의하세요.</p>` : ""}
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

async function loadWeather(c) {
  const box = $("#wx");
  if (c.lat == null) { box.innerHTML = `<p class="src">위치 정보가 없어 날씨를 표시할 수 없습니다.</p>`; return; }
  try {
    const r = await fetch(`/api/weather/${encodeURIComponent(c.id)}`);
    const w = await r.json();
    if (!r.ok || state.active !== c.id) { if (state.active === c.id) box.innerHTML = `<p class="src">${esc(w.error)}</p>`; return; }
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
