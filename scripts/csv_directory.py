#!/usr/bin/env python3
"""Turn a public repeater-directory CSV into normalized JSON for the spectrum map."""

from __future__ import annotations

import csv
import json
import re
import sys
from datetime import datetime, timezone
from io import StringIO
from pathlib import Path
from urllib.request import Request, urlopen

USER_AGENT = "Repeater-Spectrum-Map/1.0 (local hobby viewer; public CSV import)"

KNOWN_MODES = ("NFM", "D-STAR", "DMR", "YSF", "NXDN", "P25", "M17", "FM")

BAND_SPECS = [
    {"id": "10m", "lo": 28.0, "hi": 30.0, "default_offset_hz": 100_000},
    {"id": "6m", "lo": 50.0, "hi": 54.0, "default_offset_hz": 1_000_000},
    {"id": "2m", "lo": 144.0, "hi": 148.0, "default_offset_hz": 600_000},
    {"id": "1.25", "lo": 219.0, "hi": 225.0, "default_offset_hz": 1_600_000},
    {"id": "70cm", "lo": 420.0, "hi": 450.0, "default_offset_hz": 5_000_000},
    {"id": "902", "lo": 902.0, "hi": 928.0, "default_offset_hz": 25_000_000},
    {"id": "1.2", "lo": 1240.0, "hi": 1300.0, "default_offset_hz": 12_000_000},
]

FREQ_RE = re.compile(r"^\d{2,4}\.\d{2,4}$")
INPUT_RE = re.compile(r"Input:\s*(\d{2,4}\.\d{2,4})", re.I)
SPLIT_MHZ_RE = re.compile(r"\(([+-])\s*(\d+(?:\.\d+)?)\s*MHz\)", re.I)
SPLIT_KHZ_RE = re.compile(r"\(([+-])\s*(\d+(?:\.\d+)?)\s*kHz\)", re.I)
OFFSET_MHZ_RE = re.compile(r"^([+-])\s*(\d+(?:\.\d+)?)M$", re.I)


def mhz_to_hz(value: float) -> int:
    return int(round(value * 1_000_000))


def band_for(freq_mhz: float) -> dict | None:
    for spec in BAND_SPECS:
        if spec["lo"] <= freq_mhz < spec["hi"]:
            return spec
    return None


def parse_modes(value: str) -> list[str]:
    raw = value.upper().replace("DSTAR", "D-STAR").strip()
    if not raw:
        return ["FM"]
    found: list[str] = []
    blob = raw
    for mode in sorted(KNOWN_MODES, key=len, reverse=True):
        if mode in blob:
            found.append(mode)
            blob = blob.replace(mode, " ")
    order = {mode: index for index, mode in enumerate(KNOWN_MODES)}
    found.sort(key=lambda mode: order[mode])
    return found or ["FM"]


def parse_offset_hz(raw: str, comments: str, output_hz: int | None, default_offset_hz: int) -> int | None:
    token = raw.replace(" ", "").upper()
    if token in {"S", "SIMPLEX"}:
        return None
    if token in {"-", "−"}:
        return -default_offset_hz
    if token == "+":
        return default_offset_hz

    mhz_token = OFFSET_MHZ_RE.match(token)
    if mhz_token:
        sign = 1 if mhz_token.group(1) == "+" else -1
        return sign * mhz_to_hz(float(mhz_token.group(2)))

    input_match = INPUT_RE.search(comments)
    if input_match and output_hz is not None:
        return mhz_to_hz(float(input_match.group(1))) - output_hz

    split_mhz = SPLIT_MHZ_RE.search(comments)
    if split_mhz:
        sign = 1 if split_mhz.group(1) == "+" else -1
        return sign * mhz_to_hz(float(split_mhz.group(2)))

    split_khz = SPLIT_KHZ_RE.search(comments)
    if split_khz:
        sign = 1 if split_khz.group(1) == "+" else -1
        return sign * int(round(float(split_khz.group(2)) * 1_000))

    return None


def fetch_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=60) as response:
        raw = response.read()
    return raw.decode("utf-8", errors="replace")


def pad_row(row: list[str]) -> list[str]:
    cells = [cell.strip() for cell in row]
    while len(cells) < 15:
        cells.append("")
    return cells


def repeater_key(item: dict) -> tuple:
    return (item["band"], item["freq"], item["state"], item["city"].casefold(), item["call"].casefold())


def parse_row(cells: list[str], source_id: str) -> tuple[dict | None, dict | None]:
    """Return (repeater, remote). Remote rows are not standalone systems."""
    if not cells or not FREQ_RE.match(cells[0]):
        return None, None
    freq_mhz = float(cells[0])
    spec = band_for(freq_mhz)
    if spec is None:
        print(f"Skipping frequency outside known bands: {cells[0]} {cells[3]} {cells[5]}", file=sys.stderr)
        return None, None

    comments = cells[12]
    remote = {
        "state": cells[2],
        "city": cells[3],
        "toneIn": cells[6],
        "kind": "remote",
        "call": cells[5],
        "freq": freq_mhz,
        "comments": comments,
        "sourceId": source_id,
    }
    if "remote rx" in comments.lower():
        return None, remote

    freq_hz = mhz_to_hz(freq_mhz)
    offset_raw = cells[1]
    offset_hz = parse_offset_hz(offset_raw, comments, freq_hz, spec["default_offset_hz"])
    voip = " ".join(part for part in (cells[10], cells[11]) if part)
    call = cells[5]
    item = {
        "id": f"{spec['id']}-{cells[0]}-{cells[2]}-{call or 'unknown'}-{cells[3]}",
        "band": spec["id"],
        "freqHz": freq_hz,
        "freq": freq_mhz,
        "offset": offset_raw,
        "offsetHz": offset_hz,
        "inputHz": freq_hz + offset_hz if offset_hz is not None else None,
        "state": cells[2],
        "city": cells[3],
        "call": call,
        "modes": parse_modes(cells[4]),
        "toneIn": cells[6],
        "toneOut": cells[7],
        "status": cells[8],
        "county": cells[9],
        "voip": voip,
        "comments": comments,
        "updated": cells[13],
        "remoteRx": [],
        "sourceIds": [source_id],
    }
    return item, None


