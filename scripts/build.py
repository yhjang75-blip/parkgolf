"""data/raw 의 CSV 들을 하나의 공통 형식으로 합친다.

사용법:  python scripts/build.py
결과:    data/courses.json

원칙
- 원자료에 없는 값은 만들어 내지 않는다 (None = 화면에 "정보 없음").
- 같은 구장이 여러 자료에 있으면 더 자세한 자료(공단 > 시군구 > 시도)를 우선하고,
  빈 항목만 다른 자료로 채운다. 모든 출처를 기록한다.
- data/manual_overrides.json 에 사람이 확인한 값을 넣으면 그 값이 가장 우선한다.
"""
import csv
import hashlib
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "courses.json"
OVERRIDES = ROOT / "data" / "manual_overrides.json"
GEOCACHE = ROOT / "data" / "geocode_cache.json"

SIDO = {
    "서울": "서울특별시", "부산": "부산광역시", "대구": "대구광역시", "인천": "인천광역시",
    "광주": "광주광역시", "대전": "대전광역시", "울산": "울산광역시", "세종": "세종특별자치시",
    "경기": "경기도", "강원": "강원특별자치도", "충북": "충청북도", "충청북": "충청북도",
    "충남": "충청남도", "충청남": "충청남도", "전북": "전북특별자치도", "전라북": "전북특별자치도",
    "전남": "전라남도", "전라남": "전라남도", "경북": "경상북도", "경상북": "경상북도",
    "경남": "경상남도", "경상남": "경상남도", "제주": "제주특별자치도",
}
SIDO_LIST = sorted(set(SIDO.values()))

# 데이터셋별 기본 시도 (주소에 시도가 빠진 경우에 사용)
DEFAULT_SIDO = {
    "15113672": "서울특별시", "15142271": "인천광역시", "15142224": "대구광역시",
    "15142438": "세종특별자치시", "15142244": "강원특별자치도", "15142226": "전북특별자치도",
    "15142153": "전라남도", "15142311": "광주광역시", "15142265": "경상북도",
    "15113377": "경상남도", "15120357": "대구광역시", "15160487": "대구광역시",
    "15160548": "경상북도", "15160516": "경기도", "15160419": "서울특별시",
    "15160491": "서울특별시", "15160528": "세종특별자치시", "15160551": "서울특별시",
    "15160428": "경기도", "15160352": "경기도", "15166992": "인천광역시",
}
DEFAULT_SIGUNGU = {
    "15113377": "거창군", "15120357": "북구", "15160487": "달성군", "15160548": "경주시",
    "15160516": "이천시", "15160419": "동작구", "15160491": "관악구", "15160551": "중랑구",
    "15160428": "가평군", "15160352": "연천군",
}
SEOUL_GU = set("종로구 중구 용산구 성동구 광진구 동대문구 중랑구 성북구 강북구 도봉구 노원구 은평구 "
               "서대문구 마포구 양천구 강서구 구로구 금천구 영등포구 동작구 관악구 서초구 강남구 "
               "송파구 강동구".split())
# 행정구역 개편으로 이름이 바뀐 구 (옛 자료와 새 자료를 같은 곳으로 본다)
SIGUNGU_COMPAT = [{("인천광역시", "서구"), ("인천광역시", "서해구"), ("인천광역시", "검단구")}]
RANK = {"공단": 0, "시군구": 1, "시도": 2, "OSM": 3}
EMPTY = {"", "-", "없음", "해당없음", "해당 없음", "미정", "n/a", "na", "null"}


# ---------- 값 정리 ----------
def clean(v):
    if v is None:
        return None
    v = re.sub(r"\s+", " ", str(v)).strip().rstrip(".")
    return None if v.lower() in EMPTY else v


def to_int(v):
    v = clean(v)
    if not v:
        return None
    m = re.search(r"\d[\d,]*", v)
    return int(m.group().replace(",", "")) if m else None


def to_area(v):
    v = clean(v)
    if not v:
        return None
    m = re.search(r"\d[\d,]*(\.\d+)?", v)
    return float(m.group().replace(",", "")) if m else None


def to_coord(v, lo, hi):
    try:
        f = float(str(v).strip())
        return f if lo <= f <= hi else None
    except (TypeError, ValueError):
        return None


def find_url(*vals):
    for v in vals:
        if v:
            m = re.search(r"https?://[^\s,)]+", v)
            if m:
                return m.group()
    return None


def norm_header(h):
    return re.sub(r"[\s_()]", "", h or "")


def pick(row, *cands, exclude=()):
    """헤더 이름에 cands 중 하나가 들어 있는 첫 번째 값."""
    for c in cands:
        for k, v in row.items():
            if c in k and not any(x in k for x in exclude):
                v = clean(v)
                if v:
                    return v
    return None


