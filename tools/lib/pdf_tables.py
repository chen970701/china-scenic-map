#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
PDF 名录表格提取（pdfplumber）

不少省厅把 A 级景区名录直接发成 PDF（山西、江西等），PDF 里的表格
用文本流切行不可靠（列宽不一、跨页断行），所以走 extract_tables。

用法：
    python tools/lib/pdf_tables.py <pdf路径> [--json 输出路径] [--pages 1-20]

输出 JSON：
    { "pages": [{ "page": 1, "tables": [[[cell,...],...], ...] }] }
单元格统一去空白、去换行；空表跳过。
"""
import json
import sys
import re


def clean(cell):
    if cell is None:
        return ""
    s = str(cell).replace("\u00a0", " ")
    s = s.replace("\r", "\n")
    s = re.sub(r"\n+", "\n", s)
    s = re.sub(r"[ \t]+", " ", s)
    return s.strip()


def parse_page_range(spec, total):
    if not spec:
        return list(range(total))
    start, _, end = spec.partition("-")
    a = max(0, int(start) - 1)
    b = int(end) if end else int(start)
    return list(range(a, min(b, total)))


def main():
    if len(sys.argv) < 2:
        print("usage: pdf_tables.py <pdf> [--json out] [--pages a-b]", file=sys.stderr)
        return 2
    pdf_path = sys.argv[1]
    out_path = ""
    pages_spec = ""
    if "--json" in sys.argv:
        out_path = sys.argv[sys.argv.index("--json") + 1]
    if "--pages" in sys.argv:
        pages_spec = sys.argv[sys.argv.index("--pages") + 1]

    import pdfplumber

    result = {"pages": []}
    with pdfplumber.open(pdf_path) as pdf:
        for idx in parse_page_range(pages_spec, len(pdf.pages)):
            page = pdf.pages[idx]
            tables = []
            try:
                # 政务 PDF 多数是带线框的表；lines 策略识别最稳
                raw = page.extract_tables(
                    {
                        "vertical_strategy": "lines",
                        "horizontal_strategy": "lines",
                        "snap_tolerance": 3,
                        "join_tolerance": 3,
                    }
                )
            except Exception:
                raw = []
            if not raw:
                try:
                    raw = page.extract_tables()
                except Exception:
                    raw = []
            for tb in raw or []:
                rows = [[clean(c) for c in row] for row in tb if row]
                rows = [r for r in rows if any(c for c in r)]
                if len(rows) >= 2:
                    tables.append(rows)
            if tables:
                result["pages"].append({"page": idx + 1, "tables": tables})

    payload = json.dumps(result, ensure_ascii=False)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(payload)
        total = sum(len(t) for p in result["pages"] for t in p["tables"])
        print(f"pages={len(result['pages'])} tables={total} -> {out_path}")
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
