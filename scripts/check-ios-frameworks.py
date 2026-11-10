#!/usr/bin/env python3
"""Validate the bundle metadata consumed when embedding iOS frameworks."""

import plistlib
import re
import sys
from pathlib import Path


def check_framework(directory):
    directory = Path(directory)
    if directory.suffix != ".framework" or not directory.is_dir():
        raise ValueError(f"Not a framework directory: {directory}")
    with (directory / "Info.plist").open("rb") as file:
        info = plistlib.load(file)
    identifier = info.get("CFBundleIdentifier")
    if not isinstance(identifier, str) or not re.fullmatch(
        r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*", identifier
    ):
        raise ValueError(f"Invalid framework CFBundleIdentifier in {directory}: {identifier!r}")
    executable = directory.stem
    if info.get("CFBundlePackageType") != "FMWK" or info.get("CFBundleExecutable") != executable:
        raise ValueError(f"Invalid framework package type or executable in {directory}")
    if not (directory / executable).is_file():
        raise ValueError(f"Framework executable missing from {directory}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Expected at least one framework directory")
    try:
        for argument in sys.argv[1:]:
            check_framework(argument)
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        sys.exit(str(error))
