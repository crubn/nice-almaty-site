#!/usr/bin/env python3
"""Convert "Чат бот.xlsx" -> data/site-facts.json + data/availability.json for the bot.

The workbook is the single source of truth for the Nice Almaty chatbot. Sheets:
  1. "Дома"            — houses: district, gender, address, description, advantages,
                         universities, amenities, status (incl. Дом 6 = Ремонт).
  2. "свободные места" — per-room availability: gender, room type, floor, total/free,
                         price, status. The "Ответственный" (staff name) column is
                         intentionally dropped — no personal data is emitted.
  3. "университеты"    — university → recommended houses, travel time.
  4. "База знаний"     — FAQ (category, question, answer, keywords).

No third-party deps — an .xlsx is a zip of XML, parsed here with the stdlib.

Usage:
    python3 scripts/sync_availability.py
Run whenever the table changes; it rewrites the two JSON files (commit the results).
"""

import datetime
import html
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX = os.path.join(ROOT, "Чат бот.xlsx")
DATA = os.path.join(ROOT, "data")

# Contacts are not in the table — kept here so regeneration doesn't drop them.
CONTACTS = {
    "whatsapp": "+7 777 073 99 90",
    "whatsappLink": "https://wa.me/77770739990",
    "instagram": "@nice_almaty",
    "instagramLink": "https://www.instagram.com/nice_almaty",
    "tiktok": "@nice_almaty",
}

# ── xlsx parsing (stdlib) ─────────────────────────────────────────────────────
def load_shared_strings(z):
    try:
        xml = z.read("xl/sharedStrings.xml").decode("utf-8")
    except KeyError:
        return []
    out = []
    for si in re.finditer(r"<si>(.*?)</si>", xml, re.S):
        out.append(html.unescape("".join(re.findall(r"<t[^>]*>(.*?)</t>", si.group(1), re.S))))
    return out


def col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def parse_sheet(z, path, shared):
    xml = z.read(path).decode("utf-8")
    rows = []
    for rm in re.finditer(r"<row[^>]*r=\"(\d+)\"[^>]*>(.*?)</row>", xml, re.S):
        cells = {}
        for cm in re.finditer(r"<c r=\"([A-Z]+)\d+\"([^>]*)>(.*?)</c>", rm.group(2), re.S):
            col = col_index(cm.group(1))
            attrs, inner = cm.group(2), cm.group(3)
            vm = re.search(r"<v>(.*?)</v>", inner, re.S)
            if vm is None:
                tm = re.search(r"<t[^>]*>(.*?)</t>", inner, re.S)
                val = html.unescape(tm.group(1)) if tm else ""
            else:
                v = vm.group(1)
                val = shared[int(v)] if 't="s"' in attrs else html.unescape(v)
            cells[col] = val.strip() if isinstance(val, str) else val
        if cells:
            width = max(cells) + 1
            rows.append([cells.get(i, "") for i in range(width)])
    return rows


def sheet_by_name(z):
    wb = z.read("xl/workbook.xml").decode("utf-8")
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    rid_target = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
    out = {}
    for m in re.finditer(r'<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"', wb):
        name, rid = m.group(1), m.group(2)
        target = rid_target.get(rid, "")
        out[name] = "xl/" + target if not target.startswith("xl/") else target
    return out


# ── field helpers ─────────────────────────────────────────────────────────────
def num(v):
    try:
        f = float(v)
        return int(f) if f == int(f) else f
    except (TypeError, ValueError):
        return None


def yes(v):
    return str(v).strip().lower() in ("да", "yes", "true", "1")


def excel_date(v):
    n = num(v)
    if not n or n < 30000:
        return None
    return (datetime.date(1899, 12, 30) + datetime.timedelta(days=int(n))).isoformat()


def split_list(v, sep):
    return [p.strip().strip(".") for p in str(v).split(sep) if p.strip().strip(".")]


def get(row, i):
    return row[i].strip() if i < len(row) and isinstance(row[i], str) else (row[i] if i < len(row) else "")