def parse_sido(addr, default):
    if addr:
        tok = addr.split()[0]
        for k, full in SIDO.items():
            if tok.startswith(k):
                return full
    return default


def parse_sigungu(addr, default=None):
    """주소에서 시·군·구 이름을 찾는다. 괄호 안에 있어도 찾는다 (예: '... (영등포구 여의도동 8)')."""
    if addr:
        for tok in re.split(r"[\s()]+", addr):
            if tok in SIDO:  # '대구' 처럼 시도 약칭이 '구'로 끝나는 경우
                continue
            if re.fullmatch(r"[가-힣]{1,5}(시|군|구)", tok) and tok not in SIDO.values() \
                    and not re.search(r"(특별|광역|특별자치)시$", tok):
                return tok
    return default


def name_key(name):
    # 괄호 안 내용(1구장, A·B구장 등)과 숫자는 남겨 서로 다른 구장을 구분한다
    n = re.sub(r"[\s·,\-()\[\]]", "", name or "")
    return n.replace("파크골프장", "").replace("파크골프", "")


def dist_m(a, b):
    if None in (a.get("lat"), a.get("lng"), b.get("lat"), b.get("lng")):
        return None
    dy = (a["lat"] - b["lat"]) * 111000
    dx = (a["lng"] - b["lng"]) * 111000 * math.cos(math.radians(a["lat"]))
    return math.hypot(dx, dy)


# ---------- 읽기 ----------
def read_rows(path):
    with open(path, encoding="utf-8", newline="") as f:
        rows = [r for r in csv.reader(f) if any(c.strip() for c in r)]
    header = [norm_header(h) for h in rows[0]]
    return [dict(zip(header, r)) for r in rows[1:]]


def to_course(row, ds_id, meta):
    name = pick(row, "파크골프장명", "시설명", "업장명")
    if not name:
        return None
    road = pick(row, "도로명주소")
    jibun = pick(row, "지번주소")
    addr = road or jibun or pick(row, "주소", "위치", "소재지")
    sido = parse_sido(addr, DEFAULT_SIDO.get(ds_id))
    sigungu = pick(row, "시군", "기초단체명", exclude=("소재지",)) if ds_id in (
        "15142153", "15142226", "15142244", "15142265") else None
    if sigungu == "본청":
        sigungu = None
    sigungu = sigungu or parse_sigungu(addr) or parse_sigungu(name) or DEFAULT_SIGUNGU.get(ds_id)
    if not sigungu and sido == "서울특별시":  # 예: '안양천 파크골프장 (금천)', '(구로②)'
        m = re.search(r"\(([가-힣]{1,3})[①-⑩\d]*\)", name)
        if m and m.group(1) + "구" in SEOUL_GU:
            sigungu = m.group(1) + "구"
    if sido == "세종특별자치시":
        sigungu = "세종시"
    if addr and not addr.startswith(sido[:2]) and not re.match(r"^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충|전|경|제주)", addr):
        addr = f"{sido} {addr}"

    holes_txt = pick(row, "홀수", "규모홀", "홀", exclude=("코스",))
    reserve_txt = pick(row, "예약처", "예약페이지", "예약방법", "비고")
    hours = pick(row, "운영이용시간", "운영시간", exclude=("월운영",))
    if not hours:  # 가평처럼 월별로 나뉜 경우
        monthly = [(k, clean(v)) for k, v in row.items() if "월운영시간" in k and clean(v)]
        if monthly:
            hours = " / ".join(f"{k.replace('운영시간', '')} {v}" for k, v in monthly)
    period = pick(row, "운영기간")
    if period:
        hours = f"{hours} (운영기간 {period})" if hours else f"운영기간 {period}"

    c = {
        "name": name,
        "sido": sido,
        "sigungu": sigungu,
        "address": addr,
        "address_jibun": jibun if road else None,
        "lat": to_coord(row.get("위도"), 33, 39),
        "lng": to_coord(row.get("경도"), 124, 132),
        "coord_source": None,
        "holes": to_int(holes_txt),
        "course_count": to_int(pick(row, "코스수")),
        "area_m2": to_area(pick(row, "면적", "규모", exclude=("홀",))),
        "par_info": (re.search(r"\((par.*?)\)", holes_txt or "", re.I) or [None, None])[1],
        "facilities": pick(row, "편의", "부대시설"),
        "phone": pick(row, "전화번호", "연락처", "전화", exclude=("예약",)),
        "operator": pick(row, "운영기관", "관리기관", exclude=("연락처",)),
        "opened": pick(row, "개장", "설치연도"),
        "hours": hours,
        "closed_days": pick(row, "휴무일"),
        "fee": pick(row, "이용요금"),
        "reserve_method": pick(row, "예약방식", "예약방법"),
        "reserve_url": find_url(reserve_txt, pick(row, "예약방법"), pick(row, "비고")),
        "reserve_note": None,
        "reserve_phone": pick(row, "예약문의전화번호", "예약문의"),
        "turf": None,          # 공개 자료에 없음
        "course_length_m": None,  # 공개 자료에 없음
        "note": pick(row, "비고") if ds_id == "15142226" else None,
        "sources": [{
            "id": ds_id, "title": meta.get("제목"), "date": meta.get("수정일"),
            "url": meta.get("주소"), "license": meta.get("라이선스"),
        }],
        "_rank": RANK.get(meta.get("범위"), 9),
    }
    if c["lat"] is not None and c["lng"] is not None:
        c["coord_source"] = "원자료"
    # 예약처 칸에 URL 이 아닌 안내문(예: 카카오톡 채널명)만 있으면 메모로 남김
    if reserve_txt and not c["reserve_url"] and reserve_txt != c["reserve_method"]:
        c["reserve_note"] = reserve_txt
    if c["fee"] and re.fullmatch(r"\d+", c["fee"].replace(",", "")):
        c["fee"] = f"{int(c['fee'].replace(',', '')):,}원"
    return c


