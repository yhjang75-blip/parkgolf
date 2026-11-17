"""표준 라이브러리만으로 xlsx 시트를 읽어 행 목록으로 돌려준다 (openpyxl 없이)."""
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def col_idx(ref):
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n - 1


def read(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels}
    out = {}
    for sh in wb.find("m:sheets", NS):
        rid = sh.get("{%s}id" % NS["r"])
        t = target[rid].lstrip("/")
        t = t if t.startswith("xl/") else "xl/" + t
        rows = []
        for row in ET.fromstring(z.read(t)).iter("{%s}row" % NS["m"]):
            vals = {}
            for c in row.findall("m:c", NS):
                v = c.find("m:v", NS)
                if v is None:
                    is_ = c.find("m:is", NS)
                    txt = "".join(x.text or "" for x in is_.iter("{%s}t" % NS["m"])) if is_ is not None else ""
                else:
                    txt = v.text or ""
                    if c.get("t") == "s":
                        txt = shared[int(txt)]
                vals[col_idx(c.get("r"))] = txt.strip()
            if vals:
                rows.append([vals.get(i, "") for i in range(max(vals) + 1)])
        out[sh.get("name")] = rows
    return out


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    for name, rows in read(sys.argv[1]).items():
        print("== sheet", name, len(rows))
        for r in rows[:8]:
            print(r[:20])
