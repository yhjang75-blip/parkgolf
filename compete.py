"""나이스파크 대회 참가 시스템.

흐름 (파크모아·파크다 등 대회 운영 서비스의 일반적인 흐름을 참고):
  1. 대회 개설   — 관리자가 일정·장소·부문·참가비·정원·경기 코스를 입력
  2. 참가 신청   — 회원(카카오 로그인)이 이름·연락처·성별·출생연도·소속·부문을 입력
  3. 입금 확인   — 관리자가 입금을 확인하면 '참가 확정' (참가 포인트 지급)
  4. 조 편성     — 부문별로 자동 편성 (같은 클럽은 되도록 다른 조), 출발 코스·홀·시각 배정
  5. 점수·순위   — 관리자가 코스별 타수를 입력하면 부문별 순위 자동 계산 (동타는 뒤 코스부터 비교)
  6. 결과 발표   — 조편성표·결과표 공개, 인쇄용 화면 제공

공개 화면에서는 참가자 이름을 가운데 글자를 가려 보여 준다 (예: 김*수). 연락처는 관리자만 본다.
"""
import csv
import io
import math
import re
from collections import Counter

from flask import Blueprint, Response, abort, flash, g, redirect, render_template, request, url_for
from sqlalchemy import delete, desc, insert, update

import db
from community import add_points, admin_required, login_required
from db import all_, comps, entries, func, now, one, scalar, select, today, users

bp = Blueprint("compete", __name__)

ACTIVE = ("신청", "입금확인")          # 자리를 차지하는 신청
STATUS_ALL = ("신청", "입금확인", "취소요청", "취소")
HOLES_PER_COURSE = 9


# ---------------------------------------------------------------- 공통
@bp.before_request
def need_db():
    if not db.ENABLED:
        return render_template("notice.html", title="대회 참가 준비 중",
                               msg="대회 참가 신청 기능을 곧 열 예정입니다. 조금만 기다려 주세요."), 503


def mask(name):
    name = (name or "").strip()
    if len(name) <= 1:
        return name
    if len(name) == 2:
        return name[0] + "*"
    return name[0] + "*" * (len(name) - 2) + name[-1]


def split_list(s):
    return [x.strip() for x in (s or "").split(",") if x.strip()]


def counts(cid):
    rows = all_(select(entries.c.status, func.count().label("n")).where(entries.c.comp_id == cid)
                .group_by(entries.c.status))
    c = {r["status"]: r["n"] for r in rows}
    c["active"] = sum(c.get(s, 0) for s in ACTIVE)
    return c


def decorate(c, cnt=None):
    """대회 자료에 상태·부문 목록·신청 수를 붙인다."""
    cnt = cnt if cnt is not None else counts(c["id"])
    t = today()
    c["div_list"] = split_list(c["divisions"])
    c["course_list"] = split_list(c["play_courses"]) or ["A"]
    c["holes"] = len(c["course_list"]) * HOLES_PER_COURSE
    c["cnt"] = cnt
    c["full"] = bool(c["capacity"]) and cnt["active"] >= c["capacity"]
    c["can_apply"] = False
    if c["hidden"]:
        c["state"], c["tone"] = "준비 중", "gray"
    elif t < c["open_date"]:
        c["state"], c["tone"] = f"접수 예정 ({c['open_date'][5:].replace('-', '/')}부터)", "warn"
    elif t <= c["close_date"] and not c["closed"] and not c["full"]:
        c["state"], c["tone"], c["can_apply"] = "접수 중", "ok", True
    elif t < c["play_date"]:
        c["state"], c["tone"] = "정원 마감" if c["full"] else "접수 마감", "gray"
    elif t == c["play_date"]:
        c["state"], c["tone"] = "오늘 대회", "live"
    else:
        c["state"], c["tone"] = ("결과 발표" if c["results_open"] else "대회 종료"), "gray"
    c["dday"] = None
    if c["can_apply"]:
        from datetime import date
        c["dday"] = (date.fromisoformat(c["close_date"]) - date.fromisoformat(t)).days
    return c


