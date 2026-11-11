"""나이스파크 회원·커뮤니티 기능.

- 카카오 로그인 (가입 = 처음 로그인 + 약관 동의)
- 게시판 (글·사진·댓글·추천·신고)
- 포인트·등급, 이달의 나이스 회원
- 제휴 혜택 교환, 관리자 화면
- 사이트 소개·이용약관·개인정보처리방침

필요한 환경변수 (README 참고)
  KAKAO_REST_API_KEY   카카오 앱의 REST API 키 (로그인에 사용)
  KAKAO_CLIENT_SECRET  카카오 로그인 '클라이언트 시크릿'을 켠 경우만
  ADMIN_KAKAO_IDS      관리자 카카오 회원번호 (쉼표로 여러 명)
  DATABASE_URL         Neon 등 Postgres 주소 (없으면 내 PC 시험용 SQLite)
  SECRET_KEY           로그인 유지용 비밀값
  DEV_LOGIN=1          내 PC 시험용 가짜 로그인 (공개 서버에서는 동작하지 않음)
"""
import io
import json
import math
import os
import re
import secrets
import time
from functools import wraps
from pathlib import Path
from urllib.parse import urlencode

import requests
from flask import (Blueprint, Response, abort, current_app, flash, g, jsonify, redirect, render_template,
                   request, session, url_for)
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import and_, delete, desc, insert, or_, update

import db
from db import (all_, benefits, comments, favorites, func, images, likes, now, one, point_log, posts,
                redemptions, reports, scalar, select, today, users)

bp = Blueprint("community", __name__)
ROOT = Path(__file__).resolve().parent

KAKAO_KEY = os.environ.get("KAKAO_REST_API_KEY", "")
KAKAO_SECRET = os.environ.get("KAKAO_CLIENT_SECRET", "")
ADMIN_IDS = {x.strip() for x in os.environ.get("ADMIN_KAKAO_IDS", "").split(",") if x.strip()}
DEV_LOGIN = os.environ.get("DEV_LOGIN") == "1" and not db.ON_SERVER

CATEGORIES = {
    "free": "자유게시판",
    "review": "구장 후기",
    "photo": "사진 자랑",
    "tour": "대회 이야기",
    "qna": "질문·정보",
}
# 등급: 지금까지 모은 포인트(earned) 기준
GRADES = [(0, "새싹", "🌱"), (100, "버디", "🐦"), (300, "이글", "🦅"), (700, "알바트로스", "🕊️"), (1500, "홀인원", "⛳")]
# 포인트 규칙: (점수, 하루 최대 횟수)
RULES = {
    "가입 축하": (20, 1),
    "출석": (1, 1),
    "글쓰기": (10, 3),
    "사진 올리기": (5, 3),
    "댓글": (2, 10),
    "추천 받음": (1, 20),
}
MAX_PHOTOS = 4
MAX_PHOTO_BYTES = 15 * 1024 * 1024
HIDE_AFTER_REPORTS = 3


def grade_of(earned):
    lv = 0
    for i, (need, _, _) in enumerate(GRADES):
        if (earned or 0) >= need:
            lv = i
    need_next = GRADES[lv + 1][0] if lv + 1 < len(GRADES) else None
    return {"level": lv, "name": GRADES[lv][1], "icon": GRADES[lv][2], "next": need_next}


def site_info():
    return json.loads((ROOT / "data" / "site.json").read_text(encoding="utf-8"))


def courses_by_id():
    return current_app.config["COURSE_DB"]()["by_id"]  # 구장 자료 (app.py)


# ---------------------------------------------------------------- 공통
@bp.before_app_request
def load_user():
    g.user = None
    g.db_on = db.ENABLED
    if not db.ENABLED:
        return
    uid = session.get("uid")
    if uid:
        u = one(select(users).where(users.c.id == uid))
        if u and not u["banned"]:
            u["grade"] = grade_of(u["earned"])
            u["is_admin"] = u["kakao_id"] in ADMIN_IDS or (DEV_LOGIN and u["kakao_id"] == "dev:시험회원")
            g.user = u
            if u["agreed_at"] and u["last_attend"] != today():
                with db.engine.begin() as c:
                    c.execute(update(users).where(users.c.id == uid).values(last_attend=today()))
                add_points(uid, "출석")
        else:
            session.pop("uid", None)


@bp.before_app_request
def csrf_check():
    if request.method == "POST" and request.blueprint == "community":
        token = request.form.get("csrf") or request.headers.get("X-CSRF")
        if not token or token != session.get("csrf"):
            abort(400, "보안 확인값이 맞지 않습니다. 새로고침 후 다시 시도해 주세요.")


