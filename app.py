"""나이스파크 — 전국 파크골프장 현황·예약 안내 웹사이트 (Flask).

실행:  python app.py   ->  http://127.0.0.1:5000
배포:  gunicorn app:app   (무료 호스팅 Render 등. README.md 참고)
"""
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import date, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import secrets

import requests
from flask import Flask, abort, jsonify, render_template, request
from werkzeug.middleware.proxy_fix import ProxyFix

import community
import db as cdb

KST = timezone(timedelta(hours=9))

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "courses.json"

app = Flask(__name__)
app.json.ensure_ascii = False
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # Render 뒤에서 https 주소를 바르게 만들기


def secret_key():
    """로그인 유지용 비밀값. 공개 서버는 환경변수 SECRET_KEY, 내 PC 는 data/.secret_key 파일."""
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    f = ROOT / "data" / ".secret_key"
    if not f.exists():
        f.write_text(secrets.token_hex(32))
    return f.read_text().strip()


app.config.update(
    SECRET_KEY=secret_key(),
    MAX_CONTENT_LENGTH=40 * 1024 * 1024,  # 사진 4장
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),
)
app.register_blueprint(community.bp)
cdb.init()

_db = {"mtime": 0, "data": None}
_weather_cache = {}  # course_id -> (시각, 결과)
WEATHER_TTL = 30 * 60

MEDIA = ROOT / "data" / "media.json"
_feed_cache = {}  # key -> (시각, 결과)
NEWS_TTL = 30 * 60
VIDEO_TTL = 60 * 60
UA = {"User-Agent": "Mozilla/5.0 (parkgolf-map)"}

LIST_FIELDS = ("id", "name", "sido", "sigungu", "address", "lat", "lng", "coord_source",
               "holes", "reserve_url", "phone", "reserve_phone", "operator", "reserve_level", "photo")


def db():
    """courses.json 을 읽는다. 파일이 바뀌면 다시 읽는다."""
    m = DATA.stat().st_mtime
    if m != _db["mtime"]:
        _db["data"] = json.loads(DATA.read_text(encoding="utf-8"))
        _db["by_id"] = {c["id"]: c for c in _db["data"]["courses"]}
        _db["mtime"] = m
    return _db


app.config["COURSE_DB"] = db  # community.py 가 구장 자료를 쓸 때


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/courses")
def courses():
    return jsonify([{k: c.get(k) for k in LIST_FIELDS} for c in db()["data"]["courses"]])


@app.get("/api/courses/<cid>")
def course(cid):
    c = db()["by_id"].get(cid)
    if not c:
        abort(404)
    return jsonify(c)


@app.get("/api/meta")
def meta():
    d = db()["data"]
    counts = {s: 0 for s in d["sido_list"]}
    for c in d["courses"]:
        counts[c["sido"]] = counts.get(c["sido"], 0) + 1
    return jsonify({
        "total": len(d["courses"]),
        "counts": counts,
        "sources": d["sources"],
        "built": time.strftime("%Y-%m-%d", time.localtime(_db["mtime"])),
    })


@app.get("/api/weather/<cid>")
def weather(cid):
    """구장 좌표 기준 현재 날씨와 3일 예보 (Open-Meteo, 키 불필요). 30분 캐시."""
    c = db()["by_id"].get(cid)
    if not c or c.get("lat") is None:
        return jsonify({"error": "위치 정보가 없어 날씨를 조회할 수 없습니다."}), 404
    hit = _weather_cache.get(cid)
    if hit and time.time() - hit[0] < WEATHER_TTL:
        return jsonify(hit[1])
    try:
        r = requests.get("https://api.open-meteo.com/v1/forecast", params={
            "latitude": c["lat"], "longitude": c["lng"], "timezone": "Asia/Seoul",
            "current": "temperature_2m,precipitation,weather_code,wind_speed_10m",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            "forecast_days": 3, "wind_speed_unit": "ms",
        }, timeout=10)
        r.raise_for_status()
        j = r.json()
    except requests.RequestException:
        return jsonify({"error": "날씨 정보를 잠시 가져올 수 없습니다."}), 502
    out = {"current": j.get("current"), "daily": j.get("daily"),
           "source": "Open-Meteo", "fetched": time.strftime("%Y-%m-%d %H:%M")}
    _weather_cache[cid] = (time.time(), out)
    return jsonify(out)


def media():
    return json.loads(MEDIA.read_text(encoding="utf-8"))


def cached(key, ttl, fn):
    """fn() 결과를 ttl 초 동안 보관. 실패하면 지난 결과라도 돌려준다."""
    hit = _feed_cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    try:
        out = fn()
    except Exception:  # 외부 서비스 오류 — 지난 결과 또는 빈 결과
        return hit[1] if hit else None
    if out:
        _feed_cache[key] = (time.time(), out)
    return out or (hit[1] if hit else out)


def google_news(query, limit=12):
    r = requests.get("https://news.google.com/rss/search", headers=UA, timeout=10,
                     params={"q": f"{query} when:30d", "hl": "ko", "gl": "KR", "ceid": "KR:ko"})
    r.raise_for_status()
    items = []
    for it in ET.fromstring(r.content).iter("item"):
        source = it.findtext("source") or ""
        title = it.findtext("title") or ""
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3]
        try:
            pub = parsedate_to_datetime(it.findtext("pubDate")).astimezone(KST)
        except (TypeError, ValueError):
            pub = None
        items.append({"title": title, "url": it.findtext("link"), "source": source,
                      "date": pub.strftime("%Y-%m-%d %H:%M") if pub else None, "_t": pub.timestamp() if pub else 0})
    items.sort(key=lambda x: -x["_t"])
    seen, out = set(), []
    for x in items:  # 같은 보도자료를 여러 신문이 실은 경우 하나만
        k = re.sub(r"[^가-힣A-Za-z0-9]", "", x["title"])[:18]
        if k in seen:
            continue
        seen.add(k)
        x.pop("_t")
        out.append(x)
    return out[:limit]


