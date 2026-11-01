import sys
from pathlib import Path

ROOT = str(Path(__file__).resolve().parents[1])
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from tests.helpers import client  # noqa: E402,F401  (pytest discovers fixtures from conftest)