def get_comp(cid, admin=False):
    c = one(select(comps).where(comps.c.id == cid))
    if not c or (c["hidden"] and not admin and not (g.user and g.user["is_admin"])):
        abort(404)
    return decorate(c)


def open_comps(limit=6):
    """첫 화면용: 접수 중·예정이거나 곧 열릴 대회."""
    if not db.ENABLED:
        return []
    try:
        rows = all_(select(comps).where(comps.c.hidden.is_(False), comps.c.play_date >= today())
                    .order_by(comps.c.play_date).limit(limit))
    except Exception:
        return []
    return [decorate(c) for c in rows]


def my_entry(cid):
    if not g.user:
        return None
    return one(select(entries).where(entries.c.comp_id == cid, entries.c.user_id == g.user["id"]))


def parse_scores(s, n):
    vals = [x.strip() for x in (s or "").split(",")]
    vals = (vals + [""] * n)[:n]
    return [int(v) if v.isdigit() else None for v in vals]


def ranked(c):
    """부문별 순위표. 코스별 타수를 모두 입력한 참가 확정자만, 동타면 마지막 코스부터 비교 (백카운트)."""
    rows = all_(select(entries).where(entries.c.comp_id == c["id"], entries.c.status == "입금확인"))
    n = len(c["course_list"])
    out = []
    for d in c["div_list"] + sorted({r["division"] for r in rows} - set(c["div_list"])):
        done, todo = [], []
        for r in rows:
            if r["division"] != d:
                continue
            r["score_list"] = parse_scores(r["scores"], n)
            (done if r["total"] is not None else todo).append(r)
        done.sort(key=lambda r: (r["total"], list(reversed(r["score_list"]))))
        prev, rank = None, 0
        for i, r in enumerate(done, 1):
            key = (r["total"], list(reversed(r["score_list"])))
            if key != prev:
                rank, prev = i, key
            r["place"] = rank
        if done or todo:
            out.append({"division": d, "rows": done, "todo": todo})
    return out


def groups_of(c):
    rows = all_(select(entries).where(entries.c.comp_id == c["id"], entries.c.group_no.isnot(None),
                                      entries.c.status.in_(ACTIVE)).order_by(entries.c.group_no, entries.c.id))
    out = {}
    for r in rows:
        grp = out.setdefault(r["group_no"], {"no": r["group_no"], "spot": r["start_spot"], "time": r["tee_time"],
                                             "division": r["division"], "players": []})
        grp["players"].append(r)
    return list(out.values())


# ---------------------------------------------------------------- 참가자 화면
@bp.get("/compete")
def list_page():
    rows = all_(select(comps).where(comps.c.hidden.is_(False)).order_by(desc(comps.c.play_date)).limit(60))
    t = today()
    items = [decorate(c) for c in rows]
    upcoming = sorted([c for c in items if c["play_date"] >= t], key=lambda c: c["play_date"])
    past = [c for c in items if c["play_date"] < t]
    mine = {}
    if g.user:
        mine = {e["comp_id"]: e for e in all_(select(entries).where(entries.c.user_id == g.user["id"]))}
    return render_template("compete_list.html", upcoming=upcoming, past=past, mine=mine)


@bp.get("/compete/<int:cid>")
def view(cid):
    c = get_comp(cid)
    lst = all_(select(entries.c.name, entries.c.club, entries.c.division, entries.c.status)
               .where(entries.c.comp_id == cid, entries.c.status.in_(ACTIVE)).order_by(entries.c.id))
    by_div = {}
    for e in lst:
        by_div.setdefault(e["division"], []).append(e)
    course = None
    if c["course_id"]:
        from community import courses_by_id
        course = courses_by_id().get(c["course_id"])
    return render_template("compete_view.html", c=c, my=my_entry(cid), by_div=by_div, mask=mask, course=course,
                           groups=groups_of(c) if c["groups_open"] else [],
                           results=ranked(c) if c["results_open"] else [])


