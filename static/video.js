"use strict";
/* 대회 영상 (대회 안내 페이지). #player, #vlist, #video-src 가 있는 페이지에서 동작 */
(() => {
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
if (!$("#player")) return;
/* 영상: 처음에는 표지 그림만 보여 주고, 누르면 유튜브 플레이어를 연다 (페이지가 빨리 뜨도록) */
const ytThumb = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
function showVideo(v, play) {
  const box = $("#player");
  if (play) {
    box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?autoplay=1&rel=0"
      title="${esc(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  } else {
    box.innerHTML = `<button class="cover" style="background-image:url('${ytThumb(v.id)}')" aria-label="${esc(v.title)} 재생"></button>
      <div class="cap">${v.live ? '<span class="tag live">LIVE</span>' : ""}${esc(v.title)}</div>`;
    box.querySelector(".cover").addEventListener("click", () => showVideo(v, true));
  }
  document.querySelectorAll("#vlist button").forEach((b) => b.classList.toggle("on", b.dataset.id === v.id));
}
async function loadVideos() {
  try {
    const j = await fetch("/api/videos").then((r) => r.json());
    const vids = j.items;
    if (!vids.length) throw new Error("no videos");
    $("#vlist").innerHTML = vids.map((v) => `<li><button data-id="${esc(v.id)}">
        <img src="${ytThumb(v.id)}" alt="" loading="lazy">
        <span><span class="t">${v.live ? '<span class="tag live">LIVE</span>' : v.game ? '<span class="tag game">대회</span>' : ""}${esc(v.title)}</span>
        <span class="m">${esc(v.channel)}${v.published ? ` · ${esc(v.published)}` : ""}</span></span></button></li>`).join("");
    $("#vlist").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) showVideo(vids.find((v) => v.id === b.dataset.id), true);
    });
    showVideo(vids[0], false);
    $("#video-src").textContent = j.fallback
      ? "유튜브 새 영상 목록을 잠시 못 불러와 저장해 둔 대회 영상을 보여 드립니다."
      : "방송사·파크골프 채널의 유튜브 공개 영상 중 '파크골프' 영상 (1시간마다 새로 고침). 생중계는 오른쪽 위 버튼으로 찾을 수 있습니다.";
  } catch {
    $("#player").innerHTML = "";
    $("#video-src").textContent = "영상을 잠시 불러올 수 없습니다.";
  }
}

loadVideos();
})();
