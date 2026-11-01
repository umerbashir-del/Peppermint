"""Hash-chained audit log. Each row commits to the previous row for its tenant, so edits or deletions are detectable."""
import hashlib
import json
import uuid
from datetime import UTC, datetime

GENESIS = "GENESIS"


def _canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _digest(fields: dict) -> str:
    return hashlib.sha256(_canonical(fields).encode()).hexdigest()


def audit(c, u, action: str, kind: str, eid: str, details: dict | None = None) -> None:
    prev = c.execute("SELECT hash FROM audit_log WHERE tenant_id=? AND hash IS NOT NULL ORDER BY rowid DESC LIMIT 1",
                     (u["tenant_id"],)).fetchone()
    fields = {
        "id": str(uuid.uuid4()), "tenant_id": u["tenant_id"], "actor_id": u.get("id"), "action": action,
        "entity_type": kind, "entity_id": eid, "details": _canonical(details or {}),
        "created_at": datetime.now(UTC).isoformat(), "prev_hash": prev["hash"] if prev else GENESIS,
    }
    c.execute(
        "INSERT INTO audit_log(id,tenant_id,actor_id,action,entity_type,entity_id,details,created_at,prev_hash,hash) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (fields["id"], fields["tenant_id"], fields["actor_id"], action, kind, eid, fields["details"],
         fields["created_at"], fields["prev_hash"], _digest(fields)))


def verify_chain(c, tenant_id: str) -> dict:
    expected = GENESIS
    count = 0
    for row in c.execute("SELECT * FROM audit_log WHERE tenant_id=? ORDER BY rowid", (tenant_id,)):
        count += 1
        if row["hash"] is None:
            return {"ok": False, "rows": count, "first_bad": row["id"], "reason": "unchained row"}
        fields = {"id": row["id"], "tenant_id": row["tenant_id"], "actor_id": row["actor_id"], "action": row["action"],
                  "entity_type": row["entity_type"], "entity_id": row["entity_id"], "details": row["details"],
                  "created_at": row["created_at"], "prev_hash": row["prev_hash"]}
        if row["prev_hash"] != expected or _digest(fields) != row["hash"]:
            return {"ok": False, "rows": count, "first_bad": row["id"], "reason": "hash mismatch"}
        expected = row["hash"]
    return {"ok": True, "rows": count, "first_bad": None, "reason": None}