@bp.app_context_processor
def inject():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(24)
    return {"me": g.get("user"), "csrf": session["csrf"], "CATEGORIES": CATEGORIES, "GRADES": GRADES,
            "db_on": db.ENABLED, "site": site_info(), "grade_of": grade_of, "regions": regions}


def regions():
    """관심 지역 선택용: {시도: [시군구, ...]} (구장이 있는 곳만)."""
    out = {}
    for c in courses_by_id().values():
        out.setdefault(c["sido"], set()).add(c["sigungu"])
    return {s: sorted(x for x in v if x) for s, v in sorted(out.items())}


def login_required(fn):
    @wraps(fn)
    def wrap(*a, **k):
        if not db.ENABLED:
            return render_template("notice.html", title="준비 중", msg="회원 기능을 준비하고 있습니다."), 503
        if not g.user:
            if request.path.startswith("/api/"):
                return jsonify({"error": "로그인이 필요합니다."}), 401
            return redirect(url_for("community.login", next=request.full_path))
        if not g.user["agreed_at"]:
            return redirect(url_for("community.agree", next=request.full_path))
        return fn(*a, **k)
    return wrap


def admin_required(fn):
    @wraps(fn)
    @login_required
    def wrap(*a, **k):
        if not g.user["is_admin"]:
            abort(403)
        return fn(*a, **k)
    return wrap


def safe_next(nxt):
    return nxt if nxt and nxt.startswith("/") and not nxt.startswith("//") else "/"


def add_points(uid, reason, n=1):
    """규칙에 따라 포인트를 준다. 하루 최대 횟수를 넘으면 주지 않는다."""
    pts, cap = RULES[reason]
    day = today()
    with db.engine.begin() as c:
        used = c.execute(select(func.count()).select_from(point_log).where(
            point_log.c.user_id == uid, point_log.c.reason == reason, point_log.c.day == day)).scalar()
        if used >= cap:
            return 0
        c.execute(insert(point_log).values(user_id=uid, delta=pts * n, reason=reason, day=day, created_at=now()))
        c.execute(update(users).where(users.c.id == uid).values(
            points=users.c.points + pts * n, earned=users.c.earned + pts * n))
    return pts * n


# ---------------------------------------------------------------- 로그인 (카카오)
@bp.before_request
def need_db():
    """DB 가 연결되지 않은 공개 서버에서는 회원·게시판 화면 대신 안내를 보여 준다."""
    if not db.ENABLED and request.endpoint not in ("community.about", "community.terms", "community.privacy",
                                                    "community.benefits_page", "community.api_me",
                                                    "community.api_latest", "community.api_course_posts"):
        return render_template("notice.html", title="회원 기능 준비 중",
                               msg="커뮤니티·회원 기능을 곧 열 예정입니다. 조금만 기다려 주세요."), 503


@bp.get("/login")
def login():
    if g.user:
        return redirect(safe_next(request.args.get("next")))
    return render_template("login.html", next=safe_next(request.args.get("next")),
                           kakao_ready=bool(KAKAO_KEY), dev_login=DEV_LOGIN)


@bp.get("/auth/kakao")
def kakao_start():
    if not KAKAO_KEY:
        abort(503, "카카오 로그인 설정이 아직 되지 않았습니다.")
    state = secrets.token_urlsafe(16)
    session["oauth_state"] = state
    session["after_login"] = safe_next(request.args.get("next"))
    q = urlencode({"client_id": KAKAO_KEY, "redirect_uri": url_for("community.kakao_callback", _external=True),
                   "response_type": "code", "state": state})
    return redirect(f"https://kauth.kakao.com/oauth/authorize?{q}")


@bp.get("/auth/kakao/callback")
def kakao_callback():
    if request.args.get("error"):
        flash("카카오 로그인을 취소했습니다.")
        return redirect(url_for("community.login"))
    if not request.args.get("state") or request.args.get("state") != session.pop("oauth_state", None):
        abort(400, "로그인 확인값이 맞지 않습니다. 다시 시도해 주세요.")
    data = {"grant_type": "authorization_code", "client_id": KAKAO_KEY, "code": request.args.get("code", ""),
            "redirect_uri": url_for("community.kakao_callback", _external=True)}
    if KAKAO_SECRET:
        data["client_secret"] = KAKAO_SECRET
    try:
        t = requests.post("https://kauth.kakao.com/oauth/token", data=data, timeout=10)
        t.raise_for_status()
        token = t.json()["access_token"]
        me = requests.get("https://kapi.kakao.com/v2/user/me", timeout=10,
                          headers={"Authorization": f"Bearer {token}"}).json()
    except (requests.RequestException, KeyError, ValueError):
        current_app.logger.exception("kakao login failed")
        flash("카카오 로그인 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.")
        return redirect(url_for("community.login"))
    prof = (me.get("kakao_account") or {}).get("profile") or {}
    props = me.get("properties") or {}
    nickname = (prof.get("nickname") or props.get("nickname") or "파크골퍼")[:20]
    img = prof.get("thumbnail_image_url") or props.get("thumbnail_image")
    return finish_login(f"kakao:{me['id']}", nickname, img)


