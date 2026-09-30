#!/usr/bin/env python3
"""Geocode directory city/state sites into a locations JSON file."""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

USER_AGENT = "NE-Repeater-Spectrum-Map/1.0 (local hobby viewer)"
STATE_NAMES = {
    "CT": "Connecticut",
    "MA": "Massachusetts",
    "ME": "Maine",
    "NH": "New Hampshire",
    "RI": "Rhode Island",
    "VT": "Vermont",
    "NY": "New York",
    "NJ": "New Jersey",
}
STATE_BOX = {
    "CT": (40.95, 42.15, -73.80, -71.75),
    "MA": (41.15, 42.95, -73.60, -69.85),
    "ME": (42.95, 47.55, -71.25, -66.85),
    "NH": (42.65, 45.40, -72.65, -70.50),
    "RI": (41.10, 42.08, -71.95, -71.08),
    "VT": (42.65, 45.10, -73.55, -71.40),
    "NY": (40.49, 45.02, -79.77, -71.85),
    "NJ": (38.92, 41.36, -75.57, -73.90),
}
ALIASES = {
    ("Bangor (local)", "ME"): "Bangor, Maine, USA",
    ("Brooklyn?", "CT"): "Brooklyn, Connecticut, USA",
    ("Cannon Mtn.", "NH"): "Cannon Mountain, Franconia, New Hampshire, USA",
    ("Jay Peak", "VT"): "Jay Peak, Vermont, USA",
    ("Killington Peak", "VT"): "Killington Peak, Vermont, USA",
    ("Lincoln Center", "ME"): "Lincoln, Maine, USA",
    ("Middlefield/Durham", "CT"): "Middlefield, Connecticut, USA",
    ("Mt. Ascutney", "VT"): "Mount Ascutney, Vermont, USA",
    ("Mt. Equinox", "VT"): "Mount Equinox, Vermont, USA",
    ("Mt. Greylock", "MA"): "Mount Greylock, Massachusetts, USA",
    ("Mt. Mansfield", "VT"): "Mount Mansfield, Vermont, USA",
    ("Mt. Snow", "VT"): "Mount Snow, Vermont, USA",
    ("Mt. Wachusett", "MA"): "Wachusett Mountain, Princeton, Massachusetts, USA",
    ("Mt. Washington", "NH"): "Mount Washington, New Hampshire, USA",
    ("N. Attleborough", "MA"): "North Attleborough, Massachusetts, USA",
    ("North Wade", "ME"): "Wade, Maine, USA",
    ("Pack Monadnock", "NH"): "Pack Monadnock, Peterborough, New Hampshire, USA",
    ("Pico Peak", "VT"): "Pico Peak, Vermont, USA",
    ("Saponac", "ME"): "Saponac, Burlington, Maine, USA",
    ("Temple Mountain", "NH"): "Temple Mountain, New Hampshire, USA",
    ("W. Bridgewater", "MA"): "West Bridgewater, Massachusetts, USA",
    ("White River Jct", "VT"): "White River Junction, Vermont, USA",
    ("Hauppague", "NY"): "Hauppauge, New York, USA",
    ("Bayshore", "NY"): "Bay Shore, New York, USA",
    ("Belle Meade", "NJ"): "Belle Mead, New Jersey, USA",
    ("Mt. Beacon", "NY"): "Mount Beacon, Beacon, New York, USA",
    ("Sam's Point", "NY"): "Sam's Point Preserve, Cragsmoor, New York, USA",
    ("Bear Mountain", "NY"): "Bear Mountain, Orange County, New York, USA",
    ("Half Moon", "NY"): "Halfmoon, Saratoga County, New York, USA",
    ("South Hampton", "NY"): "Southampton, Suffolk County, New York, USA",
}


def site_key(city: str, state: str) -> str:
    return f"{city.strip()}|{state.strip().upper()}"


def clean_city(city: str) -> str:
    text = city.replace("\xa0", " ").strip()
    text = re.sub(r"\?$", "", text)
    text = re.sub(r"\s*\(local\)\s*", "", text, flags=re.I)
    text = re.sub(r"^N\.\s+", "North ", text)
    text = re.sub(r"^W\.\s+", "West ", text)
    text = re.sub(r"^E\.\s+", "East ", text)
    text = re.sub(r"^S\.\s+", "South ", text)
    text = re.sub(r"\bMt\.\s+", "Mount ", text)
    text = re.sub(r"\bMtn\.\s*", "Mountain ", text)
    text = re.sub(r"\bJct\b", "Junction", text)
    text = re.sub(r"\bTwp\.?\b", "Township", text)
    text = re.sub(r"\bHts\.?\b", "Heights", text)
    return re.sub(r"\s+", " ", text).strip(" /")


def in_state(lat: float, lon: float, state: str) -> bool:
    box = STATE_BOX.get(state)
    if not box:
        return True
    south, north, west, east = box
    return south <= lat <= north and west <= lon <= east


