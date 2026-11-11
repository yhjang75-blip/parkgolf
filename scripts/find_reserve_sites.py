"""지자체 공식 도메인에서 공공시설 통합예약 사이트를 찾아 '파크골프' 언급 여부를 확인한다.

사용법:  python scripts/find_reserve_sites.py
결과:    data/reserve_probe.json  (사람이 확인한 뒤 data/gov_sites.json 에 옮겨 적는다)

후보 주소(yeyak./reserve./www.../reserve 등)를 차례로 열어 보고,
응답이 200 이고 본문에 '예약'이 있으면 후보로 기록한다. '파크골프'가 보이면 표시한다.
"""
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings()
ROOT = Path(__file__).resolve().parent.parent
GOV = json.loads((ROOT / "data" / "gov_sites.json").read_text(encoding="utf-8"))
OUT = ROOT / "data" / "reserve_probe.json"
UA = {"User-Agent": "Mozilla/5.0 (parkgolf-map link checker)"}

SUBS = ["yeyak", "reserve", "booking", "reservation", "rsv", "res", "sports", "sisul"]
PATHS = ["/reserve", "/reservation", "/yeyak", "/rsv", "/reserve/index.do", "/reservation/index.do"]


def fetch(url):
    try:
        r = requests.get(url, headers=UA, timeout=8, verify=False, allow_redirects=True)
        if r.status_code != 200:
            return None
        r.encoding = r.apparent_encoding if r.encoding in (None, "ISO-8859-1") else r.encoding
        t = r.text
        if "예약" not in t:
            return None
        title = (re.search(r"<title[^>]*>(.*?)</title>", t, re.S | re.I) or [None, ""])[1].strip()
        return {"url": r.url, "title": re.sub(r"\s+", " ", title)[:80], "parkgolf": "파크골프" in t}
    except requests.RequestException:
        return None


def probe(key):
    home = GOV[key]["home"]
    host = re.sub(r"^https?://(www\.)?", "", home).rstrip("/")
    cands = [f"https://{s}.{host}/" for s in SUBS] + [f"https://www.{host}{p}" for p in PATHS]
    hits = [h for h in map(fetch, cands) if h]
    seen, uniq = set(), []
    for h in hits:
        if h["url"] not in seen:
            seen.add(h["url"])
            uniq.append(h)
    return key, uniq


def main():
    keys = [k for k in GOV if not k.startswith("_")]
    with ThreadPoolExecutor(16) as ex:
        res = dict(ex.map(probe, keys))
    OUT.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    for k, hs in res.items():
        print(k, "->", "; ".join(f"{h['url']} [{h['title']}]{' ★파크골프' if h['parkgolf'] else ''}" for h in hs) or "-")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
