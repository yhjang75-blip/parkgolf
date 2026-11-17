"""문화체육관광부 「전국 공공체육시설 현황」 엑셀에서 파크골프장 시트를 원자료 CSV 로 바꾼다.

사용법:  python scripts/mcst.py   (그 뒤 python scripts/geocode.py, python scripts/build.py)
입력:    data/raw/mcst_2024_공공체육시설현황.xlsx
         (문화체육관광부 > 분야별 정책 > 체육 > '2024 전국 공공체육시설 현황(2023년말 기준)' 총괄 첨부파일)
결과:    data/raw/mcst2023.csv, data/raw/manifest.json 에 출처 추가

이 자료는 지방자치단체가 보고한 공공 파크골프장 전수 현황이라 공공데이터포털에 파일이 없는
시·도(충북·충남·부산·울산·대전·제주 등)를 채워 준다. 다만 주소·전화가 비어 있는 행이 많아
다른 자료와 겹치면 그 자료를 우선한다 (build.py 의 RANK '전국' = 가장 낮은 우선순위).
"""
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from xlsx_read import read  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
SRC = RAW / "mcst_2024_공공체육시설현황.xlsx"
OUT = RAW / "mcst2023.csv"
DS_ID = "mcst2023"
META = {
    "제목": "문화체육관광부_2024 전국 공공체육시설 현황(2023년말 기준)_기타 체육시설(파크골프장)",
    "수정일": "2025-03-24",
    "라이선스": "문화체육관광부 공개 통계자료",
    "제공기관": "문화체육관광부",
    "주소": "https://www.mcst.go.kr/kor/s_policy/dept/deptView.jsp?pSeq=1965&pDataCD=0417000000",
    "기관": "문화체육관광부",
    "범위": "전국",
    "수집일": "2026-11-17",
}
SIDO_FULL = {
    "서울": "서울특별시", "부산": "부산광역시", "대구": "대구광역시", "인천": "인천광역시", "광주": "광주광역시",
    "대전": "대전광역시", "울산": "울산광역시", "세종": "세종특별자치시", "경기": "경기도", "강원": "강원특별자치도",
    "충북": "충청북도", "충남": "충청남도", "전북": "전북특별자치도", "전남": "전라남도", "경북": "경상북도",
    "경남": "경상남도", "제주": "제주특별자치도",
}
# 공공데이터포털 자료에 이름만 다르게 이미 들어 있는 구장 (2026-11-17 같은 시·군·구 목록을 눈으로 대조)
SAME_AS = {
    ("서울특별시", "안양천파크골프장(우안)"),        # = 안양천 파크골프장 (구로①)
    ("서울특별시", "안양천파크골프장(좌안)"),        # = 안양천 파크골프장 (구로②)
    ("서울특별시", "중랑천제1체육공원파크골프장"),   # = 중랑천 파크골프장 (동대문구)
    ("서울특별시", "월드컵(노을)공원파크골프장"),    # = 월드컵공원 파크골프장
    ("서울특별시", "여의도둔치파크골프장"),          # = 여의도한강 파크골프장
    ("서울특별시", "파크골프장"),                    # 영등포구, = 안양천 파크골프장 (영등포)
    ("세종특별자치시", "중앙공원1단계파크골프장"),   # = 세종중앙공원 파크골프장
    ("경상북도", "상주시병성천파크골프장"),          # = 상주 병성천 파크골프장
    ("전북특별자치도", "상하면 파크골프장"),         # = 상하 체육테마공원 파크골프장
    ("전북특별자치도", "고창군 파크골프장"),         # = 스포츠타운 파크골프장
    ("경상남도", "스포츠파크(실버레포츠타운)파크골프장"),  # = 거창스포츠파크 파크골프장 1구장
    ("경상남도", "스포츠파크(양평근린공원)파크골프장"),    # = 거창스포츠파크 파크골프장 2구장
    ("경상남도", "위천둔치파크골프장"),              # = 위천면 파크골프장
    ("경상남도", "가북파크연습장"),                  # = 가북면 파크골프장
    ("경상남도", "신원파크연습장"),                  # = 신원면 파크골프장
}
# 시트 열 번호 (머리글 4줄 아래부터 자료)
C_SIDO, C_SIGUNGU, C_ADDR, C_NAME, C_OPER, C_AREA, C_BUILT, C_NOTE = 1, 2, 3, 4, 5, 6, 19, -1