def clean_phone(s):
    d = re.sub(r"\D", "", s or "")
    if not re.fullmatch(r"01\d{8,9}", d):
        return None
    return f"{d[:3]}-{d[3:-4]}-{d[-4:]}"


@bp.route("/compete/<int:cid>/apply", methods=["GET", "POST"])
@login_required
def apply(cid):
    c = get_comp(cid)
    my = my_entry(cid)
    editing = my and my["status"] in ACTIVE
    if not c["can_apply"] and not (editing and today() <= c["close_date"]):
        flash("지금은 이 대회에 신청할 수 없습니다.")
        return redirect(url_for("compete.view", cid=cid))
    if request.method == "POST":
        f = request.form
        name = re.sub(r"\s+", "", f.get("name", ""))[:30]
        phone = clean_phone(f.get("phone"))
        gender = f.get("gender") if f.get("gender") in ("남", "여") else None
        by = f.get("birth_year", "")
        by = int(by) if by.isdigit() and 1920 <= int(by) <= 2015 else None
        div = f.get("division") if f.get("division") in c["div_list"] else None
        err = None
        if len(name) < 2:
            err = "이름을 정확히 적어 주세요."
        elif not phone:
            err = "휴대폰 번호를 정확히 적어 주세요. (예: 010-1234-5678)"
        elif not gender:
            err = "성별을 골라 주세요."
        elif not by:
            err = "출생연도를 4자리로 적어 주세요. (예: 1958)"
        elif not div:
            err = "참가 부문을 골라 주세요."
        elif not f.get("agree"):
            err = "개인정보 수집·이용에 동의해 주셔야 신청할 수 있습니다."
        if err:
            flash(err)
            return render_template("compete_apply.html", c=c, my=my, form=f)
        vals = {"name": name, "phone": phone, "gender": gender, "birth_year": by,
                "club": re.sub(r"\s+", " ", f.get("club", "")).strip()[:60] or None,
                "division": div, "memo": f.get("memo", "").strip()[:300] or None}
        with db.engine.begin() as conn:
            if my:
                if not editing:  # 취소했던 신청을 다시 접수
                    if not c["can_apply"]:
                        abort(400)
                    vals.update(status="신청", group_no=None, start_spot=None, tee_time=None, scores=None,
                                total=None, rank=None, paid_at=None, created_at=now())
                conn.execute(update(entries).where(entries.c.id == my["id"]).values(**vals))
            else:
                conn.execute(insert(entries).values(comp_id=cid, user_id=g.user["id"], status="신청",
                                                    created_at=now(), **vals))
        flash("신청 내용을 고쳤습니다." if editing else
              "참가 신청이 접수되었습니다. 참가비를 입금하시면 주최 측 확인 후 '참가 확정'으로 바뀝니다."
              if c["fee"] else "참가 신청이 접수되었습니다. 주최 측 확인 후 '참가 확정'으로 바뀝니다.")
        return redirect(url_for("compete.view", cid=cid) + "#my-entry")
    form = dict(my) if my else {"name": "", "division": c["div_list"][0] if len(c["div_list"]) == 1 else ""}
    return render_template("compete_apply.html", c=c, my=my, form=form)


@bp.post("/compete/<int:cid>/cancel")
@login_required
def cancel(cid):
    my = my_entry(cid)
    if not my or my["status"] not in ACTIVE:
        abort(400)
    # 입금 전이면 바로 취소, 입금 후면 환불이 필요하므로 '취소 요청'
    new = "취소" if my["status"] == "신청" else "취소요청"
    with db.engine.begin() as conn:
        conn.execute(update(entries).where(entries.c.id == my["id"]).values(status=new, group_no=None,
                                                                             start_spot=None, tee_time=None))
    flash("신청을 취소했습니다." if new == "취소" else
          "취소를 요청했습니다. 참가비 환불은 주최 측이 확인 후 연락드립니다.")
    return redirect(url_for("compete.view", cid=cid))


