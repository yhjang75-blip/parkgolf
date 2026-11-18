/* 오른쪽 위 '내 나이스파크' 작은 카드 (첫 화면·게시판 공통)
   - 로그인: 등급·포인트, 즐겨찾기 구장 3곳, 관심 지역 소식 2개
   - 로그인 전: 표시하지 않음 (가입 안내는 대회 참가 화면에서만)
   화면에 <aside id="mybox" class="mybox" hidden></aside> 를 두고 이 파일을 불러오면 된다. */
(() => {
  const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const okUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);

  async function loadMyBox() {
    const box = document.getElementById("mybox");
    if (!box) return;
    let j;
    try { j = await fetch("/api/me", { credentials: "same-origin" }).then((r) => r.json()); } catch { return; }
    if (!j.enabled) return;
    // 로그인 전에는 아무것도 띄우지 않는다 (구장 찾기·예약 안내·점수계산기는 가입 없이 쓰고,
    // 회원가입 안내는 '대회 참가' 화면에서만 한다)
    if (!j.login) { box.hidden = true; return; }
    box.hidden = false;
    const g = j.grade, region = j.fav_sigungu || j.fav_sido;
    const favs = (j.favorites || []).slice(0, 3);
    box.className = "mybox";
    box.innerHTML = `
      <a class="mb-head" href="/me" title="내 정보">
        <span class="mb-ic">${h(g.icon)}</span>
        <span class="mb-who"><span><b>${h(j.nickname)}</b>님</span><small>${h(g.name)} · ${h(j.points)}P</small></span>
        <span class="mb-go">내 정보 →</span>
      </a>
      <div class="mb-sec">
        <p class="mb-h">⭐ 즐겨찾기</p>
        ${favs.length ? `<div class="mb-chips">${favs.map((c) => `<a class="mb-chip" href="/#id=${encodeURIComponent(c.id)}" data-id="${h(c.id)}">${h(c.name)}</a>`).join("")}
            ${j.favorites.length > 3 ? `<a class="mb-more" href="/me">+${j.favorites.length - 3}</a>` : ""}</div>`
          : `<p class="mb-s">구장 상세에서 ☆를 누르면 모입니다.</p>`}
      </div>
      <div class="mb-sec">
        <p class="mb-h">📍 ${region ? `${h(region)} 소식` : "우리 동네 소식"}</p>
        ${region ? `<ul class="mb-news"><li class="mb-s">불러오는 중…</li></ul>`
                 : `<p class="mb-s"><a href="/me">내 정보</a>에서 관심 지역을 정해 주세요.</p>`}
      </div>`;
    // 첫 화면에서는 즐겨찾기를 누르면 바로 구장 상세를 연다
    if (typeof window.openDetail === "function") {
      box.querySelectorAll(".mb-chip").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); window.openDetail(a.dataset.id); }));
    }
    if (region) {
      const ul = box.querySelector(".mb-news");
      try {
        const r = await fetch(`/api/news?topic=local&region=${encodeURIComponent(region)}`).then((x) => x.json());
        ul.innerHTML = (r.items || []).slice(0, 2).map((x) =>
          `<li><a href="${h(okUrl(x.url) || "#")}" target="_blank" rel="noopener" title="${h(x.title)}">${h(x.title)}</a></li>`).join("")
          || `<li class="mb-s">최근 30일 기사가 없습니다.</li>`;
      } catch { ul.innerHTML = `<li class="mb-s">소식을 잠시 불러올 수 없습니다.</li>`; }
    }
  }
  window.loadMyBox = loadMyBox;
  loadMyBox();
})();
