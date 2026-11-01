"""Caps and cleans contractor notes before any agent reads them."""
import re

MAX_NOTES = 8000
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# Flags are reported to the contractor. They never change how the notes are used.
_INSTRUCTION = re.compile(
    r"(ignore\s+(all\s+|your\s+|previous\s+|the\s+)?(rules|instructions)|\bsystem\s*:|\bassistant\s*:|"
    r"\bset\s+(the\s+)?total\b|\$\s*1\b)",
    re.IGNORECASE,
)


def clean_notes(text: str) -> tuple[str, list[str]]:
    if len(text) > MAX_NOTES:
        raise ValueError(f"notes are longer than {MAX_NOTES} characters")
    cleaned = _CONTROL.sub("", text.replace("\r\n", "\n")).strip()
    if not cleaned:
        raise ValueError("notes are empty")
    flags = sorted({m.group(0).lower() for m in _INSTRUCTION.finditer(cleaned)})[:5]
    return cleaned, flags