def prefer(current: str, incoming: str, incoming_newer: bool) -> str:
    if incoming_newer and incoming:
        return incoming
    return current or incoming


def merge_item(current: dict, incoming: dict) -> dict:
    incoming_newer = (incoming.get("updated") or "") >= (current.get("updated") or "")
    for field in ("offset", "status", "county", "voip", "comments", "updated", "toneIn", "toneOut"):
        current[field] = prefer(current.get(field) or "", incoming.get(field) or "", incoming_newer)
    if incoming_newer or current.get("offsetHz") is None:
        if incoming.get("offsetHz") is not None:
            current["offsetHz"] = incoming["offsetHz"]
            current["inputHz"] = incoming["inputHz"]
    specific = [
        mode for mode in dict.fromkeys([*current.get("modes", []), *incoming.get("modes", [])])
        if mode != "FM"
    ]
    current["modes"] = specific or ["FM"]
    for source_id in incoming.get("sourceIds") or []:
        if source_id not in current["sourceIds"]:
            current["sourceIds"].append(source_id)
    return current


def attach_remote(repeaters: list[dict], remote: dict) -> None:
    call = (remote.get("call") or "").casefold()
    matches = [
        item for item in repeaters
        if item["call"].casefold() == call and item["freq"] == remote["freq"]
    ]
    comment = remote.get("comments") or ""
    parent = None
    for item in matches:
        if item["city"] and item["city"].casefold() in comment.casefold():
            parent = item
            break
    if parent is None and matches:
        parent = matches[0]
    if parent is None:
        print(
            f"No parent for remote RX {remote.get('call')} {remote.get('freq')} {remote.get('city')}",
            file=sys.stderr,
        )
        return
    city = remote.get("city") or ""
    state = remote.get("state") or ""
    for existing in parent["remoteRx"]:
        if existing.get("city") == city and existing.get("state") == state:
            return
    parent["remoteRx"].append({
        "state": state,
        "city": city,
        "toneIn": remote.get("toneIn") or "",
        "kind": "remote",
    })


def load_rows(spec: dict) -> list[list[str]]:
    if spec.get("path"):
        text = Path(spec["path"]).read_text(encoding="utf-8", errors="replace")
    else:
        print(f"Fetching {spec['label']}…")
        text = fetch_text(spec["url"])
    return [pad_row(row) for row in csv.reader(StringIO(text)) if any(cell.strip() for cell in row)]


def import_sources(specs: list[dict]) -> dict:
    imported_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    merged: dict[tuple, dict] = {}
    order: list[tuple] = []
    remotes: list[dict] = []
    for spec in specs:
        for row in load_rows(spec):
            item, remote = parse_row(row, spec["id"])
            if remote:
                remotes.append(remote)
                continue
            if not item:
                continue
            key = repeater_key(item)
            if key in merged:
                merge_item(merged[key], item)
            else:
                merged[key] = item
                order.append(key)
    repeaters = [merged[key] for key in order]
    for remote in remotes:
        attach_remote(repeaters, remote)

    by_band: dict[str, list[dict]] = {spec["id"]: [] for spec in BAND_SPECS}
    for item in repeaters:
        by_band[item["band"]].append(item)

    bands = {}
    for spec in BAND_SPECS:
        rows = by_band[spec["id"]]
        if not rows:
            continue
        source_ids = []
        for item in rows:
            for source_id in item["sourceIds"]:
                if source_id not in source_ids:
                    source_ids.append(source_id)
        used = [spec_file for spec_file in specs if spec_file["id"] in source_ids]
        bands[spec["id"]] = {
            "source": used[0]["url"] if len(used) == 1 else "",
            "sourceLabel": " + ".join(spec_file["label"] for spec_file in used),
            "sources": [{"id": spec_file["id"], "label": spec_file["label"], "href": spec_file["url"]} for spec_file in used],
            "asOf": imported_at,
            "band": spec["id"],
            "count": len(rows),
            "repeaters": rows,
        }
    return {
        "importedAt": imported_at,
        "sources": [{"id": spec["id"], "label": spec["label"], "href": spec["url"]} for spec in specs],
        "bands": bands,
    }


def write_directory(specs: list[dict], output: Path) -> dict:
    payload = import_sources(specs)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    total = sum(block["count"] for block in payload["bands"].values())
    print(f"Wrote {total} repeaters across {len(payload['bands'])} bands to {output}")
    for band, block in payload["bands"].items():
        print(f"  {band}: {block['count']} from {block['sourceLabel']}")
    return payload
