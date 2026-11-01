"""JSON logs with secret redaction. Request IDs are attached by the middleware in app/main.py."""
import json
import logging
import re
import sys
from datetime import UTC, datetime

_BEARER = re.compile(r"Bearer\s+[A-Za-z0-9._-]+")
_KEY_VALUE = re.compile(r"(password|secret|api[_-]?key|token)(\s*[=:]\s*)\S+", re.IGNORECASE)


def redact(text: str) -> str:
    text = _BEARER.sub("Bearer [REDACTED]", text)
    return _KEY_VALUE.sub(lambda m: m.group(1) + m.group(2) + "[REDACTED]", text)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": redact(record.getMessage()),
        }
        for field in ("request_id", "method", "path", "status", "duration_ms"):
            if hasattr(record, field):
                entry[field] = getattr(record, field)
        if record.exc_info:
            entry["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(entry, default=str)


def configure() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