@bp.get("/auth/dev")
def dev_login():
    """내 PC 시험용 로그인 (DEV_LOGIN=1, 공개 서버에서는 꺼짐)."""
    if not DEV_LOGIN:
        abort(404)
    name = (request.args.get("name") or "시험회원")[:20]
    session["after_login"] = safe_next(request.args.get("next"))
    return finish_login(f"dev:{name}", name, None)


def finish_login(kakao_id, nickname, img):
    u = one(select(users).where(users.c.kakao_id == kakao_id))
    with db.engine.begin() as c:
        if u:
            c.execute(update(users).where(users.c.id == u["id"]).values(profile_img=img))
            uid = u["id"]
        else:
            uid = c.execute(insert(users).values(kakao_id=kakao_id, nickname=nickname, profile_img=img, points=0,
                                                 earned=0, created_at=now())).inserted_primary_key[0]
    if u and u["banned"]:
        flash("이용이 제한된 계정입니다. 운영자에게 문의해 주세요.")
        return redirect("/")
    nxt = session.get("after_login") or "/"
    session.clear()  # 로그인 때 세션을 새로 만든다 (세션 고정 공격 방지)
    session["uid"] = uid
    session.permanent = True
    if not u or not u["agreed_at"]:
        return redirect(url_for("community.agree", next=safe_next(nxt)))
    return redirect(safe_next(nxt))


@bp.route("/join/agree", methods=["GET", "POST"])
def agree():
    if not g.user:
        return redirect(url_for("community.login"))
    if request.method == "POST":
        if not (request.form.get("terms") and request.form.get("privacy") and request.form.get("age14")):
            flash("필수 항목에 모두 동의해 주세요.")
            return redirect(request.full_path)
        nick = clean_nick(request.form.get("nickname")) or g.user["nickname"]
        first = not g.user["agreed_at"]
        with db.engine.begin() as c:
            c.execute(update(users).where(users.c.id == g.user["id"]).values(
                agreed_at=now(), nickname=nick, marketing=bool(request.form.get("marketing")),
                fav_sido=request.form.get("fav_sido") or None, fav_sigungu=request.form.get("fav_sigungu") or None))
        if first:
            add_points(g.user["id"], "가입 축하")
            flash("나이스파크 회원이 되신 것을 환영합니다! 가입 축하 20포인트를 드렸습니다.")
        return redirect(safe_next(request.form.get("next")))
    return render_template("agree.html", next=safe_next(request.args.get("next")))


@bp.post("/logout")
def logout():
    session.clear()
    return redirect("/")


def clean_nick(s):
    s = re.sub(r"\s+", " ", (s or "")).strip()[:20]
    return s if len(s) >= 2 else None


# ---------------------------------------------------------------- 마이페이지·맞춤 정보
@bp.route("/me", methods=["GET", "POST"])
@login_required
def me():
    uid = g.user["id"]
    if request.method == "POST":
        nick = clean_nick(request.form.get("nickname"))
        if not nick:
            flash("닉네임은 2~20자로 적어 주세요.")
        else:
            with db.engine.begin() as c:
                c.execute(update(users).where(users.c.id == uid).values(
                    nickname=nick, fav_sido=request.form.get("fav_sido") or None,
                    fav_sigungu=request.form.get("fav_sigungu") or None,
                    marketing=bool(request.form.get("marketing"))))
            flash("저장했습니다.")
        return redirect(url_for("community.me"))
    byid = courses_by_id()
    favs = [byid[f["course_id"]] for f in all_(select(favorites).where(favorites.c.user_id == uid)
                                               .order_by(desc(favorites.c.created_at))) if f["course_id"] in byid]
    my_posts = all_(select(posts).where(posts.c.user_id == uid).order_by(desc(posts.c.id)).limit(10))
    log = all_(select(point_log).where(point_log.c.user_id == uid).order_by(desc(point_log.c.id)).limit(15))
    reds = all_(select(redemptions, benefits.c.title, benefits.c.partner).join(benefits)
                .where(redemptions.c.user_id == uid).order_by(desc(redemptions.c.id)).limit(10))
    return render_template("me.html", favs=favs, my_posts=my_posts, log=log, reds=reds)