# ── builders ──────────────────────────────────────────────────────────────────
def build_houses(rows):
    houses = {}
    for r in rows[1:]:  # skip header
        hid = num(get(r, 0))
        if hid is None:
            continue
        hid = str(hid)
        status = get(r, 12)
        # NOTE: the address (column 4) is intentionally NOT emitted here. The chatbot
        # must never output street addresses (only районы), and authoritative house
        # facts live in the hand-edited data/houses/dom-*.md files.
        entry = {
            "number": get(r, 1),
            "district": get(r, 2),
            "gender": get(r, 3),
            "status": status,
        }
        desc = get(r, 8)
        if desc and desc != "-":
            entry["description"] = desc
        entry["amenities"] = {"wifi": yes(get(r, 9)), "kitchen": yes(get(r, 10)), "laundry": yes(get(r, 11))}
        adv = split_list(get(r, 13), "\n")
        if adv:
            entry["advantages"] = adv
        unis = split_list(get(r, 14), ",")
        if unis:
            entry["universities"] = unis
        houses[hid] = {k: v for k, v in entry.items() if v not in ("", [], None)}
    return houses


def build_availability(rows):
    out = []
    for r in rows[1:]:
        house = get(r, 1)
        total = num(get(r, 5))
        free = num(get(r, 6))
        price = num(get(r, 7))
        status = get(r, 8)
        # Skip incomplete placeholder rows (no house, or no usable place/price data).
        if not house or (total is None and free is None and price is None and not status):
            continue
        row = {
            "house": house,
            "gender": get(r, 2),
            "roomType": get(r, 3),
            "floor": get(r, 4),
            "totalPlaces": total,
            "free": free,
            "price": price,
            "status": status,
            "note": get(r, 9),
            "lastUpdated": excel_date(get(r, 10)),
            # Column 11 ("Ответственный", staff name) intentionally omitted.
        }
        out.append({k: v for k, v in row.items() if v not in ("", None)})
    return out


def build_universities(rows):
    out = []
    for r in rows[1:]:
        name = get(r, 1)
        if not name:
            continue
        rec = [get(r, i) for i in (4, 5, 6) if get(r, i)]
        entry = {
            "name": name,
            "type": get(r, 2),
            "keywords": split_list(get(r, 3), ","),
            "recommendedHouses": rec,
            "travelTime": get(r, 7),
            "comment": get(r, 8),
        }
        out.append({k: v for k, v in entry.items() if v not in ("", [], None)})
    return out


def build_faq(rows):
    out = []
    for r in rows[1:]:
        q = get(r, 2)
        if not q:
            continue
        entry = {
            "category": get(r, 1),
            "question": q,
            "answer": get(r, 3),
            "keywords": split_list(get(r, 4), ","),
        }
        out.append({k: v for k, v in entry.items() if v not in ("", [], None)})
    return out


def main():
    if not os.path.exists(XLSX):
        sys.exit(f"ERROR: source table not found: {XLSX}")
    z = zipfile.ZipFile(XLSX)
    shared = load_shared_strings(z)
    sheets = sheet_by_name(z)

    def rows_for(name):
        path = sheets.get(name)
        return parse_sheet(z, path, shared) if path else []

    houses = build_houses(rows_for("Дома"))
    availability = build_availability(rows_for("свободные места"))
    universities = build_universities(rows_for("университеты"))
    faq = build_faq(rows_for("База знаний"))

    today = datetime.date.today().isoformat()

    site_facts = {
        "generatedAt": today,
        "brand": {"name": "Nice Almaty", "city": "Алматы / Almaty", "contacts": CONTACTS},
        "houses": houses,
        "universities": universities,
        "faq": faq,
    }
    avail = {"generatedAt": today, "rooms": availability}

    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "site-facts.json"), "w", encoding="utf-8") as f:
        json.dump(site_facts, f, ensure_ascii=False, indent=2)
    with open(os.path.join(DATA, "availability.json"), "w", encoding="utf-8") as f:
        json.dump(avail, f, ensure_ascii=False, indent=2)

    print("Wrote data/site-facts.json and data/availability.json")
    print(f"  houses: {len(houses)} (active: {sum(1 for h in houses.values() if h.get('status','').lower().startswith('актив'))})")
    print(f"  availability rows: {len(availability)}")
    print(f"  universities: {len(universities)} | faq: {len(faq)}")


if __name__ == "__main__":
    main()
