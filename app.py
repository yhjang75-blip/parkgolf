"""전국 파크골프장 현황·예약 안내 웹사이트 (Flask).

실행:  python app.py   ->  http://127.0.0.1:5000
배포:  gunicorn app:app   (무료 호스팅 Render 등. README.md 참고)
"""
import json
import os
import time
from pathlib import Path

import requests
from flask import Flask, abort, jsonify, render_template

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "courses.json"

app = Flask(__name__)
app.json.ensure_ascii = False

_db = {"mtime": 0, "data": None}
_weather_cache = {}  # course_id -> (시각, 결과)
WEATHER_TTL = 30 * 60

LIST_FIELDS = ("id", "name", "sido", "sigungu", "address", "lat", "lng", "coord_source",
               "holes", "reserve_url", "phone", "reserve_phone", "operator")


def db():
    """courses.json 을 읽는다. 파일이 바뀌면 다시 읽는다."""
    m = DATA.stat().st_mtime
    if m != _db["mtime"]:
        _db["data"] = json.loads(DATA.read_text(encoding="utf-8"))
        _db["by_id"] = {c["id"]: c for c in _db["data"]["courses"]}
        _db["mtime"] = m
    return _db


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
