"""Price-list ingestion. Every row is validated and sanitised before it can become a price source."""
import csv
import hashlib
import io
import re
from decimal import Decimal, InvalidOperation

from app.money import cents

UNITS = frozenset({"ea", "each", "ft", "lf", "in", "sf", "sy", "yd", "m", "lb", "gal", "box", "roll", "bag", "hr", "set", "pair", "pc"})
MAX_BYTES = 1_000_000
MAX_ROWS = 5000
MAX_PRICE = Decimal("1000000")
REQUIRED_HEADERS = {"name", "unit", "unit_price"}

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_INSTRUCTION = re.compile(
    r"(ignore\s+(all\s+|your\s+|previous\s+|the\s+)?(rules|instructions)|\bsystem\s*:|\bassistant\s*:|"
    r"\bmark\s+(all|every)\b|\bset\s+(the\s+)?total\b)",
    re.IGNORECASE,
)
_FORMULA_PREFIX = ("=", "+", "-", "@")


def validate_name(name: str) -> str | None:
    if not name:
        return "name is empty"
    if len(name) > 200:
        return "name is longer than 200 characters"
    if _CONTROL.search(name):
        return "name contains control characters"
    if name.startswith(_FORMULA_PREFIX):
        return "name starts with a formula character"
    if _INSTRUCTION.search(name):
        return "name contains instruction-like text"
    return None


def parse_unit_price(raw: str) -> tuple[Decimal | None, str | None]:
    try:
        value = Decimal(raw.replace("$", "").replace(",", ""))
    except InvalidOperation:
        return None, "unit_price is not a number"
    if not value.is_finite() or value < 0 or value > MAX_PRICE:
        return None, "unit_price out of range"
    return cents(value), None


def parse_price_csv(raw: bytes) -> tuple[list[dict], list[dict], str]:
    """Returns (accepted rows, rejected rows with reasons, sha256 of the file)."""
    if len(raw) > MAX_BYTES:
        raise ValueError(f"price list is larger than {MAX_BYTES} bytes")
    digest = hashlib.sha256(raw).hexdigest()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("price list must be UTF-8 CSV") from exc
    reader = csv.DictReader(io.StringIO(text))
    headers = {(h or "").strip().lower() for h in (reader.fieldnames or [])}
    if not REQUIRED_HEADERS <= headers:
        raise ValueError("header must include name, unit, unit_price")
    accepted: list[dict] = []
    rejected: list[dict] = []
    for index, raw_row in enumerate(reader, start=1):
        if index > MAX_ROWS:
            raise ValueError(f"price list has more than {MAX_ROWS} rows")
        row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw_row.items() if k}
        name = row.get("name", "")
        reason = validate_name(name)
        unit = row.get("unit", "").lower()
        price, price_reason = parse_unit_price(row.get("unit_price", ""))
        supplier = row.get("supplier", "")
        if not reason and unit not in UNITS:
            reason = f"unknown unit '{unit}'"
        reason = reason or price_reason
        if not reason and (len(supplier) > 100 or _CONTROL.search(supplier)):
            reason = "supplier is invalid"
        if reason:
            rejected.append({"row": index + 1, "reason": reason})
            continue
        accepted.append({"row": index + 1, "name": name, "unit": unit, "unit_price": price, "supplier": supplier or None})
    return accepted, rejected, digest