WIN_RE = re.compile(r"우승|정상|챔피언|1위|금메달|대상 수상|패권")


@app.get("/api/news")
def news():
    """topic = tournament(대회 소식) | winner(우승 소식) | news(일반 뉴스). 구글 뉴스 RSS, 30분 캐시."""
    topic = request.args.get("topic", "news")
    if topic == "local":  # 회원 관심 지역 소식: 구장이 있는 시·도/시·군·구 이름만 받는다
        region = request.args.get("region", "")
        known = {c["sido"] for c in db()["data"]["courses"]} | {c["sigungu"] for c in db()["data"]["courses"] if c["sigungu"]}
        if region not in known:
            abort(404)
        q = f"파크골프 {region}"
        items = cached(f"news:local:{region}", NEWS_TTL, lambda: google_news(q, 10)) or []
        return jsonify({"items": items[:6], "source": "Google 뉴스", "query": q})
    q = media()["news_queries"].get(topic)
    if not q:
        abort(404)
    items = cached(f"news:{topic}", NEWS_TTL, lambda: google_news(q, 30)) or []
    if topic == "winner":
        items = [x for x in items if WIN_RE.search(x["title"])]
    elif topic == "tournament":
        items = [x for x in items if "대회" in x["title"]]
    return jsonify({"items": items[:10], "source": "Google 뉴스", "query": q})


def youtube_videos():
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}
    vids = []
    for ch in media()["youtube_channels"]:
        try:
            r = requests.get("https://www.youtube.com/feeds/videos.xml", headers=UA, timeout=8,
                             params={"channel_id": ch["id"]})
            if r.status_code != 200:
                continue
            root = ET.fromstring(r.content)
        except (requests.RequestException, ET.ParseError):
            continue
        for e in root.findall("a:entry", ns):
            title = e.findtext("a:title", namespaces=ns) or ""
            if "파크골프" not in title.replace(" ", ""):
                continue
            vids.append({"id": e.findtext("yt:videoId", namespaces=ns), "title": title,
                         "channel": ch["name"], "published": (e.findtext("a:published", namespaces=ns) or "")[:10]})
    since = time.strftime("%Y-%m-%d", time.localtime(time.time() - 120 * 86400))
    vids = [v for v in vids if v["published"] >= since]  # 최근 4개월 영상만
    vids.sort(key=lambda v: v["published"], reverse=True)
    return vids[:8]


LIVE_RE = re.compile(r"LIVE|라이브|생중계|실시간", re.I)
GAME_RE = re.compile(r"대회|결승|라운드|오픈|최강전|선수권|챔피언|예선|본선")


@app.get("/api/videos")
def videos():
    """방송사·파크골프 채널의 유튜브 공식 RSS 에서 파크골프 영상을 모은다. 1시간 캐시."""
    vids = cached("videos", VIDEO_TTL, youtube_videos)
    fallback = not vids
    if fallback:
        vids = [dict(v, published=None) for v in media()["fallback_videos"]]
    recent = time.strftime("%Y-%m-%d", time.localtime(time.time() - 36 * 3600))
    for v in vids:
        # 제목에 LIVE 가 있어도 지난 생중계(다시보기)는 LIVE 로 표시하지 않는다
        v["live"] = bool(LIVE_RE.search(v["title"])) and bool(v.get("published")) and v["published"] >= recent
        v["game"] = bool(GAME_RE.search(v["title"]))
    # 생중계 > 대회 영상 > 기타 순서 (같은 묶음 안에서는 최신순 유지)
    vids = sorted(vids, key=lambda v: (not v["live"], not v["game"]))
    return jsonify({"items": vids, "fallback": fallback})


def tournament_items():
    today = time.strftime("%Y-%m-%d")
    items = []
    for t in media()["tournaments"]:
        if not t.get("start"):  # 날짜 미정
            status = "예정"
        else:
            status = "예정" if t["start"] > today else "진행 중" if (t.get("end") or t["start"]) >= today else "종료"
        days = (date.fromisoformat(t["start"]) - date.fromisoformat(today)).days if t.get("start") else None
        items.append(dict(t, status=status, days=days))
    # 진행 중·예정은 가까운 날짜부터(날짜 미정은 뒤로), 종료는 최근에 끝난 것부터
    ahead = sorted((t for t in items if t["status"] != "종료"), key=lambda t: t.get("start") or "9999")
    done = sorted((t for t in items if t["status"] == "종료"), key=lambda t: t["end"], reverse=True)
    return ahead + done, today


@app.get("/api/tournaments")
def tournaments():
    items, today = tournament_items()
    return jsonify({"items": items, "today": today})


@app.get("/tournament")
def tournament_page():
    items, today = tournament_items()
    return render_template("tournament.html", items=items, today=today)


@app.get("/favicon.ico")
def favicon():
    return "", 204


@app.get("/healthz")
def healthz():
    return "ok"


if __name__ == "__main__":
    import sys
    if "--open" in sys.argv:  # 바탕화면 아이콘으로 실행하면 브라우저를 자동으로 연다
        import threading
        import webbrowser
        threading.Timer(1.5, lambda: webbrowser.open("http://127.0.0.1:5000")).start()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
