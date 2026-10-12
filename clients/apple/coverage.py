#!/usr/bin/env python3
"""Line coverage of the handwritten app sources in an xcresult; fails below the minimum.

usage: coverage.py <result.xcresult> [minimum percent]
"""
import json
import subprocess
import sys

result, minimum = sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 80.0
report = json.loads(subprocess.check_output(["xcrun", "xccov", "view", "--report", "--json", result]))
covered = total = 0
for target in report["targets"]:
    for file in target["files"]:
        # Core/Sources holds the generated UniFFI bindings; Tests are the tests themselves.
        if "/clients/apple/App/" not in file["path"]:
            continue
        covered += file["coveredLines"]
        total += file["executableLines"]
        print(f"{file['name']:24} {file['coveredLines']:4}/{file['executableLines']:4} {100 * file['lineCoverage']:5.1f}%")
percent = 100 * covered / total
print(f"App sources: {covered}/{total} lines, {percent:.1f}% (minimum {minimum:.0f}%)")
sys.exit(0 if percent >= minimum else 1)