# ---------- 합치기 ----------
def same(a, b):
    # 같은 자료 안의 행은 서로 다른 구장으로 본다
    if {s["id"] for s in a["sources"]} & {s["id"] for s in b["sources"]}:
        return False
    if a["sido"] != b["sido"]:
        return False
    if a["sigungu"] and b["sigungu"] and a["sigungu"] != b["sigungu"]:
        pa, pb = (a["sido"], a["sigungu"]), (b["sido"], b["sigungu"])
        if not any(pa in g and pb in g for g in SIGUNGU_COMPAT):
            return False
    ka, kb = name_key(a["name"]), name_key(b["name"])
    if not ka or not kb:
        return False
    if ka == kb:
        return True
    d = dist_m(a, b)
    if (ka in kb or kb in ka) and (d is None or d < 1500):
        return True
    return False


def merge(base, other):
    for k, v in other.items():
        if k in ("sources", "_rank"):
            continue
        if base.get(k) in (None, "") and v not in (None, ""):
            base[k] = v
    base["sources"] += other["sources"]


def main():
    manifest = json.loads((RAW / "manifest.json").read_text(encoding="utf-8"))
    items = []
    for ds_id, meta in manifest.items():
        path = RAW / f"{ds_id}.csv"
        if not path.exists():
            continue
        for row in read_rows(path):
            c = to_course(row, ds_id, meta)
            if c:
                items.append(c)
    osm = ROOT / "data" / "osm_courses.json"
    if osm.exists():
        items += json.loads(osm.read_text(encoding="utf-8"))

    raw_count = len(items)
    items.sort(key=lambda c: c["_rank"])
    merged = []
    for c in items:
        for m in merged:
            if same(m, c):
                merge(m, c)
                break
        else:
            merged.append(c)

    # 주소 → 좌표 변환 결과 (scripts/geocode.py 가 만듦)
    geocache = json.loads(GEOCACHE.read_text(encoding="utf-8")) if GEOCACHE.exists() else {}
    overrides = json.loads(OVERRIDES.read_text(encoding="utf-8")).get("courses", {}) if OVERRIDES.exists() else {}

    for c in merged:
        c.pop("_rank", None)
        c["id"] = hashlib.md5(f"{c['sido']}|{c['sigungu']}|{c['name']}".encode()).hexdigest()[:10]
        if c["lat"] is None and c["address"]:
            g = geocache.get(c["address"])
            if g and g.get("lat"):
                c["lat"], c["lng"], c["coord_source"] = g["lat"], g["lng"], g.get("source", "주소변환")
        for k, v in overrides.get(c["id"], {}).items():
            if not k.startswith("_"):
                c[k] = v
        c["data_date"] = max((s["date"] or "" for s in c["sources"]), default=None) or None

    merged.sort(key=lambda c: (SIDO_LIST.index(c["sido"]) if c["sido"] in SIDO_LIST else 99,
                               c["sigungu"] or "", c["name"]))
    OUT.write_text(json.dumps({"courses": merged, "sido_list": SIDO_LIST,
                               "sources": manifest}, ensure_ascii=False, indent=1),
                   encoding="utf-8")

    by_sido = {}
    for c in merged:
        by_sido[c["sido"]] = by_sido.get(c["sido"], 0) + 1
    print(f"원자료 {raw_count}행 -> 구장 {len(merged)}곳 (중복 {raw_count - len(merged)}건 합침)")
    for s in SIDO_LIST:
        print(f"  {s:10s} {by_sido.get(s, 0):4d}")
    def rate(k):
        return f"{sum(1 for c in merged if c.get(k) not in (None, '')) / len(merged) * 100:5.1f}%"
    for k in ("holes", "lat", "phone", "hours", "fee", "reserve_url", "turf"):
        print(f"  {k:12s} 채움 {rate(k)}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
