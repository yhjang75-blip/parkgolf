"""모든 구장의 공식 예약 페이지 주소가 열리는지 점검한다.

사용법:  python scripts/check_links.py
결과:    data/link_report.json, 화면에 정상·깨짐·없음 개수
"""
import json
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
COURSES = ROOT / "data" / "courses.json"
REPORT = ROOT / "data" / "link_report.json"
UA = {"User-Agent": "Mozilla/5.0 (parkgolf-link-check)"}


def check(s, url):
    try:
        r = s.get(url, timeout=15, allow_redirects=True)
        return r.status_code, r.url
    except requests.exceptions.SSLError:
        # 일부 공공기관 사이트는 인증서 체인이 불완전해 Python 에서만 실패한다.
        # 페이지가 열리는지만 다시 확인하고 결과에 표시한다.
        try:
            import urllib3
            urllib3.disable_warnings()
            r = s.get(url, timeout=15, allow_redirects=True, verify=False)
            return r.status_code, "SSL인증서경고:" + r.url
        except requests.RequestException as e:
            return None, type(e).__name__
    except requests.RequestException as e:
        return None, type(e).__name__


def main():
    courses = json.loads(COURSES.read_text(encoding="utf-8"))["courses"]
    s = requests.Session()
    s.headers.update(UA)
    seen, report = {}, []
    for c in courses:
        url = c.get("reserve_url")
        if not url:
            report.append({"id": c["id"], "name": c["name"], "status": "없음",
                           "phone": bool(c.get("reserve_phone") or c.get("phone"))})
            continue
        if url not in seen:
            seen[url] = check(s, url)
            time.sleep(0.5)
        code, final = seen[url]
        ok = code is not None and code < 400
        st = ("인증서확인필요" if str(final).startswith("SSL") else "정상") if ok else "깨짐"
        report.append({"id": c["id"], "name": c["name"], "url": url, "code": code,
                       "final_url": final, "status": st})
        print(f"[{st}] {code} {c['name']} {url[:80]}")

    REPORT.write_text(json.dumps({"checked": time.strftime("%Y-%m-%d %H:%M"), "items": report},
                                 ensure_ascii=False, indent=1), encoding="utf-8")
    n = lambda st: sum(1 for r in report if r["status"] == st)
    phone_only = sum(1 for r in report if r["status"] == "없음" and r["phone"])
    print(f"\n예약 주소 정상 {n('정상')} / 인증서 확인 필요 {n('인증서확인필요')} / 깨짐 {n('깨짐')} / 없음 {n('없음')} "
          f"(없음 중 전화번호 있음 {phone_only}, 둘 다 없음 {n('없음') - phone_only})")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