@bp.get("/compete/<int:cid>/print/<kind>")
def print_page(cid, kind):
    c = get_comp(cid)
    admin = bool(g.user and g.user["is_admin"])
    if kind == "groups" and (c["groups_open"] or admin):
        return render_template("compete_print.html", c=c, kind=kind, groups=groups_of(c), admin=admin, mask=mask)
    if kind == "results" and (c["results_open"] or admin):
        return render_template("compete_print.html", c=c, kind=kind, results=ranked(c), admin=admin, mask=mask)
    if kind == "cards" and admin:
        return render_template("compete_print.html", c=c, kind=kind, groups=groups_of(c), admin=admin, mask=mask)
    abort(404)


# ---------------------------------------------------------------- 관리자: 대회 개설·관리
@bp.get("/admin/compete")
@admin_required
def admin_list():
    rows = all_(select(comps).order_by(desc(comps.c.play_date)))
    return render_template("compete_admin.html", items=[decorate(c) for c in rows])


@bp.route("/admin/compete/new", methods=["GET", "POST"])
@bp.route("/admin/compete/<int:cid>/edit", methods=["GET", "POST"])
@admin_required
def admin_edit(cid=None):
    c = one(select(comps).where(comps.c.id == cid)) if cid else None
    if cid and not c:
        abort(404)
    if request.method == "POST":
        f = request.form
        date_re = r"\d{4}-\d{2}-\d{2}"
        vals = {
            "title": f.get("title", "").strip()[:120], "venue": f.get("venue", "").strip()[:120],
            "play_date": f.get("play_date", ""), "open_date": f.get("open_date", ""), "close_date": f.get("close_date", ""),
            "course_id": f.get("course_id", "").strip()[:20] or None,
            "host": f.get("host", "").strip()[:120] or None, "contact": f.get("contact", "").strip()[:120] or None,
            "divisions": ",".join(split_list(f.get("divisions")))[:200],
            "fee": max(0, int(f.get("fee") or 0)), "pay_info": f.get("pay_info", "").strip()[:300] or None,
            "capacity": max(0, int(f.get("capacity") or 0)),
            "play_courses": ",".join(x.upper() for x in split_list(f.get("play_courses")))[:40] or "A",
            "group_size": min(6, max(2, int(f.get("group_size") or 4))),
            "start_time": f.get("start_time", "08:00")[:5], "wave_gap": max(0, int(f.get("wave_gap") or 0)),
            "format": f.get("format", "").strip()[:200] or None, "body": f.get("body", "").strip()[:8000] or None,
            "hidden": bool(f.get("hidden")),
        }
        bad = (not vals["title"] or not vals["venue"] or not vals["divisions"]
               or not all(re.fullmatch(date_re, vals[k]) for k in ("play_date", "open_date", "close_date"))
               or not re.fullmatch(r"\d{2}:\d{2}", vals["start_time"]))
        if not bad and not (vals["open_date"] <= vals["close_date"] <= vals["play_date"]):
            flash("날짜 순서를 확인해 주세요: 접수 시작 ≤ 접수 마감 ≤ 대회일")
            bad = True
        if bad:
            flash("대회 이름·장소·부문·날짜·출발 시각을 빠짐없이 바르게 적어 주세요.")
            return render_template("compete_edit.html", c=dict(vals, id=cid))
        with db.engine.begin() as conn:
            if cid:
                conn.execute(update(comps).where(comps.c.id == cid).values(**vals))
            else:
                cid = conn.execute(insert(comps).values(created_at=now(), **vals)).inserted_primary_key[0]
        flash("대회 정보를 저장했습니다.")
        return redirect(url_for("compete.admin_manage", cid=cid))
    if not c:
        t = today()
        c = {"title": "", "venue": "", "play_date": "", "open_date": t, "close_date": "", "divisions": "남자부,여자부",
             "fee": 20000, "capacity": 0, "play_courses": "A,B,C,D", "group_size": 4, "start_time": "08:00",
             "wave_gap": 30, "format": "36홀 스트로크 (4개 코스 × 9홀), 개인전", "hidden": True}
    return render_template("compete_edit.html", c=c)