@bp.post("/me/withdraw")
@login_required
def withdraw():
    """회원 탈퇴: 회원 정보와 쓴 글·댓글·사진을 모두 지운다."""
    uid = g.user["id"]
    with db.engine.begin() as c:
        pids = [r[0] for r in c.execute(select(posts.c.id).where(posts.c.user_id == uid))]
        if pids:
            c.execute(delete(images).where(images.c.post_id.in_(pids)))
            c.execute(delete(comments).where(comments.c.post_id.in_(pids)))
            c.execute(delete(likes).where(likes.c.post_id.in_(pids)))
        for t in (comments, likes, favorites, point_log, reports, redemptions):
            c.execute(delete(t).where(t.c.user_id == uid))
        c.execute(delete(posts).where(posts.c.user_id == uid))
        c.execute(delete(users).where(users.c.id == uid))
    session.clear()
    flash("탈퇴했습니다. 회원 정보와 작성한 글이 모두 삭제되었습니다.")
    return redirect("/")


@bp.get("/api/me")
def api_me():
    if not db.ENABLED:
        return jsonify({"enabled": False})
    u = g.user
    if not u or not u["agreed_at"]:
        return jsonify({"enabled": True, "login": False})
    byid = courses_by_id()
    favs = []
    for f in all_(select(favorites).where(favorites.c.user_id == u["id"]).order_by(desc(favorites.c.created_at))):
        c = byid.get(f["course_id"])
        if c:
            favs.append({k: c.get(k) for k in ("id", "name", "sido", "sigungu", "holes", "reserve_level",
                                                "reserve_url", "photo")} | {"portal": c.get("portal")})
    return jsonify({"enabled": True, "login": True, "nickname": u["nickname"], "points": u["points"],
                    "earned": u["earned"], "grade": u["grade"], "favorites": favs,
                    "fav_sido": u["fav_sido"], "fav_sigungu": u["fav_sigungu"], "admin": u["is_admin"]})


@bp.post("/api/me/favorites/<cid>")
@login_required
def toggle_fav(cid):
    if cid not in courses_by_id():
        abort(404)
    uid = g.user["id"]
    cond = and_(favorites.c.user_id == uid, favorites.c.course_id == cid)
    with db.engine.begin() as c:
        if c.execute(select(favorites).where(cond)).first():
            c.execute(delete(favorites).where(cond))
            on = False
        else:
            c.execute(insert(favorites).values(user_id=uid, course_id=cid, created_at=now()))
            on = True
    return jsonify({"favorite": on})


# ---------------------------------------------------------------- 게시판
PAGE = 20


def post_query():
    return (select(posts, users.c.nickname, users.c.earned).join(users, users.c.id == posts.c.user_id))


@bp.get("/board")
def board():
    if not db.ENABLED:
        return render_template("notice.html", title="커뮤니티 준비 중", msg="게시판을 준비하고 있습니다."), 503
    cat = request.args.get("cat") if request.args.get("cat") in CATEGORIES else None
    q = (request.args.get("q") or "").strip()[:40]
    course = request.args.get("course")
    page = max(1, int(request.args.get("page", 1) or 1))
    cond = [posts.c.hidden.is_(False)]
    if cat:
        cond.append(posts.c.category == cat)
    if course:
        cond.append(posts.c.course_id == course)
    if q:
        cond.append(or_(posts.c.title.contains(q), posts.c.body.contains(q)))
    total = scalar(select(func.count()).select_from(posts).where(*cond))
    rows = all_(post_query().where(*cond).order_by(desc(posts.c.id)).offset((page - 1) * PAGE).limit(PAGE))
    first_img = {}
    if rows:
        for r in all_(select(images.c.post_id, func.min(images.c.id).label("img"))
                      .where(images.c.post_id.in_([p["id"] for p in rows])).group_by(images.c.post_id)):
            first_img[r["post_id"]] = r["img"]
    byid = courses_by_id()
    return render_template("board.html", rows=rows, cat=cat, q=q, page=page, pages=max(1, math.ceil(total / PAGE)),
                           total=total, first_img=first_img, course=byid.get(course) if course else None, byid=byid)


@bp.get("/board/<int:pid>")
def view(pid):
    if not db.ENABLED:
        abort(503)
    p = one(post_query().where(posts.c.id == pid))
    if not p or (p["hidden"] and not (g.user and (g.user["is_admin"] or g.user["id"] == p["user_id"]))):
        abort(404)
    seen = session.get("seen", [])
    if pid not in seen:  # 같은 사람이 새로고침해도 조회수는 한 번만
        with db.engine.begin() as c:
            c.execute(update(posts).where(posts.c.id == pid).values(views=posts.c.views + 1))
        session["seen"] = (seen + [pid])[-50:]
        p["views"] += 1
    imgs = all_(select(images.c.id, images.c.width, images.c.height).where(images.c.post_id == pid).order_by(images.c.id))
    cmts = all_(select(comments, users.c.nickname, users.c.earned).join(users, users.c.id == comments.c.user_id)
                .where(comments.c.post_id == pid).order_by(comments.c.id))
    liked = bool(g.user and one(select(likes).where(likes.c.post_id == pid, likes.c.user_id == g.user["id"])))
    course = courses_by_id().get(p["course_id"]) if p["course_id"] else None
    return render_template("post.html", p=p, imgs=imgs, cmts=cmts, liked=liked, course=course)


