#!/usr/bin/env python3
"""Import the public New York Repeater Directory CSVs.

NYCRepeaters.csv is New York City and Long Island (including nearby New Jersey).
ENYRepeaters.csv is eastern New York. Systems listed in both files are kept once.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from csv_directory import write_directory

SOURCES = [
    {
        "id": "nyc",
        "label": "NYCRepeaters.csv",
        "url": "https://www.nyrepeaters.com/NYCRepeaters.php",
    },
    {
        "id": "eny",
        "label": "ENYRepeaters.csv",
        "url": "https://www.nyrepeaters.com/ENYRepeaters.php",
    },
]


def main() -> int:
    here = Path(__file__).resolve().parent.parent
    write_directory(SOURCES, here / "data" / "ny" / "repeaters.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
