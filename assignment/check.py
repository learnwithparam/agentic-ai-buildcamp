"""uv run assignment/check.py [folder]: the same check as check.ts, started from Python.

The check logic lives in one place, checks/lib/langgraph-assignment.ts, so both languages
are held to the same lines.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    command = ["bun", str(ROOT / "assignment" / "check.ts"), *sys.argv[1:]]
    sys.exit(subprocess.run(command, check=False, cwd=ROOT).returncode)
