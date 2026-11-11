"""구장마다 대표 사진 1장을 찾아 data/photos.json 에 적는다.

사용법 (카카오 REST API 키 필요, 무료: https://developers.kakao.com → 내 애플리케이션 → REST API 키):
    $env:KAKAO_REST_API_KEY = "키"
    .venv\\Scripts\\python scripts\\photos.py          # 사진이 없는 구장만 찾음
    .venv\\Scripts\\python scripts\\photos.py --all    # 전부 다시 찾음 (직접 넣은 사진은 유지)
    .venv\\Scripts\\python scripts\\build.py           # 사이트 자료에 반영

- 카카오 이미지 검색(공식 API)에 '시군구 + 구장 이름'으로 묻고, 정확도 순 첫 번째 가로 사진을 고른다.
  검색 사진이라 다른 곳 사진일 수 있으므로 화면에 "검색으로 찾은 사진"이라고 표시한다.
  틀린 사진은 photos.json 에서 지우거나 "method": "직접" 사진으로 바꾼다.
  찾지 못한 구장은 화면에 그림으로 대신 표시된다.
- 사진의 저작권은 원 게시자에게 있다. 화면에 출처 링크를 함께 표시한다.
  직접 찍었거나 허락받은 사진이 있으면 photos.json 에 "method": "직접" 으로 넣는다 (다시 찾아도 덮어쓰지 않음).
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
OUT = ROOT / "data" / "photos.json"
BLOCK = ROOT / "data" / "photo_blocklist.json"  # 틀린 사진 주소 목록
API = "https://dapi.kakao.com/v2/search/image"


SKIP_SITES = re.compile(r"pinterest|shopping|coupang|11st|gmarket|auction|stylem", re.I)
GENERIC = re.compile(r"^(장애인|강변|중앙|생활체육공원|체육공원|스포츠파크|군민|시민)?$")


def query_for(c, dup_names):
    """구장 이름을 띄어 쓰지 않고 검색하면 가장 잘 맞는다.
    '장애인파크골프장'처럼 흔한 이름이나 여러 지역에 같은 이름이 있으면 시·군·구를 붙인다."""
    name = re.sub(r"\s+", "", c["name"])
    core = re.sub(r"\(.*?\)|\[.*?\]|파크골프장?|구장", "", name)
    if GENERIC.match(core) or c["name"] in dup_names or len(core) <= 1:
        return f"{c['sigungu'] or c['sido']} {name}"
    return name


def pick(docs, used):
    """블로그·카페·뉴스의 가로 사진 중 정확도 순 첫 결과. 다른 구장에 이미 쓴 사진은 건너뛴다."""
    for d in docs:
        w, h = d.get("width") or 0, d.get("height") or 0
        if w < 400 or h < 250 or w < h * 1.1:
            continue
        if d.get("collection") not in ("blog", "cafe", "news"):
            continue
        if SKIP_SITES.search(f"{d.get('doc_url', '')} {d.get('display_sitename', '')}"):
            continue
        if d["image_url"] in used:
            continue
        return d
    return None


def main():
    key = os.environ.get("KAKAO_REST_API_KEY")
    if not key:
        sys.exit("KAKAO_REST_API_KEY 가 없습니다. 파일 맨 위 사용법을 보세요.")
    courses = json.loads(COURSES.read_text(encoding="utf-8"))["courses"]
    photos = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    redo = "--all" in sys.argv
    found = 0
    names = [c["name"] for c in courses]
    dup_names = {n for n in names if names.count(n) > 1}
    used = {v["url"] for k, v in photos.items() if not k.startswith("_") and v}
    # 사람이 보고 틀렸다고 표시한 사진 — 다시 고르지 않는다
    used |= set(json.loads(BLOCK.read_text(encoding="utf-8")).get("urls", [])) if BLOCK.exists() else set()
    if "--retry" in sys.argv:  # 제외 목록에 든 사진을 쓰던 구장만 다시 찾음
        for k in [k for k, v in photos.items() if not k.startswith("_") and v and v["url"] in used
                  and v.get("method") != "직접" and v["url"] in set(json.loads(BLOCK.read_text(encoding="utf-8"))["urls"])]:
            del photos[k]
    for i, c in enumerate(courses, 1):
        old = photos.get(c["id"])
        if old and (old.get("method") == "직접" or not redo):
            continue
        q = query_for(c, dup_names)
        r = requests.get(API, params={"query": q, "size": 30, "sort": "accuracy"},
                         headers={"Authorization": f"KakaoAK {key}"}, timeout=10)
        if r.status_code == 401:
            sys.exit("키가 맞지 않습니다 (401).")
        r.raise_for_status()
        d = pick(r.json().get("documents", []), used)
        if d:
            used.add(d["image_url"])
            photos[c["id"]] = {
                "url": d["image_url"], "thumb": d["thumbnail_url"],
                "source_url": d.get("doc_url"), "source_name": d.get("display_sitename") or "웹 문서",
                "method": "카카오 이미지 검색", "query": q, "name": c["name"], "checked": time.strftime("%Y-%m-%d"),
            }
            found += 1
        print(f"[{i}/{len(courses)}] {c['name']}: {'찾음' if d else '없음'}")
        time.sleep(0.2)
    photos["_설명"] = "구장 id -> 대표 사진. method='직접' 인 항목은 photos.py 가 덮어쓰지 않는다."
    OUT.write_text(json.dumps(photos, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"새로 찾은 사진 {found}장. 이제 scripts/build.py 를 실행하세요.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
