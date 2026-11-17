/* 이지 파크골프 점수계산기 (연습게임용)
 * - 서버 없이 이 기기의 브라우저(localStorage)에만 저장
 * - 팀별·개인별 타수 입력 → 개인·팀·남녀 순위, 시상(우승·홀인원·버디왕) 자동 계산
 * - 휴대폰 여러 대: 팀별 입력 링크를 보내고, 팀에서 돌려보낸 점수를 붙여 넣어 합친다
 */
(() => {
  'use strict';
  const KEY = 'epg-score-v1';
  const DEF9 = [3, 4, 3, 4, 5, 3, 4, 3, 4];   // 9홀 파 33
  const MAXT = 20, MAXP = 6, MAXS = 15;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del() { try { localStorage.removeItem(KEY); } catch (e) { /* 무시 */ } },
  };
  const enc = o => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const dec = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return JSON.parse(decodeURIComponent(escape(atob(s)))); };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const fmt = tp => (tp > 0 ? '+' + tp : String(tp));

  let G = store.get();
  if (G && (!G.teams || !G.pars)) G = null;
  let view = G ? (G.view || 'enter') : 'setup';
  let rankTab = 'ind';
  const save = () => { if (G) { G.view = view; if (!store.set(G)) toast('이 브라우저에서는 저장이 되지 않습니다. 화면을 닫으면 기록이 사라질 수 있어요.'); } };

  // ------------------------------------------------------------ 계산
  const H = () => G.pars.length;
  const parSum = () => G.pars.reduce((a, b) => a + b, 0);
  function pst(p) {
    let n = 0, tot = 0, tp = 0;
    p.s.forEach((v, i) => { if (v != null) { n++; tot += v; tp += v - G.pars[i]; } });
    return { n, tot, tp, done: n === H() };
  }
  function cmp(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (x !== y) return x - y; }
    return 0;
  }
  function ranked(items, key) {
    const arr = items.map(it => ({ it, k: key(it) })).sort((a, b) => cmp(a.k, b.k));
    let r = 0;
    arr.forEach((x, i) => { if (i === 0 || cmp(x.k, arr[i - 1].k) !== 0) r = i + 1; x.rank = r; });
    return arr;
  }
  // 개인: 진행 중에는 기준타수 대비(±), 같으면 많이 친 사람 먼저. 다 치면 동타는 마지막 홀부터 거꾸로 비교
  const indKey = x => [x.st.n ? 0 : 1, x.st.tp, -x.st.n, ...(x.st.done ? [...x.p.s].reverse() : [])];
  function players(filter) {
    const out = [];
    G.teams.forEach((t, ti) => t.players.forEach((p, pi) => {
      const x = { p, t, ti, pi, st: pst(p) };
      if (!filter || filter(x)) out.push(x);
    }));
    return out;
  }
  const holesDone = t => G.pars.filter((_, i) => t.players.every(p => p.s[i] != null)).length;
  function tst(t) {
    const m = t.players.map(p => ({ p, st: pst(p) }));
    let cnt = m;
    if (G.rule === 'best3' && m.length > 3)
      cnt = [...m].sort((a, b) => cmp([a.st.n ? 0 : 1, a.st.tp, -a.st.n], [b.st.n ? 0 : 1, b.st.tp, -b.st.n])).slice(0, 3);
    const tp = cnt.reduce((s, x) => s + x.st.tp, 0), tot = cnt.reduce((s, x) => s + x.st.tot, 0);
    const done = m.every(x => x.st.done);
    const holeSums = G.pars.map((_, i) => cnt.reduce((s, x) => s + (x.p.s[i] ?? 0), 0));
    return { m, cnt, tp, tot, done, holeSums, avg: cnt.length ? tp / cnt.length : 0, hd: holesDone(t), any: m.some(x => x.st.n) };
  }
  const counted = t => (G.rule === 'best3' ? Math.min(3, t.players.length) : t.players.length);
  const useAvg = () => new Set(G.teams.map(counted)).size > 1;   // 팀마다 인원이 다르면 1인 평균으로 비교
  function teamsRanked() {
    const avg = useAvg();
    return ranked(G.teams.map((t, ti) => ({ t, ti, s: tst(t) })),
      x => [x.s.any ? 0 : 1, avg ? x.s.avg : x.s.tp, -x.s.hd, ...(x.s.done ? [...x.s.holeSums].reverse() : [])]);
  }
  const hasGender = () => G.teams.some(t => t.players.some(p => p.g === '여'));
  function cls(v, par) {
    if (v == null) return '';
    if (v === 1) return 'hio';
    const d = v - par;
    return d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : 'dbl';
  }
  const LAB = { hio: '홀인원', eagle: '이글', birdie: '버디', par: '파', bogey: '보기', dbl: '더블+' };

  // ------------------------------------------------------------ 명단 읽기
  function parseName(raw) {
    let s = raw.trim().replace(/\s+/g, ' '), g = '';
    const m = s.match(/^(.+?)\s*(?:[/(\[]\s*(남|여)\s*[)\]]?|\s(남|여))$/);
    if (m) { s = m[1].trim(); g = m[2] || m[3]; }
    return { name: s.slice(0, 20), g };
  }
  // 명단(입력 줄) → 팀: 순서대로(또는 섞어서) 인원수만큼 고르게 나눈다
  function splitTeams(ps, size, shuffle) {
    ps = ps.filter(p => p.name).map(p => ({ name: p.name.slice(0, 20), g: p.g || '' }));
    if (!ps.length) return [];
    if (shuffle) for (let i = ps.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ps[i], ps[j]] = [ps[j], ps[i]]; }
    const k = Math.ceil(ps.length / size), base = Math.floor(ps.length / k), extra = ps.length % k;
    const teams = [];
    let at = 0;
    for (let i = 0; i < k; i++) { const n = base + (i < extra ? 1 : 0); teams.push({ name: '', players: ps.slice(at, at + n) }); at += n; }
    return teams;
  }
  // 성별 선택 버튼 (남/여)
  const gsel = (g, attrs) => `<div class="gsel" role="group" aria-label="성별" ${attrs}>${['남', '여'].map(x =>
    `<button type="button" class="${(g || '남') === x ? 'on' : ''} ${x === '여' ? 'f' : ''}" data-act="g" data-g="${x}" aria-pressed="${(g || '남') === x}">${x}</button>`).join('')}</div>`;
  // 새 게임 명단 입력 줄
  let R = [{ name: '', g: '남' }, { name: '', g: '남' }, { name: '', g: '남' }, { name: '', g: '남' }];
  function renderRoster(focus) {
    const box = $('#f-roster'); if (!box) return;
    box.innerHTML = R.map((r, i) => `<div class="rrow">
        <span class="no">${i + 1}</span>
        <input class="rn" data-i="${i}" value="${esc(r.name)}" maxlength="20" placeholder="이름" enterkeyhint="next" aria-label="${i + 1}번 참가자 이름">
        ${gsel(r.g, `data-i="${i}"`)}
        <button type="button" class="rdel" data-act="rdel" data-i="${i}" aria-label="${i + 1}번 줄 지우기">✕</button>
      </div>`).join('');
    if (focus != null) { const el = box.querySelector(`.rn[data-i="${focus}"]`); if (el) el.focus(); }
    updatePreview();
  }
  function checkTeams(teams) {
    if (!teams.length) return '참가자 명단을 적거나, 명단 없이 시작할 팀 수를 적어 주세요.';
    if (teams.length > MAXT) return `팀은 최대 ${MAXT}팀까지입니다. (지금 ${teams.length}팀)`;
    const big = teams.findIndex(t => t.players.length > MAXP);
    if (big >= 0) return `${teams[big].name || big + 1 + '팀'}의 인원이 ${MAXP}명을 넘습니다.`;
    return '';
  }
  function makeGame(o) {
    return {
      v: 1, gid: Math.random().toString(36).slice(2, 10), mode: 'main', title: o.title, date: today(),
      pars: o.pars, rule: o.rule, ct: 0, ch: 0,
      teams: o.teams.map((t, i) => ({ name: (t.name || `${i + 1}팀`).slice(0, 20), players: t.players.map(p => ({ name: p.name, g: p.g || '', s: o.pars.map(() => null) })) })),
    };
  }

  // ------------------------------------------------------------ 화면: 공통
  function toast(msg) {
    let t = $('#sc-toast');
    if (!t) { t = document.createElement('div'); t.id = 'sc-toast'; t.className = 'sc-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 3500);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { /* 무시 */ }
      ta.remove(); return ok;
    }
  }
  async function share(title, text) {
    if (navigator.share) {
      try { await navigator.share({ title, text }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    if (await copyText(text)) toast('복사했습니다. 카카오톡 대화방에 붙여 넣어 보내세요.');
    else prompt('아래 내용을 길게 눌러 복사하세요', text);
  }
  function render() {
    document.querySelectorAll('#sc-tabs button').forEach(b => {
      const v = b.dataset.v;
      b.classList.toggle('on', v === view);
      b.disabled = !G && v !== 'setup';
      b.hidden = G && G.mode === 'team' && v === 'award';
    });
    ['setup', 'enter', 'grid', 'rank', 'award'].forEach(v => { $('#v-' + v).hidden = v !== view; });
    $('#sc-sub').textContent = G
      ? `${G.title} · ${G.date} · ${H()}홀(파 ${parSum()}) · ${G.teams.length}팀 ${players().length}명` + (G.mode === 'team' ? ' · 팀 입력용' : '')
      : '팀별·개인별 타수를 입력하면 순위와 시상을 자동으로 계산합니다. 기록은 이 휴대폰(브라우저)에만 저장됩니다.';
    ({ setup: rSetup, enter: rEnter, grid: rGrid, rank: rRank, award: rAward })[view]();
  }
  function go(v) { view = v; save(); render(); window.scrollTo({ top: $('#sc').offsetTop - 70, behavior: 'smooth' }); }

  // ------------------------------------------------------------ 설정
  function parInputs(pars) {
    return pars.map((p, i) => `<label><span>${i + 1}</span><input class="par-in" inputmode="numeric" maxlength="1" value="${p}" aria-label="${i + 1}번 홀 파"></label>`).join('');
  }
  function rSetup() {
    const el = $('#v-setup');
    if (!G) {
      const d = new Date();
      el.innerHTML = `
        <h2>새 연습게임 만들기</h2>
        <label class="field">게임 이름<input id="f-title" maxlength="40" value="${d.getMonth() + 1}월 ${d.getDate()}일 연습게임"></label>
        <fieldset class="field choice"><legend>홀 수</legend>
          <label><input type="radio" name="f-holes" value="9" checked> 9홀</label>
          <label><input type="radio" name="f-holes" value="18"> 18홀</label></fieldset>
        <div class="field"><span>홀별 기준타수(파) <small>합계 <b id="f-parsum">${DEF9.reduce((a, b) => a + b)}</b> · 구장에 맞게 고치세요</small></span>
          <div class="pars" id="f-pars">${parInputs(DEF9)}</div></div>
        <div class="row2">
          <label class="field">한 팀 인원<select id="f-size">${[2, 3, 4, 5, 6].map(n => `<option ${n === 4 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="field">팀 점수 방식<select id="f-rule"><option value="all">팀원 모두의 타수 합계</option><option value="best3">잘 친 3명의 타수 합계</option></select></label>
        </div>
        <div class="field"><span>참가자 명단 <small>한 줄에 한 명씩 이름을 적고 성별을 누르세요 · 엔터를 치면 다음 줄로</small></span>
          <div id="f-roster" class="roster-rows"></div>
          <div class="btn-row radd">
            <button type="button" class="btn secondary" data-act="radd" data-n="1">＋ 한 명 추가</button>
            <button type="button" class="btn secondary" data-act="radd" data-n="4">＋ 4명 추가</button>
          </div></div>
        <label class="check"><input type="checkbox" id="f-shuffle"> 팀을 무작위로 섞기 (체크하지 않으면 적은 순서대로 4명씩 나눕니다)</label>
        <label class="field">명단 없이 시작 <small>(팀 수만 정하고 선수 이름은 '1팀-1'처럼 자동으로)</small>
          <input id="f-nteams" type="number" min="1" max="${MAXT}" inputmode="numeric" placeholder="예: 5"></label>
        <p class="guide" id="f-preview">명단을 적으면 몇 팀이 되는지 여기에 보여 드립니다.</p>
        <button class="btn primary big-cta" data-act="start">▶ 게임 시작</button>
        <button class="btn secondary" data-act="demo">예시 명단 채워 보기</button>`;
      renderRoster();
      return;
    }
    const tr = G.rule === 'best3' ? '잘 친 3명의 타수 합계' : '팀원 모두의 타수 합계';
    let html = `<h2>${esc(G.title)}</h2>
      <p class="src">${G.date} · ${H()}홀 (파 ${parSum()}) · ${G.teams.length}팀 ${players().length}명 · 팀 점수: ${tr}${useAvg() ? ' (팀 인원이 달라 1인 평균으로 비교)' : ''}</p>`;
    if (G.mode === 'team') {
      html += `<div class="guide">이 휴대폰은 <b>${esc(G.teams[0].name)}</b> 점수 입력용입니다. 다 입력하면 <b>점수 보내기</b>를 눌러 총무님께 보내 주세요.</div>
        <button class="btn primary big-cta" data-act="sendres">📤 우리 팀 점수 보내기</button>`;
    } else {
      html += `<h3 class="sub-h">📲 휴대폰 여러 대로 나눠 입력하기</h3>
        <p class="src">팀마다 기록 담당자에게 링크를 보내세요. 그 휴대폰에서 자기 팀 점수를 입력한 뒤 '점수 보내기'로 돌려보내면, 받은 메시지를 아래 칸에 붙여 넣어 합칠 수 있습니다.</p>
        <div class="linkrow">${G.teams.map((t, i) => `<button class="pill" data-act="sendjoin" data-t="${i}">📨 ${esc(t.name)} 링크 보내기</button>`).join('')}</div>
        <label class="field">팀에서 받은 점수 붙여넣기<textarea id="f-import" rows="3" placeholder="팀에서 보낸 메시지를 통째로 붙여 넣으세요 (여러 팀 한꺼번에도 됩니다)"></textarea></label>
        <button class="btn secondary" data-act="import">⬇️ 받은 점수 합치기</button>`;
    }
    html += `<h3 class="sub-h">✏️ 명단·팀 이름 고치기</h3>
      <div class="edit-teams">${G.teams.map((t, ti) => `
        <fieldset class="et"><legend><input class="tn" data-t="${ti}" value="${esc(t.name)}" maxlength="20" aria-label="팀 이름"></legend>
          ${t.players.map((p, pi) => `<div class="rrow ed"><input class="pn" data-t="${ti}" data-p="${pi}" value="${esc(p.name)}" maxlength="20" aria-label="선수 이름">${gsel(p.g, `data-t="${ti}" data-p="${pi}"`)}</div>`).join('')}
        </fieldset>`).join('')}</div>
      <button class="btn secondary" data-act="savenames">이름 저장</button>
      <h3 class="sub-h">게임 정리</h3>
      <div class="btn-row">
        <button class="btn secondary" data-act="shareres">📤 결과 공유</button>
        <button class="btn danger" data-act="reset">🗑️ 이 게임 지우고 새로 만들기</button>
      </div>`;
    $('#v-setup').innerHTML = html;
  }
  function readSetup() {
    const pars = [...document.querySelectorAll('#f-pars .par-in')].map(i => parseInt(i.value, 10));
    const size = parseInt($('#f-size').value, 10);
    let teams = splitTeams(R, size, $('#f-shuffle').checked);
    const nt = parseInt($('#f-nteams').value, 10);
    if (!teams.length && nt > 0)
      teams = Array.from({ length: nt }, (_, i) => ({ name: '', players: Array.from({ length: size }, (_, j) => ({ name: `${i + 1}팀-${j + 1}`, g: '' })) }));
    return { title: ($('#f-title').value.trim() || '연습게임').slice(0, 40), pars, size, rule: $('#f-rule').value, teams };
  }
  function updatePreview() {
    const box = $('#f-preview'); if (!box) return;
    const o = readSetup();
    $('#f-parsum').textContent = o.pars.every(p => p >= 1) ? o.pars.reduce((a, b) => a + b, 0) : '?';
    if (!o.teams.length) { box.textContent = '명단을 적으면 몇 팀이 되는지 여기에 보여 드립니다.'; box.classList.remove('warn'); return; }
    const err = checkTeams(o.teams);
    const n = o.teams.reduce((s, t) => s + t.players.length, 0);
    const sizes = {}; o.teams.forEach(t => { sizes[t.players.length] = (sizes[t.players.length] || 0) + 1; });
    box.textContent = err || `${n}명 → ${o.teams.length}팀 (` + Object.entries(sizes).sort((a, b) => b[0] - a[0]).map(([k, v]) => `${k}명 ${v}팀`).join(', ') + ')';
    box.classList.toggle('warn', !!err);
  }

  // ------------------------------------------------------------ 점수 입력
  function rEnter() {
    if (G.ct >= G.teams.length) G.ct = 0;
    if (G.ch >= H()) G.ch = 0;
    const t = G.teams[G.ct], h = G.ch, par = G.pars[h];
    const last = h === H() - 1;
    let html = '';
    if (G.teams.length > 1) {
      html += `<div class="sbar steams" role="tablist" aria-label="팀 선택">${G.teams.map((x, i) => {
        const hd = holesDone(x);
        return `<button class="${i === G.ct ? 'on' : ''} ${hd === H() ? 'full' : ''}" data-act="team" data-t="${i}">${esc(x.name)}<small>${hd}/${H()}</small></button>`;
      }).join('')}</div>`;
    }
    html += `<div class="sbar sholes" aria-label="홀 선택">${G.pars.map((p, i) => {
      const done = t.players.every(x => x.s[i] != null);
      return `<button class="${i === h ? 'on' : ''} ${done ? 'full' : ''}" data-act="hole" data-h="${i}">${i + 1}<small>파${p}</small></button>`;
    }).join('')}</div>`;
    html += `<div class="hole-head"><b>${esc(t.name)} · ${h + 1}번 홀</b><span>파 ${par}</span></div>
      <p class="src">가운데 숫자를 누르면 <b>파(${par})</b>, −/+ 로 한 타씩 조정합니다.</p>
      <div class="prows">${t.players.map((p, pi) => {
        const v = p.s[h], st = pst(p), c = cls(v, par);
        return `<div class="prow">
          <div class="pn"><b>${esc(p.name)}</b>${p.g === '여' ? ' <i class="fem">여</i>' : ''}<small>${st.n}홀 · ${st.tot}타 (${fmt(st.tp)})</small></div>
          <button class="stp" data-act="dec" data-p="${pi}" aria-label="${esc(p.name)} 한 타 줄이기">−</button>
          <button class="sv ${c}" data-act="par" data-p="${pi}" aria-label="${esc(p.name)} 타수 ${v ?? '없음'}">${v ?? '–'}<small>${v == null ? '누르면 파' : LAB[c]}</small></button>
          <button class="stp" data-act="inc" data-p="${pi}" aria-label="${esc(p.name)} 한 타 늘리기">+</button>
        </div>`;
      }).join('')}</div>
      <button class="btn secondary" data-act="allpar">빈칸 모두 파(${par})로 채우기</button>
      <div class="btn-row nav2">
        <button class="btn secondary" data-act="prev" ${h === 0 ? 'disabled' : ''}>← 이전 홀</button>
        ${!last ? '<button class="btn primary" data-act="next">다음 홀 →</button>'
          : G.mode === 'team' ? '<button class="btn primary" data-act="sendres">📤 점수 보내기</button>'
          : G.ct < G.teams.length - 1 ? '<button class="btn primary" data-act="nextteam">다음 팀 →</button>'
          : '<button class="btn primary" data-act="torank">🏆 순위 보기</button>'}
      </div>`;
    $('#v-enter').innerHTML = html;
    const on = $('#v-enter .steams .on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  function setScore(pi, fn) {
    const p = G.teams[G.ct].players[pi], par = G.pars[G.ch];
    p.s[G.ch] = fn(p.s[G.ch], par);
    save(); rEnter();
  }

  // ------------------------------------------------------------ 전체표
  function rGrid() {
    const ps = parSum();
    $('#v-grid').innerHTML = `<h2>📋 전체 점수표</h2><p class="src">칸을 누르면 그 홀 입력 화면으로 갑니다.</p>` + G.teams.map((t, ti) => {
      const s = tst(t);
      return `<div class="tscroll"><table class="sgrid">
        <tr><th class="nm">${esc(t.name)}</th>${G.pars.map((_, i) => `<th>${i + 1}</th>`).join('')}<th>합계</th><th>±</th></tr>
        <tr class="parrow"><td class="nm">파</td>${G.pars.map(p => `<td>${p}</td>`).join('')}<td>${ps}</td><td></td></tr>
        ${t.players.map((p, pi) => {
          const st = pst(p);
          return `<tr><td class="nm">${esc(p.name)}${p.g === '여' ? ' <i class="fem">여</i>' : ''}</td>${p.s.map((v, i) => `<td class="c ${cls(v, G.pars[i])}" data-act="goto" data-t="${ti}" data-h="${i}">${v ?? ''}</td>`).join('')}
            <td class="tot">${st.n ? st.tot : ''}</td><td class="tp">${st.n ? fmt(st.tp) : ''}</td></tr>`;
        }).join('')}
        <tr class="teamrow"><td class="nm">팀 ${G.rule === 'best3' && t.players.length > 3 ? '(3명)' : ''}</td>${s.holeSums.map(v => `<td>${v || ''}</td>`).join('')}<td class="tot">${s.any ? s.tot : ''}</td><td class="tp">${s.any ? fmt(s.tp) : ''}</td></tr>
      </table></div>`;
    }).join('') + `<p class="slegend"><span class="hio">홀인원</span><span class="eagle">이글</span><span class="birdie">버디</span><span class="par">파</span><span class="bogey">보기</span><span class="dbl">더블보기 이상</span></p>`;
  }

  // ------------------------------------------------------------ 순위
  const medal = (r, done) => (done && r <= 3 ? ['🥇', '🥈', '🥉'][r - 1] : r);
  function indTable(list) {
    const rows = ranked(list, indKey);
    if (!rows.length) return '<p class="muted">해당 선수가 없습니다.</p>';
    return `<div class="tscroll"><table class="tbl rk"><tr><th>순위</th><th>이름</th><th>팀</th><th class="n">진행</th><th class="n">타수</th><th class="n">±</th></tr>
      ${rows.map(({ it: x, rank }) => `<tr class="${x.st.done && rank <= 3 ? 'top3' : ''}"><td><b>${x.st.n ? medal(rank, x.st.done) : '-'}</b></td>
        <td>${esc(x.p.name)}${x.p.g === '여' ? ' <i class="fem">여</i>' : ''}</td><td>${esc(x.t.name)}</td>
        <td class="n">${x.st.done ? '끝' : x.st.n + '홀'}</td><td class="n">${x.st.n ? x.st.tot : ''}</td><td class="n"><b>${x.st.n ? fmt(x.st.tp) : ''}</b></td></tr>`).join('')}
    </table></div>`;
  }
  function rRank() {
    const tabs = [['ind', '개인'], ['team', '팀']];
    if (hasGender()) tabs.push(['m', '남자부'], ['f', '여자부']);
    if (G.mode === 'team') tabs.splice(1, 1);
    if (!tabs.some(t => t[0] === rankTab)) rankTab = 'ind';
    let body = '';
    if (rankTab === 'ind') body = indTable(players());
    else if (rankTab === 'm') body = indTable(players(x => x.p.g !== '여'));
    else if (rankTab === 'f') body = indTable(players(x => x.p.g === '여'));
    else {
      const avg = useAvg();
      body = `<div class="tscroll"><table class="tbl rk"><tr><th>순위</th><th>팀</th><th>팀원 (타수)</th><th class="n">진행</th><th class="n">타수</th><th class="n">${avg ? '1인 평균 ±' : '±'}</th></tr>
        ${teamsRanked().map(({ it: x, rank }) => `<tr class="${x.s.done && rank <= 3 ? 'top3' : ''}"><td><b>${x.s.any ? medal(rank, x.s.done) : '-'}</b></td><td><b>${esc(x.t.name)}</b></td>
          <td class="mem">${x.s.m.map(m => `<span class="${x.s.cnt.includes(m) ? '' : 'out'}">${esc(m.p.name)} ${m.st.n ? m.st.tot : '-'}</span>`).join('')}</td>
          <td class="n">${x.s.done ? '끝' : x.s.hd + '홀'}</td><td class="n">${x.s.any ? x.s.tot : ''}</td>
          <td class="n"><b>${x.s.any ? (avg ? fmt(Math.round(x.s.avg * 10) / 10) : fmt(x.s.tp)) : ''}</b></td></tr>`).join('')}
      </table></div>
      <p class="src">팀 점수: ${G.rule === 'best3' ? '팀에서 잘 친 3명의 타수 합계 (회색 이름은 합계에서 빠진 사람)' : '팀원 모두의 타수 합계'}${avg ? ' · 팀마다 인원이 달라 1인 평균(±)으로 순위를 매깁니다.' : ''}</p>`;
    }
    $('#v-rank').innerHTML = `<div class="panel-head"><h2>🏆 실시간 순위</h2><nav class="cats">${tabs.map(([k, l]) => `<a href="#" data-act="rtab" data-k="${k}" class="${k === rankTab ? 'on' : ''}">${l}</a>`).join('')}</nav></div>
      ${body}
      <p class="src">진행 중에는 기준타수 대비(±)로 순위를 매깁니다. 모두 끝나면 총타수가 적은 순서이고, 동타는 마지막 홀부터 거꾸로 비교합니다. 메달은 경기를 끝낸 사람에게만 표시됩니다.</p>`;
  }

  // ------------------------------------------------------------ 시상
  function awards() {
    const all = players(), done = all.filter(x => x.st.done);
    const ind = ranked(done, indKey).filter(r => r.rank <= 3);
    const teams = teamsRanked().filter(r => r.it.s.done && r.rank <= 3);
    const out = { left: all.length - done.length, ind, teams, m: [], f: [], hio: [], birdie: [] };
    if (hasGender()) {
      out.m = ranked(done.filter(x => x.p.g !== '여'), indKey).filter(r => r.rank === 1);
      out.f = ranked(done.filter(x => x.p.g === '여'), indKey).filter(r => r.rank === 1);
    }
    all.forEach(x => x.p.s.forEach((v, i) => { if (v === 1) out.hio.push({ x, h: i + 1 }); }));
    const bc = all.map(x => ({ x, n: x.p.s.filter((v, i) => v != null && v < G.pars[i]).length }));
    const mx = Math.max(0, ...bc.map(b => b.n));
    if (mx > 0) out.birdie = bc.filter(b => b.n === mx);
    return out;
  }
  const PL = ['우승', '준우승', '3위'];
  function rAward() {
    const a = awards();
    const card = (icon, title, body) => `<div class="aw"><h3>${icon} ${title}</h3>${body || '<p class="muted">해당 없음</p>'}</div>`;
    const indList = rows => rows.map(({ it: x, rank }) => `<p><b>${PL[rank - 1] || rank + '위'}</b> ${esc(x.p.name)} <span class="muted">${esc(x.t.name)}</span> · ${x.st.tot}타 (${fmt(x.st.tp)})</p>`).join('');
    $('#v-award').innerHTML = `<div class="panel-head"><h2>🎖️ 시상</h2>
        <div class="btns"><button class="pill" data-act="shareres">📤 결과 공유</button><button class="pill" data-act="print">🖨️ 인쇄</button></div></div>
      ${a.left ? `<div class="guide warn">아직 ${a.left}명이 경기 중입니다. 지금 시상은 경기를 끝낸 사람만으로 계산한 <b>중간 결과</b>입니다.</div>` : '<div class="guide">모든 선수의 경기가 끝났습니다. 최종 결과입니다.</div>'}
      <div class="sawards">
        ${card('🏆', '개인 순위', indList(a.ind))}
        ${card('👥', '팀 순위', a.teams.map(({ it: x, rank }) => `<p><b>${PL[rank - 1] || rank + '위'}</b> ${esc(x.t.name)} · ${x.s.tot}타 (${fmt(x.s.tp)})<br><span class="muted">${x.s.cnt.map(m => esc(m.p.name)).join(', ')}</span></p>`).join(''))}
        ${hasGender() ? card('🙋‍♂️', '남자부 1위', indList(a.m)) + card('🙋‍♀️', '여자부 1위', indList(a.f)) : ''}
        ${card('⛳', '홀인원', a.hio.map(o => `<p><b>${esc(o.x.p.name)}</b> <span class="muted">${esc(o.x.t.name)}</span> · ${o.h}번 홀 (파${G.pars[o.h - 1]})</p>`).join(''))}
        ${card('🐦', '버디왕 (파보다 적게 친 홀이 가장 많은 사람)', a.birdie.map(b => `<p><b>${esc(b.x.p.name)}</b> <span class="muted">${esc(b.x.t.name)}</span> · ${b.n}개 홀</p>`).join(''))}
      </div>`;
  }
  function resultText() {
    const a = awards();
    const L = [`[이지 파크골프 점수계산기] ${G.title} (${G.date})`, a.left ? `※ 중간 결과 (경기 중 ${a.left}명)` : '※ 최종 결과', ''];
    L.push('■ 개인'); a.ind.forEach(({ it: x, rank }) => L.push(`${PL[rank - 1] || rank + '위'} ${x.p.name}(${x.t.name}) ${x.st.tot}타 (${fmt(x.st.tp)})`));
    if (a.teams.length) { L.push('', '■ 팀'); a.teams.forEach(({ it: x, rank }) => L.push(`${PL[rank - 1] || rank + '위'} ${x.t.name} ${x.s.tot}타 - ${x.s.cnt.map(m => m.p.name).join(', ')}`)); }
    if (a.m.length || a.f.length) { L.push(''); a.m.forEach(({ it: x }) => L.push(`남자부 1위 ${x.p.name} ${x.st.tot}타`)); a.f.forEach(({ it: x }) => L.push(`여자부 1위 ${x.p.name} ${x.st.tot}타`)); }
    if (a.hio.length) L.push('', '⛳ 홀인원: ' + a.hio.map(o => `${o.x.p.name}(${o.h}번 홀)`).join(', '));
    if (a.birdie.length) L.push('🐦 버디왕: ' + a.birdie.map(b => `${b.x.p.name}(${b.n}개)`).join(', '));
    L.push('', '전체 순위: ' + location.origin + '/score');
    return L.join('\n');
  }

  // ------------------------------------------------------------ 여러 휴대폰: 팀 링크 / 점수 보내기 / 합치기
  function joinLink(ti) {
    const t = G.teams[ti];
    const code = enc({ g: G.gid, t: ti, ti: G.title, d: G.date, pa: G.pars, r: G.rule, tn: t.name, p: t.players.map(p => [p.name, p.g]) });
    return `${location.origin}/score#join=${code}`;
  }
  function resCode() {
    return enc({ g: G.gid, t: G.tix, tn: G.teams[0].name, s: G.teams[0].players.map(p => p.s) });
  }
  function mergeRes(o) {
    if (!G || G.mode !== 'main') return '점수를 합칠 게임이 이 휴대폰에 없습니다.';
    if (o.g !== G.gid) return '다른 게임의 점수입니다. 이 게임에서 보낸 링크로 입력한 점수만 합칠 수 있습니다.';
    const t = G.teams[o.t];
    if (!t || !Array.isArray(o.s)) return '점수 내용을 읽지 못했습니다.';
    let n = 0;
    t.players.forEach((p, i) => (o.s[i] || []).forEach((v, h) => {
      if (h < H() && Number.isInteger(v) && v >= 1 && v <= MAXS && p.s[h] !== v) { p.s[h] = v; n++; }
    }));
    return `${t.name} 점수를 합쳤습니다 (${n}칸 바뀜).`;
  }
  function handleHash() {
    const m = location.hash.match(/^#(join|res)=([A-Za-z0-9_-]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    let o;
    try { o = dec(m[2]); } catch (e) { toast('링크 내용을 읽지 못했습니다. 링크 전체가 복사되었는지 확인해 주세요.'); return; }
    if (m[1] === 'join') {
      if (G && G.gid === o.g && G.mode === 'team' && G.tix === o.t) { view = 'enter'; return; }
      if (G && !confirm('새 게임의 팀 입력 링크입니다. 이 휴대폰에 있던 게임 기록을 지우고 시작할까요?')) return;
      G = { v: 1, gid: o.g, mode: 'team', tix: o.t, title: o.ti, date: o.d, pars: o.pa, rule: o.r, ct: 0, ch: 0,
            teams: [{ name: o.tn, players: o.p.map(([name, g]) => ({ name, g, s: o.pa.map(() => null) })) }] };
      view = 'enter'; save();
      toast(`${o.tn} 점수 입력을 시작합니다.`);
    } else {
      toast(mergeRes(o)); view = 'grid'; save();
    }
  }

  // ------------------------------------------------------------ 이벤트
  const DEMO = '김영수 이정희:여 박철민 최순자:여 정대호 강미경:여 조성훈 윤옥자:여 장만수 임경숙:여 한상철 오말순:여'.split(' ').map(x => { const [name, g] = x.split(':'); return { name, g: g || '남' }; });
  document.addEventListener('input', e => {
    if (e.target.classList.contains('rn')) R[+e.target.dataset.i].name = e.target.value.trim();
    if (e.target.closest('#v-setup') && !G) updatePreview();
  });
  document.addEventListener('keydown', e => {   // 엔터 → 다음 줄 (마지막 줄이면 새 줄)
    if (e.key !== 'Enter' || !e.target.classList.contains('rn') || e.isComposing) return;
    e.preventDefault();
    const i = +e.target.dataset.i;
    if (i === R.length - 1) { if (!e.target.value.trim()) return; R.push({ name: '', g: '남' }); renderRoster(i + 1); }
    else { const n = $(`#f-roster .rn[data-i="${i + 1}"]`); if (n) n.focus(); }
  });
  document.addEventListener('paste', e => {      // 여러 이름을 한꺼번에 붙여 넣으면 여러 줄로 나눈다
    if (!e.target.classList.contains('rn')) return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    const names = text.split(/[\r\n,，、\t]+/).map(x => x.trim()).filter(Boolean);
    if (names.length < 2) return;
    e.preventDefault();
    const i = +e.target.dataset.i;
    const rows = names.map(x => { const n = parseName(x); return { name: n.name, g: n.g || '남' }; });
    R.splice(i, R[i].name ? 0 : 1, ...rows);
    renderRoster(i + rows.length - 1);
    toast(`${rows.length}명을 붙여 넣었습니다. 성별을 확인해 주세요.`);
  });
  document.addEventListener('change', e => {
    if (e.target.name === 'f-holes') {
      const n = parseInt(e.target.value, 10);
      $('#f-pars').innerHTML = parInputs(n === 18 ? DEF9.concat(DEF9) : DEF9);
      updatePreview();
    }
  });
  $('#sc-tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) go(b.dataset.v); });
  $('#sc').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, d = b.dataset;
    if (act === 'rtab') e.preventDefault();
    switch (act) {
      case 'demo': R = DEMO.map(x => ({ ...x })); renderRoster(); break;
      case 'radd': { const n = +d.n || 1; for (let k = 0; k < n; k++) R.push({ name: '', g: '남' }); renderRoster(R.length - n); break; }
      case 'rdel': R.splice(+d.i, 1); if (!R.length) R.push({ name: '', g: '남' }); renderRoster(); break;
      case 'g': {
        const box = b.closest('.gsel');
        box.querySelectorAll('button').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
        if (box.dataset.i != null) { R[+box.dataset.i].g = d.g; updatePreview(); }
        break;
      }
      case 'start': {
        const o = readSetup();
        if (!o.pars.every(p => Number.isInteger(p) && p >= 2 && p <= 6)) { toast('홀별 파는 2~6 사이 숫자로 적어 주세요.'); return; }
        const err = checkTeams(o.teams); if (err) { toast(err); return; }
        G = makeGame(o); go('enter'); toast('게임을 시작합니다. 1번 홀부터 입력하세요.'); break;
      }
      case 'team': G.ct = +d.t; G.ch = 0; save(); rEnter(); break;
      case 'hole': G.ch = +d.h; save(); rEnter(); break;
      case 'dec': setScore(+d.p, (v, par) => (v == null ? Math.max(1, par - 1) : v <= 1 ? null : v - 1)); break;
      case 'inc': setScore(+d.p, (v, par) => (v == null ? par + 1 : Math.min(MAXS, v + 1))); break;
      case 'par': setScore(+d.p, (v, par) => par); break;
      case 'allpar': G.teams[G.ct].players.forEach(p => { if (p.s[G.ch] == null) p.s[G.ch] = G.pars[G.ch]; }); save(); rEnter(); break;
      case 'prev': G.ch = Math.max(0, G.ch - 1); save(); rEnter(); break;
      case 'next': G.ch = Math.min(H() - 1, G.ch + 1); save(); rEnter(); break;
      case 'nextteam': G.ct++; G.ch = 0; save(); rEnter(); window.scrollTo({ top: $('#sc').offsetTop - 70, behavior: 'smooth' }); break;
      case 'torank': go('rank'); break;
      case 'goto': G.ct = +d.t; G.ch = +d.h; go('enter'); break;
      case 'rtab': rankTab = d.k; rRank(); break;
      case 'print': window.print(); break;
      case 'shareres': await share(G.title + ' 결과', resultText()); break;
      case 'sendjoin': {
        const t = G.teams[+d.t];
        await share(`${G.title} ${t.name} 점수 입력`, `[이지 파크골프] ${G.title}\n${t.name} (${t.players.map(p => p.name).join(', ')}) 점수 입력 링크입니다.\n아래 링크를 눌러 입력하세요.\n${joinLink(+d.t)}`);
        break;
      }
      case 'sendres': {
        const t = G.teams[0], hd = holesDone(t);
        if (hd < H() && !confirm(`아직 ${H() - hd}개 홀이 비어 있습니다. 지금까지 입력한 점수를 보낼까요?`)) return;
        await share(`${t.name} 점수`, `[이지 파크골프] ${G.title} - ${t.name} 점수\n(총무님: 이 메시지를 통째로 복사해 점수계산기 설정 화면의 '받은 점수 붙여넣기'에 넣어 주세요)\n${t.players.map(p => `${p.name} ${pst(p).tot}타`).join(', ')}\n${location.origin}/score#res=${resCode()}`);
        break;
      }
      case 'import': {
        const codes = [...$('#f-import').value.matchAll(/res=([A-Za-z0-9_-]+)/g)].map(m => m[1]);
        if (!codes.length) { toast('붙여 넣은 내용에서 점수를 찾지 못했습니다. 팀에서 보낸 메시지를 통째로 붙여 넣어 주세요.'); return; }
        const msgs = codes.map(c => { try { return mergeRes(dec(c)); } catch (err) { return '읽을 수 없는 점수가 있습니다.'; } });
        save(); $('#f-import').value = ''; toast(msgs.join(' ')); break;
      }
      case 'savenames': {
        document.querySelectorAll('#v-setup .tn').forEach(i => { const v = i.value.trim(); if (v) G.teams[+i.dataset.t].name = v.slice(0, 20); });
        document.querySelectorAll('#v-setup .pn').forEach(i => {
          if (!i.value.trim()) return;
          const p = G.teams[+i.dataset.t].players[+i.dataset.p];
          p.name = i.value.trim().slice(0, 20);
          const on = i.parentElement.querySelector('.gsel .on');
          p.g = on && on.dataset.g === '여' ? '여' : '남';
        });
        save(); render(); toast('이름을 저장했습니다.'); break;
      }
      case 'reset':
        if (!confirm('이 게임의 모든 점수를 지웁니다. 되돌릴 수 없습니다. 계속할까요?')) return;
        G = null; store.del(); view = 'setup'; render(); break;
    }
  });

  window.addEventListener('hashchange', () => { handleHash(); render(); });
  handleHash();
  if (!G) view = 'setup';
  render();
})();
