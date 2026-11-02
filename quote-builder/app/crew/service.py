"""Turns a job's notes into a project, scopes and a draft quote. Model calls happen before any write."""
import json
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException

from app.crew.intake import clean_notes
from app.crew.llm import Gateway, NotConfigured, gateway_from_env
from app.crew.pipeline import run_crew
from app.quotes import build_quote, load_profile
from app.progress import report

MAX_CATALOG_ROWS = 5000


def get_gateway() -> Gateway:
    """Tests replace this function with a FakeGateway. Production always uses the configured gateway."""
    try:
        return gateway_from_env()
    except NotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc


def load_catalog(c, tenant_id: str) -> list[dict]:
    rows = c.execute("SELECT id, name, unit, unit_price FROM price_items WHERE tenant_id=? ORDER BY name LIMIT ?",
                     (tenant_id, MAX_CATALOG_ROWS)).fetchall()
    return [dict(r) for r in rows]


def _now() -> str:
    return datetime.now(UTC).isoformat()


async def execute(c_factory, u: dict, job: dict, policy: dict) -> dict:
    """Runs the crew for one job. c_factory is connect(); it is opened only for reads and, afterwards, for writes."""
    cleaned, flags = clean_notes(job["notes"])
    report('materials', 'running')
    with c_factory() as c:
        if not load_profile(c, u["tenant_id"]):
            raise HTTPException(422, "Set the contractor profile (labor rate) before creating a job")
        catalog = load_catalog(c, u["tenant_id"])
    result = await run_crew(cleaned, catalog, get_gateway())

    questions = list(result.questions)
    if flags:
        questions.append("The notes contain instruction-like text. It was treated as data, not as an order.")
    if not result.items and not result.missing and result.status == "needs_input":
        questions.append("No priced items were found in the notes. Add the materials and labor.")
    output = {"status": result.status, "failed_half": result.failed_half, "items": result.items,
              "missing": result.missing, "questions": questions, "flags": flags,
              "problems": result.problems, "trace": result.trace, "quote": None, "project_id": None, "policy": policy}

    with c_factory() as c:
        if result.status == "ready":
            report('draft', 'running')
            customer = {"name": job.get("customer_name"), "project_name": job["project_name"]}
            project_id = str(uuid.uuid4())
            customer_id = None
            if job.get("customer_name"):
                customer_id = str(uuid.uuid4())
                c.execute("INSERT INTO customers(id,tenant_id,name) VALUES(?,?,?)", (customer_id, u["tenant_id"], job["customer_name"]))
            c.execute("INSERT INTO projects(id,tenant_id,customer_id,name) VALUES(?,?,?,?)",
                      (project_id, u["tenant_id"], customer_id, job["project_name"]))
            for item in result.items:
                c.execute(
                    "INSERT INTO scopes(id,tenant_id,project_id,description,quantity,unit,material_unit_cost,"
                    "labor_hours_per_unit,labor_rate,waste_pct,source_type,source_id) VALUES(?,?,?,?,?,?,0,?,0,?,?,?)",
                    (str(uuid.uuid4()), u["tenant_id"], project_id, item["name"], item["quantity"], item["unit"],
                     item["labor_hours_per_unit"], item["waste_pct"], "price_item", item["price_item_id"]))
            quote = build_quote(c, u, project_id, policy, customer_text=result.customer_text,
                                customer=customer, job_id=job["id"])
            output["quote"] = quote
            output["project_id"] = project_id
        _save(c, u, job, output)
    if result.status == 'ready':
        report('draft', 'complete')
    return output


def _save(c, u: dict, job: dict, output: dict) -> None:
    now = _now()
    c.execute(
        "INSERT INTO jobs(id,tenant_id,created_by,status,notes,project_name,customer_name,idempotency_key,project_id,"
        "quote_id,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET status=excluded.status, notes=excluded.notes, project_id=excluded.project_id, "
        "quote_id=excluded.quote_id, result_json=excluded.result_json, updated_at=excluded.updated_at",
        (job["id"], u["tenant_id"], u["id"], output["status"], job["notes"], job["project_name"], job.get("customer_name"),
         job["idempotency_key"], output["project_id"], output["quote"]["id"] if output["quote"] else None,
         json.dumps(output, default=str), job.get("created_at", now), now))
