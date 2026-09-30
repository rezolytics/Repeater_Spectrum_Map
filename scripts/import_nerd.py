#!/usr/bin/env python3
"""Import the public New England Repeater Directory CSV (NERepeaters.csv)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from csv_directory import write_directory

SOURCE = {
    "id": "ne",
    "label": "NERepeaters.csv",
    "url": "https://www.nerepeaters.com/NERepeaters.php",
}


def main() -> int:
    here = Path(__file__).resolve().parent.parent
    write_directory([SOURCE], here / "data" / "repeaters.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