@bp.get("/admin/compete/<int:cid>")
@admin_required
def admin_manage(cid):
    c = get_comp(cid, admin=True)
    rows = all_(select(entries, users.c.nickname).join(users).where(entries.c.comp_id == cid)
                .order_by(entries.c.group_no.is_(None), entries.c.group_no, entries.c.division, entries.c.id))
    n = len(c["course_list"])
    for r in rows:
        r["score_list"] = parse_scores(r["scores"], n)
    st = request.args.get("status", "")
    shown = [r for r in rows if not st or r["status"] == st]
    return render_template("compete_manage.html", c=c, rows=shown, all_count=len(rows), st=st,
                           STATUS_ALL=STATUS_ALL, results=ranked(c))


@bp.post("/admin/compete/<int:cid>/entry/<int:eid>/<action>")
@admin_required
def admin_entry(cid, eid, action):
    e = one(select(entries).where(entries.c.id == eid, entries.c.comp_id == cid))
    if not e:
        abort(404)
    vals = {"paid": {"status": "입금확인", "paid_at": now()},
            "unpaid": {"status": "신청", "paid_at": None},
            "cancel": {"status": "취소", "group_no": None, "start_spot": None, "tee_time": None},
            "restore": {"status": "신청"}}.get(action)
    if not vals:
        abort(400)
    with db.engine.begin() as conn:
        conn.execute(update(entries).where(entries.c.id == eid).values(**vals))
    if action == "paid" and e["status"] != "입금확인":
        add_points(e["user_id"], "대회 참가")
    return redirect(url_for("compete.admin_manage", cid=cid, status=request.args.get("status", "")) + "#entries")


@bp.post("/admin/compete/<int:cid>/toggle/<field>")
@admin_required
def admin_toggle(cid, field):
    if field not in ("closed", "groups_open", "results_open", "hidden"):
        abort(400)
    col = comps.c[field]
    with db.engine.begin() as conn:
        conn.execute(update(comps).where(comps.c.id == cid).values({col: ~col}))
    return redirect(url_for("compete.admin_manage", cid=cid))


@bp.post("/admin/compete/<int:cid>/delete")
@admin_required
def admin_delete(cid):
    with db.engine.begin() as conn:
        conn.execute(delete(entries).where(entries.c.comp_id == cid))
        conn.execute(delete(comps).where(comps.c.id == cid))
    flash("대회와 신청 자료를 모두 지웠습니다.")
    return redirect(url_for("compete.admin_list"))


def make_groups(c, players):
    """부문별로 조를 만든다. 같은 클럽 회원은 되도록 다른 조로 흩어지게, 조 인원은 고르게."""
    size = c["group_size"]
    out = []
    divs = c["div_list"] + sorted({p["division"] for p in players} - set(c["div_list"]))
    for d in divs:
        ps = [p for p in players if p["division"] == d]
        if not ps:
            continue
        k = math.ceil(len(ps) / size)
        club_n = Counter((p["club"] or f"#{p['id']}") for p in ps)
        ps.sort(key=lambda p: (-club_n[p["club"] or f"#{p['id']}"], p["club"] or "", p["id"]))
        grps = [[] for _ in range(k)]
        for i, p in enumerate(ps):  # 큰 클럽부터 한 명씩 돌아가며 배치
            grps[i % k].append(p)
        out.extend(grps)
    return out


