#!/usr/bin/env python3
"""Convert "Общежитие Список.xlsx" -> data/availability.json for the Nice Almaty chatbot.

PRIVACY: column C ("ФИО", residents' full names) is NEVER read or emitted. Only the
room number, bed number, occupancy status and (non-personal) reservation notes are kept.

No third-party dependencies — an .xlsx is a zip of XML, parsed here with the stdlib.

Usage:
    python3 scripts/sync_availability.py
Run this whenever the table changes; it rewrites data/availability.json (commit the result).
"""

import datetime
import html
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX = os.path.join(ROOT, "Общежитие Список.xlsx")
OUT = os.path.join(ROOT, "data", "availability.json")

# Column C is ФИО (personal names). It is intentionally absent from COLS so it is
# never parsed into memory or written out.
COL_ROOM = "A"
COL_BED = "B"
COL_STATUS = "D"
COL_NOTE = "E"

STATUS_MAP = {
    "занято": "occupied",
    "бронь": "reserved",
    "свободно": "free",
}

SKIP_ROW_MARKERS = ("итого",)  # summary / total rows at the bottom of each sheet


def parse_sheet(xml: str):
    """Yield {room, bed, status, note} dicts for real data rows (col C skipped)."""
    for row_m in re.finditer(r"<row r=\"(\d+)\"[^>]*>(.*?)</row>", xml, re.S):
        rownum = int(row_m.group(1))
        if rownum < 3:  # row 1 = title, row 2 = headers
            continue
        cells = {}
        for c_m in re.finditer(r"<c r=\"([A-Z]+)\d+\"[^>]*?>(.*?)</c>", row_m.group(2), re.S):
            col = c_m.group(1)
            if col == "C":  # ФИО — never read
                continue
            t_m = re.search(r"<t[^>]*>(.*?)</t>", c_m.group(2), re.S)
            cells[col] = html.unescape(t_m.group(1)).strip() if t_m else ""
        room = cells.get(COL_ROOM, "")
        bed = cells.get(COL_BED, "")
        status_raw = cells.get(COL_STATUS, "")
        note = cells.get(COL_NOTE, "")
        if room.lower().startswith(SKIP_ROW_MARKERS):
            continue
        if not room and not bed and not status_raw:
            continue  # blank spacer row between rooms
        yield {
            "room": room,
            "bed": bed,
            "status": STATUS_MAP.get(status_raw.lower(), status_raw.lower()),
            "note": note,
        }


def build():
    if not os.path.exists(XLSX):
        sys.exit(f"ERROR: source table not found: {XLSX}")

    z = zipfile.ZipFile(XLSX)

    # Map sheet display names ("Дом 1") to their sheetN.xml file via workbook rels.
    wb = z.read("xl/workbook.xml").decode("utf-8")
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    rid_to_target = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels))
    sheets = re.findall(r'<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"', wb)

    houses = {}
    for order, (name, rid) in enumerate(sheets, start=1):
        target = rid_to_target.get(rid, f"worksheets/sheet{order}.xml")
        xml = z.read("xl/" + target).decode("utf-8")

        # House id = the number in the sheet name ("Дом 1" -> 1); matches houses[].id on the site.
        m = re.search(r"(\d+)", name)
        house_id = m.group(1) if m else str(order)

        rooms = {}
        totals = {"free": 0, "reserved": 0, "occupied": 0}
        for bed in parse_sheet(xml):
            if bed["status"] in totals:
                totals[bed["status"]] += 1
            entry = {"bed": bed["bed"], "status": bed["status"]}
            if bed["note"]:
                entry["note"] = bed["note"]
            rooms.setdefault(bed["room"], []).append(entry)

        houses[house_id] = {
            "name": name,
            "totals": {
                **totals,
                "capacity": totals["free"] + totals["reserved"] + totals["occupied"],
            },
            "rooms": [{"room": r, "beds": beds} for r, beds in rooms.items()],
        }

    data = {
        "generatedAt": datetime.date.today().isoformat(),
        "houses": houses,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"Wrote {OUT}")
    for hid, h in houses.items():
        t = h["totals"]
        print(f"  Дом {hid}: free={t['free']} reserved={t['reserved']} "
              f"occupied={t['occupied']} capacity={t['capacity']}")


if __name__ == "__main__":
    build()