def process_image(f):
    raw = f.read(MAX_PHOTO_BYTES + 1)
    if len(raw) > MAX_PHOTO_BYTES:
        raise ValueError("사진 한 장이 15MB를 넘습니다.")
    try:
        im = Image.open(io.BytesIO(raw))
        im = ImageOps.exif_transpose(im)  # 휴대폰 사진 방향 바로잡기 (위치 등 사진 속 정보는 저장 안 함)
        im = im.convert("RGB")
    except (UnidentifiedImageError, OSError):
        raise ValueError("사진 파일만 올릴 수 있습니다.")
    out = []
    for size, q in ((1280, 82), (480, 75)):
        c = im.copy()
        c.thumbnail((size, size))
        b = io.BytesIO()
        c.save(b, "JPEG", quality=q, optimize=True, progressive=True)
        out.append(b.getvalue())
    w, h = im.size
    scale = min(1, 1280 / max(w, h))
    return out[0], out[1], round(w * scale), round(h * scale)


@bp.route("/board/write", methods=["GET", "POST"])
@bp.route("/board/<int:pid>/edit", methods=["GET", "POST"])
@login_required
def write(pid=None):
    old = None
    if pid:
        old = one(select(posts).where(posts.c.id == pid))
        if not old or (old["user_id"] != g.user["id"] and not g.user["is_admin"]):
            abort(403)
    byid = courses_by_id()
    if request.method == "GET":
        cid = request.args.get("course") or (old and old["course_id"])
        cat = request.args.get("cat") or (old and old["category"]) or ("review" if cid else "free")
        old_imgs = all_(select(images.c.id).where(images.c.post_id == pid).order_by(images.c.id)) if old else []
        return render_template("write.html", old=old, cat=cat, course=byid.get(cid) if cid else None, old_imgs=old_imgs,
                               course_names=sorted({c["name"] for c in byid.values()}))
    f = request.form
    title = (f.get("title") or "").strip()[:100]
    body = (f.get("body") or "").strip()[:5000]
    cat = f.get("category") if f.get("category") in CATEGORIES else "free"
    files = [x for x in request.files.getlist("photos") if x and x.filename][:MAX_PHOTOS]
    if len(title) < 2 or len(body) < 2:
        flash("제목과 내용을 적어 주세요.")
        return redirect(request.full_path)
    last = scalar(select(func.max(posts.c.created_at)).where(posts.c.user_id == g.user["id"]))
    if not pid and last and time.time() - time.mktime(time.strptime(last, "%Y-%m-%d %H:%M:%S")) < 30:
        flash("글은 30초에 한 번 쓸 수 있습니다.")
        return redirect(request.full_path)
    # 구장 연결: 구장 id 또는 구장 이름
    cid = f.get("course_id") or None
    if not cid and f.get("course_name"):
        name = f.get("course_name").strip()
        cid = next((c["id"] for c in byid.values() if c["name"] == name), None)
    if cid and cid not in byid:
        cid = None
    try:
        pics = [process_image(x) for x in files]
    except ValueError as e:
        flash(str(e))
        return redirect(request.full_path)
    with db.engine.begin() as c:
        if old:
            keep = set(map(int, f.getlist("keep_img")))
            have = [r[0] for r in c.execute(select(images.c.id).where(images.c.post_id == pid))]
            drop = [i for i in have if i not in keep]
            if drop:
                c.execute(delete(images).where(images.c.id.in_(drop)))
            pics = pics[:max(0, MAX_PHOTOS - (len(have) - len(drop)))]
            c.execute(update(posts).where(posts.c.id == pid).values(
                title=title, body=body, category=cat, course_id=cid, updated_at=now(),
                photos=len(have) - len(drop) + len(pics)))
        else:
            pid = c.execute(insert(posts).values(user_id=g.user["id"], category=cat, title=title, body=body,
                                                 course_id=cid, photos=len(pics), created_at=now(),
                                                 views=0, likes=0, comments=0, hidden=False, reports=0)
                            ).inserted_primary_key[0]
        for data, thumb, w, h in pics:
            c.execute(insert(images).values(post_id=pid, data=data, thumb=thumb, width=w, height=h, created_at=now()))
    if not old:
        got = add_points(g.user["id"], "글쓰기") + (add_points(g.user["id"], "사진 올리기") if pics else 0)
        if got:
            flash(f"글을 올렸습니다. {got}포인트를 드렸습니다.")
    return redirect(url_for("community.view", pid=pid))