def spot_and_time(c, idx):
    """idx 번째 조(0부터)의 출발 위치·시각. 모든 코스·홀에서 동시에 출발(샷건)하고, 자리가 모자라면 다음 순번."""
    slots = [f"{course}-{h}" for course in c["course_list"] for h in range(1, HOLES_PER_COURSE + 1)]
    wave, slot = divmod(idx, len(slots))
    hh, mm = map(int, c["start_time"].split(":"))
    m = hh * 60 + mm + wave * c["wave_gap"]
    return slots[slot], f"{m // 60 % 24:02d}:{m % 60:02d}"


@bp.post("/admin/compete/<int:cid>/groups")
@admin_required
def admin_groups(cid):
    c = get_comp(cid, admin=True)
    sts = ("입금확인",) if request.form.get("only_paid") else ACTIVE
    players = all_(select(entries).where(entries.c.comp_id == cid, entries.c.status.in_(sts)))
    grps = make_groups(c, players)
    with db.engine.begin() as conn:
        conn.execute(update(entries).where(entries.c.comp_id == cid).values(group_no=None, start_spot=None, tee_time=None))
        for i, grp in enumerate(grps):
            spot, tm = spot_and_time(c, i)
            for p in grp:
                conn.execute(update(entries).where(entries.c.id == p["id"]).values(group_no=i + 1, start_spot=spot,
                                                                                   tee_time=tm))
    flash(f"{len(players)}명을 {len(grps)}개 조로 편성했습니다. 표에서 조·출발 위치를 직접 고칠 수도 있습니다.")
    return redirect(url_for("compete.admin_manage", cid=cid) + "#entries")


@bp.post("/admin/compete/<int:cid>/save")
@admin_required
def admin_save(cid):
    """표에서 고친 조 번호·출발 위치·시각과 코스별 타수를 한꺼번에 저장."""
    c = get_comp(cid, admin=True)
    n = len(c["course_list"])
    f = request.form
    ids = [int(x) for x in f.getlist("eid") if x.isdigit()]
    with db.engine.begin() as conn:
        for eid in ids:
            sc = []
            for i in range(n):
                v = f.get(f"s_{eid}_{i}", "").strip()
                sc.append(int(v) if v.isdigit() and 0 < int(v) < 200 else None)
            g_no = f.get(f"g_{eid}", "").strip()
            conn.execute(update(entries).where(entries.c.id == eid, entries.c.comp_id == cid).values(
                group_no=int(g_no) if g_no.isdigit() else None,
                start_spot=f.get(f"spot_{eid}", "").strip()[:10] or None,
                tee_time=f.get(f"time_{eid}", "").strip()[:5] or None,
                scores=",".join("" if s is None else str(s) for s in sc) if any(s is not None for s in sc) else None,
                total=sum(sc) if all(s is not None for s in sc) else None))
    flash("저장했습니다.")
    return redirect(url_for("compete.admin_manage", cid=cid, status=request.args.get("status", "")) + "#entries")


@bp.get("/admin/compete/<int:cid>/csv")
@admin_required
def admin_csv(cid):
    c = get_comp(cid, admin=True)
    rows = all_(select(entries).where(entries.c.comp_id == cid).order_by(entries.c.id))
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["접수번호", "이름", "휴대폰", "성별", "출생연도", "소속", "부문", "상태", "조", "출발", "시각",
                *[f"{x}코스" for x in c["course_list"]], "합계", "요청사항", "신청일", "입금확인일"])
    for r in rows:
        w.writerow([r["id"], r["name"], r["phone"], r["gender"], r["birth_year"], r["club"] or "", r["division"],
                    r["status"], r["group_no"] or "", r["start_spot"] or "", r["tee_time"] or "",
                    *[s if s is not None else "" for s in parse_scores(r["scores"], len(c["course_list"]))],
                    r["total"] if r["total"] is not None else "", r["memo"] or "", r["created_at"], r["paid_at"] or ""])
    data = "﻿" + buf.getvalue()  # 엑셀에서 한글이 깨지지 않도록
    return Response(data, mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename=entries_{cid}.csv"})