def fetch_json(url: str) -> dict | list:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def _flat(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def photon_geocode(query: str, state: str, city: str, county: str = "") -> tuple[float, float] | None:
    url = "https://photon.komoot.io/api/?" + urllib.parse.urlencode({"q": query, "limit": 8})
    try:
        payload = fetch_json(url)
    except Exception:
        return None
    wanted = _flat(clean_city(city))
    county_wanted = county.casefold().replace(" county", "").strip()
    best = None
    best_score = 0
    for feature in payload.get("features") or []:
        props = feature.get("properties") or {}
        if (props.get("countrycode") or "").upper() not in {"", "US"}:
            continue
        if (props.get("state") or "") and props.get("state") != STATE_NAMES.get(state, state):
            continue
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        if not in_state(lat, lon, state):
            continue
        score = 0
        for raw in (props.get("name") or "", props.get("city") or "", props.get("locality") or ""):
            flat = _flat(raw)
            if not flat or not wanted:
                continue
            if flat == wanted:
                score = max(score, 10)
            elif flat.startswith(wanted) or (wanted.startswith(flat) and len(flat) >= 5):
                score = max(score, 6)
        if score < 6:
            continue
        county_name = (props.get("county") or "").casefold().replace(" county", "").strip()
        if county_wanted and county_name and county_wanted not in county_name and county_name not in county_wanted:
            continue
        if county_wanted and county_name:
            score += 2
        if score > best_score:
            best = (lat, lon)
            best_score = score
    return best if best_score >= 6 else None


def nominatim_geocode(query: str) -> tuple[float, float] | None:
    url = (
        "https://nominatim.openstreetmap.org/search?"
        + urllib.parse.urlencode({"q": query, "format": "json", "limit": 1})
    )
    try:
        payload = fetch_json(url)
    except Exception:
        return None
    if not payload:
        return None
    return float(payload[0]["lat"]), float(payload[0]["lon"])


def collect_sites(listings: dict) -> list[dict]:
    seen: dict[str, dict] = {}
    for block in listings["bands"].values():
        for item in block["repeaters"]:
            key = site_key(item["city"], item["state"])
            seen.setdefault(
                key,
                {"city": item["city"], "state": item["state"], "county": item.get("county") or ""},
            )
            if item.get("county") and not seen[key]["county"]:
                seen[key]["county"] = item["county"]
            for remote in item.get("remoteRx") or []:
                if not remote.get("city") or not remote.get("state"):
                    continue
                rkey = site_key(remote["city"], remote["state"])
                seen.setdefault(
                    rkey,
                    {"city": remote["city"], "state": remote["state"], "county": ""},
                )
    return list(seen.values())


def geocode_site(site: dict) -> dict | None:
    city, state = site["city"], site["state"]
    if not city or city.strip() in {"?"}:
        return None
    alias = ALIASES.get((city, state))
    cleaned = clean_city(city)
    county = (site.get("county") or "").strip()
    state_name = STATE_NAMES.get(state, state)
    queries = []
    if alias:
        queries.append(("photon", alias))
    if county:
        queries.append(("photon", f"{cleaned}, {county} County, {state_name}, USA"))
        queries.append(("nominatim", f"{cleaned}, {county} County, {state_name}, USA"))
    queries.append(("photon", f"{cleaned}, {state_name}, USA"))
    queries.append(("nominatim", f"{cleaned}, {state_name}, USA"))

    used = set()
    for source, query in queries:
        if (source, query) in used:
            continue
        used.add((source, query))
        if source == "photon":
            point = photon_geocode(query, state, city, county)
        else:
            point = nominatim_geocode(query)
            time.sleep(1.05)
        if not point:
            continue
        lat, lon = point
        if not in_state(lat, lon, state):
            continue
        return {
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "label": f"{city}, {state}",
            "source": source,
            "query": query,
        }
    return None


def main() -> int:
    here = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listings", type=Path, default=here / "data" / "repeaters.json")
    parser.add_argument("--cache", type=Path, default=here / "data" / "geocode-cache.json")
    parser.add_argument("--output", type=Path, default=here / "data" / "locations.json")
    args = parser.parse_args()

    listings = json.loads(args.listings.read_text(encoding="utf-8"))
    cache_path = args.cache
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    sites = collect_sites(listings)
    pending = [site for site in sites if not cache.get(site_key(site["city"], site["state"]))]
    print(f"{len(sites) - len(pending)} cached, {len(pending)} to look up")

    def work(site: dict) -> tuple[str, dict | None]:
        return site_key(site["city"], site["state"]), geocode_site(site)

    done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(work, site) for site in pending]
        for future in as_completed(futures):
            key, result = future.result()
            cache[key] = result
            done += 1
            if result:
                print(f"[{done}/{len(pending)}] {key} {result['lat']}, {result['lon']} via {result['source']}")
            else:
                print(f"[{done}/{len(pending)}] {key} MISSING")
            if done % 15 == 0 or done == len(pending):
                cache_path.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")

    cache_path.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")
    found = sum(1 for site in sites if cache.get(site_key(site["city"], site["state"])))
    missing = [site_key(site["city"], site["state"]) for site in sites if not cache.get(site_key(site["city"], site["state"]))]

    payload = {
        "geocodedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": found,
        "missing": missing,
        "sites": {key: value for key, value in cache.items() if value},
    }
    out = args.output
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {found} sites ({len(missing)} missing) to {out}")
    return 0 if not missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