@bp.post("/board/<int:pid>/delete")
@login_required
def delete_post(pid):
    p = one(select(posts).where(posts.c.id == pid))
    if not p or (p["user_id"] != g.user["id"] and not g.user["is_admin"]):
        abort(403)
    with db.engine.begin() as c:
        for t in (images, comments, likes):
            c.execute(delete(t).where(t.c.post_id == pid))
        c.execute(delete(posts).where(posts.c.id == pid))
    flash("글을 지웠습니다.")
    return redirect(url_for("community.board", cat=p["category"]))


@bp.post("/board/<int:pid>/comment")
@login_required
def add_comment(pid):
    body = (request.form.get("body") or "").strip()[:1000]
    if not body or not one(select(posts.c.id).where(posts.c.id == pid)):
        return redirect(url_for("community.view", pid=pid))
    with db.engine.begin() as c:
        c.execute(insert(comments).values(post_id=pid, user_id=g.user["id"], body=body, hidden=False, created_at=now()))
        c.execute(update(posts).where(posts.c.id == pid).values(comments=posts.c.comments + 1))
    add_points(g.user["id"], "댓글")
    return redirect(url_for("community.view", pid=pid) + "#comments")


@bp.post("/comment/<int:cid>/delete")
@login_required
def delete_comment(cid):
    cm = one(select(comments).where(comments.c.id == cid))
    if not cm or (cm["user_id"] != g.user["id"] and not g.user["is_admin"]):
        abort(403)
    with db.engine.begin() as c:
        c.execute(delete(comments).where(comments.c.id == cid))
        c.execute(update(posts).where(posts.c.id == cm["post_id"]).values(comments=posts.c.comments - 1))
    return redirect(url_for("community.view", pid=cm["post_id"]) + "#comments")


@bp.post("/board/<int:pid>/like")
@login_required
def like(pid):
    p = one(select(posts).where(posts.c.id == pid))
    if not p:
        abort(404)
    uid = g.user["id"]
    cond = and_(likes.c.post_id == pid, likes.c.user_id == uid)
    with db.engine.begin() as c:
        if c.execute(select(likes).where(cond)).first():
            c.execute(delete(likes).where(cond))
            c.execute(update(posts).where(posts.c.id == pid).values(likes=posts.c.likes - 1))
            on = False
        else:
            c.execute(insert(likes).values(post_id=pid, user_id=uid))
            c.execute(update(posts).where(posts.c.id == pid).values(likes=posts.c.likes + 1))
            on = True
    if on and p["user_id"] != uid:
        add_points(p["user_id"], "추천 받음")
    return redirect(url_for("community.view", pid=pid))


@bp.post("/report/<kind>/<int:tid>")
@login_required
def report(kind, tid):
    if kind not in ("post", "comment"):
        abort(404)
    t = posts if kind == "post" else comments
    target = one(select(t).where(t.c.id == tid))
    if not target:
        abort(404)
    if one(select(reports).where(reports.c.kind == kind, reports.c.target_id == tid,
                                 reports.c.user_id == g.user["id"])):
        flash("이미 신고하셨습니다.")
    else:
        with db.engine.begin() as c:
            c.execute(insert(reports).values(kind=kind, target_id=tid, user_id=g.user["id"],
                                             reason=(request.form.get("reason") or "")[:200], done=False,
                                             created_at=now()))
            if kind == "post":
                c.execute(update(posts).where(posts.c.id == tid).values(reports=posts.c.reports + 1))
                n = c.execute(select(posts.c.reports).where(posts.c.id == tid)).scalar()
                if n >= HIDE_AFTER_REPORTS:  # 신고가 쌓이면 운영자 확인 전까지 숨김
                    c.execute(update(posts).where(posts.c.id == tid).values(hidden=True))
            else:
                n = c.execute(select(func.count()).select_from(reports).where(
                    reports.c.kind == "comment", reports.c.target_id == tid)).scalar()
                if n >= HIDE_AFTER_REPORTS:
                    c.execute(update(comments).where(comments.c.id == tid).values(hidden=True))
        flash("신고가 접수되었습니다. 운영자가 확인하겠습니다.")
    pid = tid if kind == "post" else target["post_id"]
    return redirect(url_for("community.view", pid=pid) if kind == "comment" or not target.get("hidden") else "/board")


