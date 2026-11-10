"""좌표가 없는 구장의 위치를 주소로 찾는다.

사용법:  python scripts/geocode.py        (그 뒤 python scripts/build.py 다시 실행)
결과:    data/geocode_cache.json  (주소 -> 좌표, 한 번 찾은 주소는 다시 묻지 않음)

정확도 순서
1. 환경변수 KAKAO_REST_API_KEY 가 있으면 카카오 주소 검색 (정확한 위치)
2. 환경변수 VWORLD_KEY 가 있으면 브이월드(국토교통부) 주소 검색 (정확한 위치)
3. 둘 다 없으면 OpenStreetMap Nominatim (무료, 키 불필요)
   - 구장 이름으로 찾으면 정확한 위치
   - 못 찾으면 주소의 읍·면·동·리 중심점 → 화면에 "대략 위치"로 표시
   Nominatim 이용 정책에 따라 1초에 1건 이하로 요청한다.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
COURSES = ROOT / "data" / "courses.json"
CACHE = ROOT / "data" / "geocode_cache.json"
UA = {"User-Agent": "parkgolf-map/0.1 (open data prototype)"}

KAKAO = os.environ.get("KAKAO_REST_API_KEY")
VWORLD = os.environ.get("VWORLD_KEY")


def simplify(addr):
    a = re.sub(r"\(.*?\)", " ", addr)
    a = re.sub(r"(일원|일대|번지|외\s*\d+필지|부근|인근|내|하부|좌안|우안)", " ", a)
    return re.sub(r"\s+", " ", a).strip()


def kakao(s, c):
    h = {"Authorization": f"KakaoAK {KAKAO}"}
    r = s.get("https://dapi.kakao.com/v2/local/search/address.json",
              params={"query": simplify(c["address"])}, headers=h, timeout=20).json()
    if r.get("documents"):
        d = r["documents"][0]
        return {"lat": float(d["y"]), "lng": float(d["x"]), "source": "주소변환(카카오)", "precise": True}
    return None


def vworld(s, c):
    for typ in ("parcel", "road"):
        r = s.get("https://api.vworld.kr/req/address", params={
            "service": "address", "request": "getcoord", "crs": "epsg:4326",
            "address": simplify(c["address"]), "format": "json", "type": typ, "key": VWORLD,
        }, timeout=20).json()
        res = r.get("response", {})
        if res.get("status") == "OK":
            p = res["result"]["point"]
            return {"lat": float(p["y"]), "lng": float(p["x"]), "source": "주소변환(브이월드)", "precise": True}
    return None


def nominatim(s, q, **extra):
    time.sleep(1.1)
    r = s.get("https://nominatim.openstreetmap.org/search",
              params={"q": q, "format": "jsonv2", "limit": 3, "countrycodes": "kr", **extra}, timeout=30)
    return r.json() if r.ok else []


def osm(s, c):
    region = c["sigungu"] or ""
    # 1) 이름으로 찾기 (OSM 에 구장이 등록돼 있으면 정확한 위치)
    base = re.sub(r"\(.*?\)", "", c["name"]).strip()
    for res in nominatim(s, f"{base} {region}"):
        disp = res.get("display_name", "")
        if ("파크골프" in res.get("name", "") or res.get("category") == "leisure") and \
                (not region or region in disp):
            return {"lat": float(res["lat"]), "lng": float(res["lon"]),
                    "source": "OpenStreetMap(구장 이름)", "precise": True}
    # 2) 주소를 뒤에서부터 줄여 가며 찾기 → 읍면동 중심 (대략 위치)
    toks = simplify(c["address"]).split()
    while len(toks) >= 3:
        res = nominatim(s, " ".join(toks))
        if res and (not region or region in res[0].get("display_name", "")):
            return {"lat": float(res[0]["lat"]), "lng": float(res[0]["lon"]),
                    "source": "대략 위치(읍·면·동 중심)", "precise": False}
        toks = toks[:-1]
    return None


def main():
    data = json.loads(COURSES.read_text(encoding="utf-8"))["courses"]
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    fn = kakao if KAKAO else vworld if VWORLD else osm
    print(f"주소 변환 방식: {fn.__name__}")
    s = requests.Session()
    s.headers.update(UA)
    todo = [c for c in data if c["lat"] is None and c["address"]
            and (c["address"] not in cache or (fn is not osm and not cache[c["address"]].get("precise")))]
    found = 0
    for i, c in enumerate(todo, 1):
        try:
            g = fn(s, c)
        except Exception as e:
            print(f"  오류 {c['name']}: {e}")
            continue
        cache[c["address"]] = g or {"lat": None}
        found += bool(g)
        print(f"[{i}/{len(todo)}] {c['name']} -> {g['source'] if g else '못 찾음'}")
        if i % 10 == 0:
            CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"완료: {len(todo)}곳 중 {found}곳 위치 찾음. 이제 python scripts/build.py 를 실행하세요.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
