"""공공데이터포털에서 파크골프장 데이터 파일을 내려받는다.

사용법:  python scripts/collect.py
결과:    data/raw/<데이터셋ID>.csv, data/raw/manifest.json

포털의 '다운로드' 버튼과 같은 공개 경로를 쓴다. 서버에 부담을 주지 않도록
요청 사이에 간격을 둔다.
"""
import json
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
BASE = "https://www.data.go.kr"
HEADERS = {"User-Agent": "Mozilla/5.0 (parkgolf-collector)"}
DELAY = 1.5  # 초


def decode(b: bytes) -> str:
    for enc in ("utf-8-sig", "cp949"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            pass
    return b.decode("cp949", errors="replace")


def fetch_meta(s: requests.Session, ds_id: str) -> dict:
    """카탈로그 JSON(schema.org)에서 제목·기준일·라이선스를 읽는다."""
    r = s.get(f"{BASE}/catalog/{ds_id}/fileData.json", timeout=30)
    r.raise_for_status()
    j = r.json()
    return {
        "제목": j.get("alternateName") or j.get("name"),
        "수정일": j.get("dateModified"),
        "라이선스": (j.get("license") or {}).get("name"),
        "제공기관": (j.get("creator") or {}).get("name"),
        "주소": f"{BASE}/data/{ds_id}/fileData.do",
    }


def fetch_file(s: requests.Session, ds_id: str) -> str:
    page = s.get(f"{BASE}/data/{ds_id}/fileData.do", timeout=30).text
    m = re.search(r'id="publicDataDetailPk"[^>]*value="([^"]+)"', page)
    if not m:
        raise RuntimeError("publicDataDetailPk 를 찾지 못함")
    info = s.post(
        f"{BASE}/tcs/dss/selectFileDataDownload.do",
        data={
            "publicDataDetailPk": m.group(1),
            "publicDataPk": ds_id,
            "atchFileId": "",
            "fileDetailSn": "1",
            "publicDataTyCode": "PR0051",
        },
        timeout=30,
    ).json()
    if not info.get("status"):
        raise RuntimeError("다운로드 정보 없음")
    r = s.get(
        f"{BASE}/cmm/cmm/fileDownload.do",
        params={"atchFileId": info["atchFileId"], "fileDetailSn": info["fileDetailSn"]},
        timeout=60,
    )
    r.raise_for_status()
    text = decode(r.content)
    if text.lstrip().startswith("<"):
        raise RuntimeError("CSV 대신 HTML 이 왔음 (다운로드 제한일 수 있음)")
    return text


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    sources = json.loads((ROOT / "sources.json").read_text(encoding="utf-8"))["datasets"]
    manifest_path = RAW / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}

    s = requests.Session()
    s.headers.update(HEADERS)
    ok = fail = 0
    for src in sources:
        ds_id = src["id"]
        try:
            meta = fetch_meta(s, ds_id)
            time.sleep(DELAY)
            text = fetch_file(s, ds_id)
            (RAW / f"{ds_id}.csv").write_text(text, encoding="utf-8", newline="")
            meta.update({"기관": src["기관"], "범위": src["범위"],
                         "수집일": time.strftime("%Y-%m-%d")})
            manifest[ds_id] = meta
            ok += 1
            print(f"[성공] {ds_id} {meta['제목']}")
        except Exception as e:  # 한 건이 실패해도 나머지는 계속
            fail += 1
            print(f"[실패] {ds_id} {src['기관']}: {e}")
        time.sleep(DELAY)

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n완료: 성공 {ok}건, 실패 {fail}건 -> {RAW}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