@bp.get("/img/<int:iid>")
@bp.get("/img/<int:iid>/<size>")
def img(iid, size="full"):
    if not db.ENABLED:
        abort(404)
    col = images.c.thumb if size == "thumb" else images.c.data
    with db.engine.connect() as c:
        r = c.execute(select(col, posts.c.hidden, posts.c.user_id).join(posts, posts.c.id == images.c.post_id)
                      .where(images.c.id == iid)).first()
    if not r:
        abort(404)
    if r[1] and not (g.user and (g.user["is_admin"] or g.user["id"] == r[2])):
        abort(404)  # 숨긴 글의 사진은 작성자·관리자만
    resp = Response(r[0], mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "private, max-age=3600" if r[1] else "public, max-age=604800, immutable"
    return resp


# ---------------------------------------------------------------- 첫 화면용 요약
@bp.get("/api/community/latest")
def api_latest():
    if not db.ENABLED:
        return jsonify({"enabled": False, "posts": [], "photos": [], "ranking": []})
    rows = all_(post_query().where(posts.c.hidden.is_(False)).order_by(desc(posts.c.id)).limit(6))
    photos = all_(select(images.c.id, images.c.post_id, posts.c.title).join(posts, posts.c.id == images.c.post_id)
                  .where(posts.c.hidden.is_(False)).order_by(desc(images.c.id)).limit(8))
    return jsonify({"enabled": True,
                    "posts": [{"id": p["id"], "title": p["title"], "cat": CATEGORIES[p["category"]],
                               "nickname": p["nickname"], "comments": p["comments"], "photos": p["photos"],
                               "date": p["created_at"][5:16], "grade": grade_of(p["earned"])["icon"]} for p in rows],
                    "photos": [{"id": x["id"], "post_id": x["post_id"], "title": x["title"]} for x in photos],
                    "ranking": monthly_ranking(5)})


@bp.get("/api/courses/<cid>/posts")
def api_course_posts(cid):
    if not db.ENABLED:
        return jsonify({"enabled": False, "items": []})
    rows = all_(post_query().where(posts.c.course_id == cid, posts.c.hidden.is_(False))
                .order_by(desc(posts.c.id)).limit(5))
    fav = bool(g.user and one(select(favorites).where(favorites.c.user_id == g.user["id"], favorites.c.course_id == cid)))
    return jsonify({"enabled": True, "favorite": fav, "login": bool(g.user),
                    "items": [{"id": p["id"], "title": p["title"], "nickname": p["nickname"],
                               "date": p["created_at"][:10], "photos": p["photos"]} for p in rows]})


def monthly_ranking(n):
    month = today()[:7]
    rows = all_(select(users.c.nickname, users.c.earned, func.sum(point_log.c.delta).label("pts"))
                .join(users, users.c.id == point_log.c.user_id)
                .where(point_log.c.day.like(f"{month}%"), point_log.c.delta > 0, users.c.banned.is_(False))
                .group_by(users.c.id, users.c.nickname, users.c.earned)
                .order_by(desc("pts")).limit(n))
    return [{"nickname": r["nickname"], "points": int(r["pts"]), "grade": grade_of(r["earned"])} for r in rows]


# ---------------------------------------------------------------- 혜택
@bp.get("/benefits")
def benefits_page():
    rows = all_(select(benefits).where(benefits.c.active.is_(True)).order_by(benefits.c.cost)) if db.ENABLED else []
    return render_template("benefits.html", rows=rows, rules=RULES,
                           ranking=monthly_ranking(10) if db.ENABLED else [])


@bp.post("/benefits/<int:bid>/redeem")
@login_required
def redeem(bid):
    contact = (request.form.get("contact") or "").strip()[:100]
    if not contact:
        flash("혜택을 받으실 연락처를 적어 주세요.")
        return redirect(url_for("community.benefits_page"))
    with db.engine.begin() as c:
        b = c.execute(select(benefits).where(benefits.c.id == bid, benefits.c.active.is_(True))).mappings().first()
        u = c.execute(select(users).where(users.c.id == g.user["id"])).mappings().first()
        if not b:
            abort(404)
        if grade_of(u["earned"])["level"] < b["min_grade"]:
            msg = f"{GRADES[b['min_grade']][1]} 등급부터 받을 수 있는 혜택입니다."
        elif u["points"] < b["cost"]:
            msg = f"포인트가 부족합니다. (필요 {b['cost']}, 보유 {u['points']})"
        elif b["stock"] is not None and b["stock"] <= 0:
            msg = "준비된 수량이 모두 소진되었습니다."
        else:
            c.execute(update(users).where(users.c.id == u["id"], users.c.points >= b["cost"])
                      .values(points=users.c.points - b["cost"]))
            if b["stock"] is not None:
                c.execute(update(benefits).where(benefits.c.id == bid).values(stock=benefits.c.stock - 1))
            c.execute(insert(point_log).values(user_id=u["id"], delta=-b["cost"], reason="혜택 교환",
                                               day=today(), created_at=now()))
            c.execute(insert(redemptions).values(user_id=u["id"], benefit_id=bid, cost=b["cost"], contact=contact,
                                                 status="신청", created_at=now()))
            msg = f"'{b['title']}' 교환을 신청했습니다. 운영자가 확인 후 보내 드립니다."
    flash(msg)
    return redirect(url_for("community.me") if "신청했습니다" in msg else url_for("community.benefits_page"))


# ---------------------------------------------------------------- 관리자
@bp.get("/admin")
@admin_required
def admin():
    return render_template(
        "admin.html",
        bens=all_(select(benefits).order_by(desc(benefits.c.id))),
        reds=all_(select(redemptions, users.c.nickname, benefits.c.title).join(users).join(benefits)
                  .order_by(desc(redemptions.c.id)).limit(100)),
        reps=all_(select(reports, users.c.nickname).join(users).where(reports.c.done.is_(False))
                  .order_by(desc(reports.c.id)).limit(100)),
        hidden=all_(post_query().where(posts.c.hidden.is_(True)).order_by(desc(posts.c.id)).limit(50)),
        stats={"회원": scalar(select(func.count()).select_from(users)),
               "글": scalar(select(func.count()).select_from(posts)),
               "사진": scalar(select(func.count()).select_from(images)),
               "오늘 가입": scalar(select(func.count()).select_from(users).where(users.c.created_at.like(f"{today()}%")))},
        users_=all_(select(users).order_by(desc(users.c.earned)).limit(50)))


@bp.post("/admin/benefit")
@admin_required
def admin_benefit():
    f = request.form
    vals = {"partner": f["partner"][:60], "title": f["title"][:120], "description": f.get("description", "")[:2000],
            "cost": max(0, int(f.get("cost") or 0)), "min_grade": min(4, max(0, int(f.get("min_grade") or 0))),
            "stock": int(f["stock"]) if (f.get("stock") or "").strip() else None,
            "active": bool(f.get("active"))}
    with db.engine.begin() as c:
        if f.get("id"):
            c.execute(update(benefits).where(benefits.c.id == int(f["id"])).values(**vals))
        else:
            c.execute(insert(benefits).values(created_at=now(), **vals))
    flash("혜택을 저장했습니다.")
    return redirect(url_for("community.admin"))


@bp.post("/admin/redemption/<int:rid>/<action>")
@admin_required
def admin_redemption(rid, action):
    r = one(select(redemptions).where(redemptions.c.id == rid))
    if not r or r["status"] != "신청" or action not in ("done", "cancel"):
        abort(400)
    with db.engine.begin() as c:
        if action == "done":  # 지급 후 연락처는 지운다 (개인정보 최소 보관)
            c.execute(update(redemptions).where(redemptions.c.id == rid).values(status="지급완료", done_at=now(), contact=None))
        else:  # 취소: 포인트 돌려줌
            c.execute(update(redemptions).where(redemptions.c.id == rid).values(status="취소", done_at=now(), contact=None))
            c.execute(update(users).where(users.c.id == r["user_id"]).values(points=users.c.points + r["cost"]))
            c.execute(insert(point_log).values(user_id=r["user_id"], delta=r["cost"], reason="교환 취소 환불",
                                               day=today(), created_at=now()))
            c.execute(update(benefits).where(benefits.c.id == r["benefit_id"], benefits.c.stock.isnot(None))
                      .values(stock=benefits.c.stock + 1))
    return redirect(url_for("community.admin"))


@bp.post("/admin/post/<int:pid>/<action>")
@admin_required
def admin_post(pid, action):
    with db.engine.begin() as c:
        if action == "show":
            c.execute(update(posts).where(posts.c.id == pid).values(hidden=False, reports=0))
        elif action == "hide":
            c.execute(update(posts).where(posts.c.id == pid).values(hidden=True))
        c.execute(update(reports).where(reports.c.kind == "post", reports.c.target_id == pid).values(done=True))
    return redirect(url_for("community.admin"))


@bp.post("/admin/report/<int:rid>/done")
@admin_required
def admin_report_done(rid):
    with db.engine.begin() as c:
        c.execute(update(reports).where(reports.c.id == rid).values(done=True))
    return redirect(url_for("community.admin"))


@bp.post("/admin/user/<int:uid>/ban")
@admin_required
def admin_ban(uid):
    with db.engine.begin() as c:
        c.execute(update(users).where(users.c.id == uid).values(banned=~users.c.banned))
    return redirect(url_for("community.admin"))


# ---------------------------------------------------------------- 소개·약관
@bp.get("/about")
def about():
    return render_template("about.html")


@bp.get("/terms")
def terms():
    return render_template("terms.html")


@bp.get("/privacy")
def privacy():
    return render_template("privacy.html")