def one_line(s):
    """셀 안 줄바꿈 정리: 낱말 중간에서 끊긴 줄은 붙이고, 괄호 앞 줄바꿈도 붙인다."""
    return re.sub(r"\s+", " ", re.sub(r"\s*\n\s*", "", s or "")).strip()


def main():
    wb = read(SRC)
    sheet = next(n for n in wb if "파크골프" in n)
    rows = wb[sheet]
    out, sido = [], None
    for r in rows[4:]:
        r = r + [""] * (45 - len(r))
        if r[C_SIDO].strip() in SIDO_FULL:            # 시·도 소계 줄
            sido = SIDO_FULL[r[C_SIDO].strip()]
            continue
        name = one_line(r[C_NAME])
        if not name or re.fullmatch(r"[\d.]+", name) or not sido:
            continue
        if "골프" not in name and re.search(r"스케이트|MTB", name):   # 분류가 잘못 들어간 다른 시설
            continue
        if "그라운드골프" in name:   # 파크골프와 다른 종목
            continue
        if (sido, name) in SAME_AS:   # 다른 자료에 다른 이름으로 이미 있는 구장
            continue
        sigungu = one_line(r[C_SIGUNGU]) or None
        addr = one_line(r[C_ADDR])
        if addr and not addr.startswith(sido[:2]):
            addr = f"{sido} {sigungu or ''} {addr}".replace("  ", " ")
        holes = next((m.group(1) for c in r if (m := re.search(r"(\d{1,3})\s*홀", c or ""))), "")
        built = r[C_BUILT].strip()
        out.append({
            "시설명": name,
            "시도": sido,
            "시군구": sigungu or "",
            "주소": addr,
            "운영기관": one_line(r[C_OPER]),
            "면적": r[C_AREA].strip(),
            "홀수": f"{holes}홀" if holes else "",
            "개장": built if re.fullmatch(r"(19|20)\d\d", built) else "",
            "비고": one_line(r[C_NOTE]),
        })
    # 한 공원 안의 여러 면(예: 삼락생태공원 3줄)은 한 구장으로 합친다: 홀 수·면적은 더하고 비고는 잇는다
    merged = {}
    for o in out:
        k = (o["시도"], o["시군구"], re.sub(r"\s", "", o["시설명"]))
        if k not in merged:
            merged[k] = dict(o)
            continue
        m = merged[k]
        hs = [re.match(r"\d+", x["홀수"]) for x in (m, o)]
        m["홀수"] = f"{sum(int(h.group()) for h in hs)}홀" if all(hs) else (m["홀수"] or o["홀수"])
        try:
            m["면적"] = str(float(m["면적"] or 0) + float(o["면적"] or 0)) if (m["면적"] or o["면적"]) else ""
        except ValueError:
            pass
        m["개장"] = min(filter(None, (m["개장"], o["개장"])), default="")
        m["비고"] = " / ".join(filter(None, (m["비고"], o["비고"])))
    out = list(merged.values())
    with open(OUT, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0]))
        w.writeheader()
        w.writerows(out)
    man_p = RAW / "manifest.json"
    manifest = json.loads(man_p.read_text(encoding="utf-8"))
    manifest[DS_ID] = META
    man_p.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    by = {}
    for o in out:
        by[o["시도"]] = by.get(o["시도"], 0) + 1
    print(f"{sheet}: {len(out)}곳 -> {OUT.name}")
    for k, v in sorted(by.items()):
        print(f"  {k:10s} {v:4d}  (주소 있음 {sum(1 for o in out if o['시도'] == k and o['주소'])})")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
