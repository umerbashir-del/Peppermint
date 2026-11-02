import hmac
import json
import logging
import os
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import ratelimit
from app.audit import audit, verify_chain
from app.catalog import MAX_BYTES, UNITS, parse_price_csv
from app.crew import service as crew_service
from app import supplier_agents
from app import progress
from app.config import cors_origins
from app.db import connect, init_db
from app.logging_setup import configure
from app.money import cents
from app.pdf import render_quote_pdf
from app.quotes import build_quote, load_profile, snapshot_hash
from app.security import DUMMY_HASH, current_user, hash_password, token_for, validate_password, verify_password

log = logging.getLogger("qbc")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"
LOCK_SECONDS = 900
MAX_FAILURES = 5
SOURCE_ALLOWED = {"supplier_quote", "supplier_invoice", "supplier_price_sheet"}  # deny by default


@asynccontextmanager
async def lifespan(app):
    configure()
    init_db()
    yield


app = FastAPI(title="Quote Builder Crew API", version="2.0.0", lifespan=lifespan)
_origins = cors_origins(os.getenv("QBC_CORS_ORIGINS", ""))
if _origins:
    app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_credentials=False,
                       allow_methods=["GET", "POST", "PUT", "PATCH"], allow_headers=["Authorization", "Content-Type", "Idempotency-Key"])
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    started = time.monotonic()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Content-Security-Policy"] = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                                                  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith(("/auth", "/audit", "/jobs", "/quotes")) else "private, no-cache"
    log.info("request", extra={"request_id": request_id, "method": request.method, "path": request.url.path,
                               "status": response.status_code, "duration_ms": round((time.monotonic() - started) * 1000, 1)})
    return response


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    log.error("unhandled error", extra={"request_id": request_id, "path": request.url.path}, exc_info=exc)
    return JSONResponse({"detail": "Internal error", "request_id": request_id}, status_code=500)


def role(*roles):
    def dep(u=Depends(current_user)):
        if u["role"] not in roles:
            raise HTTPException(403, "Insufficient permission")
        return u
    return dep


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _money(value) -> str:
    return str(cents(value))


# ---------- request models ----------
class Login(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)


class BootstrapIn(BaseModel):
    tenant_id: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=3, max_length=254, pattern=EMAIL_PATTERN)
    password: str = Field(min_length=14, max_length=256)


class UserIn(BaseModel):
    email: str = Field(min_length=3, max_length=254, pattern=EMAIL_PATTERN)
    password: str = Field(min_length=14, max_length=256)
    role: Literal["admin", "estimator", "reviewer", "viewer"]


class UserPatch(BaseModel):
    active: bool


class CustomerIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: str | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=50)
    address: str | None = Field(default=None, max_length=500)


class ProjectIn(BaseModel):
    customer_id: str | None = Field(default=None, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    address: str | None = Field(default=None, max_length=500)


class ScopeIn(BaseModel):
    description: str = Field(min_length=1, max_length=2000)
    quantity: float = Field(gt=0, le=100000)
    unit: str = Field(min_length=1, max_length=16)
    labor_hours_per_unit: float = Field(default=0, ge=0, le=500)
    waste_pct: float = Field(default=0, ge=0, le=1)
    source_type: Literal["price_item"] | None = None
    source_id: str | None = Field(default=None, max_length=64)


class EvidenceIn(BaseModel):
    scope_id: str = Field(max_length=64)
    supplier: str = Field(min_length=1, max_length=200)
    source_type: str = Field(min_length=1, max_length=50)
    unit_cost: float = Field(ge=0, le=1000000)
    currency: Literal["USD"] = "USD"
    unit: str = Field(min_length=1, max_length=16)
    spec: str = Field(min_length=1, max_length=500)
    valid_until: date
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    stock_confirmed: bool
    commercial_use: bool


class ProfileIn(BaseModel):
    license_number: str | None = Field(default=None, max_length=60)
    insurance_text: str | None = Field(default=None, max_length=500)
    payment_terms: str | None = Field(default=None, max_length=500)
    labor_rate: float = Field(ge=0, le=10000)
    valid_until_days: int = Field(default=30, ge=1, le=365)


class QuoteIn(BaseModel):
    project_id: str = Field(max_length=64)
    overhead_pct: float = Field(default=0, ge=0, le=1)
    markup_pct: float = Field(default=0, ge=0, le=5)
    tax_rate: float = Field(default=0, ge=0, le=1)
    delivery: float = Field(default=0, ge=0, le=1000000)
    discount: float = Field(default=0, ge=0, le=1000000)


class ReviewDecision(BaseModel):
    reason: str = Field(min_length=3, max_length=2000)


class ApproveIn(BaseModel):
    snapshot_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class JobIn(BaseModel):
    workflow: Literal['crew', 'supplier'] = 'crew'
    notes: str = Field(min_length=1, max_length=8000)
    project_name: str = Field(min_length=1, max_length=200)
    customer_name: str | None = Field(default=None, max_length=200)
    overhead_pct: float = Field(default=0, ge=0, le=1)
    markup_pct: float = Field(default=0, ge=0, le=5)
    tax_rate: float = Field(default=0, ge=0, le=1)


class AnswerIn(BaseModel):
    answers: str = Field(min_length=1, max_length=2000)


def _policy(data) -> dict:
    return {"overhead_pct": data.overhead_pct, "markup_pct": data.markup_pct, "tax_rate": data.tax_rate,
            "delivery": getattr(data, "delivery", 0), "discount": getattr(data, "discount", 0)}


# ---------- health and UI ----------
@app.get("/health")
def health():
    return {"status": "ok", "service": "quote-builder-crew"}


@app.get("/ready")
def ready():
    with connect() as c:
        c.execute("SELECT 1 FROM schema_migrations LIMIT 1").fetchone()
    return {"status": "ready"}


@app.get("/", include_in_schema=False)
def web_app():
    return FileResponse(WEB_DIR / "index.html")


# ---------- auth ----------
@app.post("/auth/login")
def login(data: Login, request: Request):
    ip = request.client.host if request.client else "unknown"
    if not ratelimit.allow(f"login-ip:{ip}", 20, 60):
        raise HTTPException(429, "Too many attempts. Try again later.")
    key = f"{data.tenant_id}|{data.email.lower()}"
    now = time.time()
    with connect() as c:
        attempt = c.execute("SELECT failures, locked_until FROM login_attempts WHERE key=?", (key,)).fetchone()
        if attempt and attempt["locked_until"] > now:
            raise HTTPException(429, "Account temporarily locked. Try again later.")
        row = c.execute("SELECT * FROM users WHERE tenant_id=? AND email=? AND active=1",
                        (data.tenant_id, data.email.lower())).fetchone()
        password_ok = verify_password(data.password, row["password_hash"] if row else DUMMY_HASH) and row is not None
        if not password_ok:
            failures = (attempt["failures"] if attempt else 0) + 1
            locked_until = now + LOCK_SECONDS if failures >= MAX_FAILURES else 0
            c.execute("INSERT INTO login_attempts(key,failures,locked_until) VALUES(?,?,?) "
                      "ON CONFLICT(key) DO UPDATE SET failures=excluded.failures, locked_until=excluded.locked_until",
                      (key, 0 if locked_until else failures, locked_until))
            user = None
        else:
            c.execute("DELETE FROM login_attempts WHERE key=?", (key,))
            user = dict(row)
    if user is None:
        raise HTTPException(401, "Invalid credentials")
    return {"access_token": token_for(user), "token_type": "bearer", "expires_in": 3600, "role": user["role"]}


@app.post("/auth/logout")
def logout(u=Depends(current_user)):
    with connect() as c:
        c.execute("UPDATE users SET token_version = token_version + 1 WHERE id=?", (u["id"],))
    return {"ok": True}


@app.get('/auth/me')
def me(u=Depends(current_user)):
    return u


@app.post("/auth/bootstrap")
def bootstrap(data: BootstrapIn, x_bootstrap_secret: str | None = Header(default=None)):
    """Creates the first owner. Disabled after the first user exists, unless QBC_ALLOW_MULTI_TENANT_BOOTSTRAP=1."""
    secret = os.getenv("QBC_BOOTSTRAP_SECRET")
    if not secret:
        raise HTTPException(404, "Bootstrap disabled")
    if not x_bootstrap_secret or not hmac.compare_digest(x_bootstrap_secret, secret):
        raise HTTPException(403, "Invalid bootstrap credential")
    validate_password(data.password)
    with connect() as c:
        if c.execute("SELECT 1 FROM users LIMIT 1").fetchone() and os.getenv("QBC_ALLOW_MULTI_TENANT_BOOTSTRAP") != "1":
            raise HTTPException(404, "Bootstrap disabled")
        if c.execute("SELECT 1 FROM users WHERE tenant_id=?", (data.tenant_id,)).fetchone():
            raise HTTPException(409, "Tenant already initialized")
        u = {"id": str(uuid.uuid4()), "tenant_id": data.tenant_id, "email": data.email.lower(), "role": "owner"}
        c.execute("INSERT INTO users(id,tenant_id,email,role,password_hash) VALUES(?,?,?,?,?)",
                  (u["id"], u["tenant_id"], u["email"], "owner", hash_password(data.password)))
        audit(c, u, "bootstrap", "user", u["id"])
    return {"created": True}


# ---------- users ----------
@app.get("/users")
def list_users(u=Depends(role("owner", "admin"))):
    with connect() as c:
        return [dict(r) for r in c.execute(
            "SELECT id, email, role, active, created_at FROM users WHERE tenant_id=? ORDER BY created_at", (u["tenant_id"],))]


@app.post("/users")
def create_user(data: UserIn, u=Depends(role("owner"))):
    validate_password(data.password)
    email = data.email.lower()
    with connect() as c:
        if c.execute("SELECT 1 FROM users WHERE tenant_id=? AND email=?", (u["tenant_id"], email)).fetchone():
            raise HTTPException(409, "A user with that email already exists")
        uid_ = str(uuid.uuid4())
        c.execute("INSERT INTO users(id,tenant_id,email,role,password_hash) VALUES(?,?,?,?,?)",
                  (uid_, u["tenant_id"], email, data.role, hash_password(data.password)))
        audit(c, u, "create", "user", uid_, {"role": data.role})
    return {"id": uid_, "email": email, "role": data.role, "active": 1}


@app.patch("/users/{user_id}")
def patch_user(user_id: str, data: UserPatch, u=Depends(role("owner"))):
    if user_id == u["id"] and not data.active:
        raise HTTPException(409, "You cannot deactivate your own account")
    with connect() as c:
        row = c.execute("SELECT id FROM users WHERE id=? AND tenant_id=?", (user_id, u["tenant_id"])).fetchone()
        if not row:
            raise HTTPException(404, "User not found")
        # Bumping token_version invalidates every token that user already holds.
        c.execute("UPDATE users SET active=?, token_version=token_version+1 WHERE id=?", (int(data.active), user_id))
        audit(c, u, "set_active", "user", user_id, {"active": data.active})
    return {"id": user_id, "active": data.active}


# ---------- customers, projects, scopes ----------
@app.post("/customers")
def customer(data: CustomerIn, u=Depends(role("owner", "admin", "estimator"))):
    with connect() as c:
        eid = str(uuid.uuid4())
        c.execute("INSERT INTO customers(id,tenant_id,name,email,phone,address) VALUES(?,?,?,?,?,?)",
                  (eid, u["tenant_id"], data.name, data.email, data.phone, data.address))
        audit(c, u, "create", "customer", eid)
        return dict(c.execute("SELECT * FROM customers WHERE id=?", (eid,)).fetchone())


@app.get("/customers")
def customers(u=Depends(current_user)):
    with connect() as c:
        return [dict(x) for x in c.execute("SELECT * FROM customers WHERE tenant_id=? ORDER BY created_at DESC", (u["tenant_id"],))]


@app.post("/projects")
def project(data: ProjectIn, u=Depends(role("owner", "admin", "estimator"))):
    with connect() as c:
        if data.customer_id and not c.execute("SELECT 1 FROM customers WHERE id=? AND tenant_id=?", (data.customer_id, u["tenant_id"])).fetchone():
            raise HTTPException(404, "Customer not found")
        eid = str(uuid.uuid4())
        c.execute("INSERT INTO projects(id,tenant_id,customer_id,name,address) VALUES(?,?,?,?,?)",
                  (eid, u["tenant_id"], data.customer_id, data.name, data.address))
        audit(c, u, "create", "project", eid)
        return dict(c.execute("SELECT * FROM projects WHERE id=?", (eid,)).fetchone())


@app.get("/projects")
def projects(u=Depends(current_user)):
    with connect() as c:
        return [dict(x) for x in c.execute("SELECT * FROM projects WHERE tenant_id=? ORDER BY created_at DESC", (u["tenant_id"],))]


@app.post("/projects/{project_id}/scopes")
def scope(project_id: str, data: ScopeIn, u=Depends(role("owner", "admin", "estimator"))):
    if data.unit not in UNITS:
        raise HTTPException(422, f"Unit '{data.unit}' is not supported")
    with connect() as c:
        if not c.execute("SELECT 1 FROM projects WHERE id=? AND tenant_id=?", (project_id, u["tenant_id"])).fetchone():
            raise HTTPException(404, "Project not found")
        if data.source_type == "price_item":
            item = c.execute("SELECT unit FROM price_items WHERE id=? AND tenant_id=?", (data.source_id, u["tenant_id"])).fetchone()
            if not item:
                raise HTTPException(422, "Price item not found in this workspace")
            if item["unit"] != data.unit:
                raise HTTPException(422, f"Unit mismatch: price item is per '{item['unit']}'")
        elif data.source_type is not None or data.source_id:
            raise HTTPException(422, "Only price_item sources can be attached here; evidence is attached through /evidence")
        eid = str(uuid.uuid4())
        # Cost is never accepted from the client. It is resolved from the source at quote time.
        c.execute("INSERT INTO scopes(id,tenant_id,project_id,description,quantity,unit,material_unit_cost,labor_hours_per_unit,"
                  "labor_rate,waste_pct,source_type,source_id) VALUES(?,?,?,?,?,?,0,?,0,?,?,?)",
                  (eid, u["tenant_id"], project_id, data.description, data.quantity, data.unit,
                   data.labor_hours_per_unit, data.waste_pct, data.source_type, data.source_id))
        audit(c, u, "create", "scope", eid)
        return dict(c.execute("SELECT * FROM scopes WHERE id=?", (eid,)).fetchone())


@app.get("/projects/{project_id}/scopes")
def scopes(project_id: str, u=Depends(current_user)):
    with connect() as c:
        if not c.execute("SELECT 1 FROM projects WHERE id=? AND tenant_id=?", (project_id, u["tenant_id"])).fetchone():
            raise HTTPException(404, "Project not found")
        return [dict(x) for x in c.execute("SELECT * FROM scopes WHERE project_id=? AND tenant_id=? ORDER BY rowid", (project_id, u["tenant_id"]))]


# ---------- price lists, profile, evidence ----------
@app.post("/price-lists")
async def upload_price_list(request: Request, u=Depends(role("owner", "admin"))):
    if not request.headers.get("content-type", "").startswith(("text/csv", "text/plain")):
        raise HTTPException(415, "Upload a CSV with content-type text/csv")
    body = await request.body()
    if len(body) > MAX_BYTES:
        raise HTTPException(413, f"Price list is larger than {MAX_BYTES} bytes")
    try:
        accepted, rejected, digest = parse_price_csv(body)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not accepted:
        raise HTTPException(422, {"message": "No rows were accepted", "rejected": rejected[:100]})
    list_id = str(uuid.uuid4())
    with connect() as c:
        c.execute("INSERT INTO price_lists(id,tenant_id,sha256,accepted_count,rejected_count,uploaded_by,uploaded_at) VALUES(?,?,?,?,?,?,?)",
                  (list_id, u["tenant_id"], digest, len(accepted), len(rejected), u["id"], _now()))
        for row in accepted:
            c.execute("INSERT INTO price_items(id,tenant_id,price_list_id,name,unit,unit_price,supplier,source_row) VALUES(?,?,?,?,?,?,?,?)",
                      (str(uuid.uuid4()), u["tenant_id"], list_id, row["name"], row["unit"], str(row["unit_price"]), row["supplier"], row["row"]))
        audit(c, u, "upload", "price_list", list_id, {"sha256": digest, "accepted": len(accepted), "rejected": len(rejected)})
    return {"id": list_id, "sha256": digest, "accepted": len(accepted), "rejected": rejected[:100]}


@app.get("/price-items")
def price_items(q: str = "", limit: int = 50, u=Depends(current_user)):
    limit = max(1, min(limit, 200))
    with connect() as c:
        rows = c.execute("SELECT id, name, unit, unit_price, supplier FROM price_items WHERE tenant_id=? AND name LIKE ? ORDER BY name LIMIT ?",
                         (u["tenant_id"], f"%{q[:100]}%", limit))
        return [dict(r) for r in rows]


@app.get("/profile")
def get_profile(u=Depends(current_user)):
    with connect() as c:
        row = load_profile(c, u["tenant_id"])
        return dict(row) if row else {}


@app.put("/profile")
def put_profile(data: ProfileIn, u=Depends(role("owner", "admin"))):
    with connect() as c:
        c.execute("INSERT INTO contractor_profiles(tenant_id,license_number,insurance_text,payment_terms,labor_rate,valid_until_days,updated_by,updated_at) "
                  "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET license_number=excluded.license_number, "
                  "insurance_text=excluded.insurance_text, payment_terms=excluded.payment_terms, labor_rate=excluded.labor_rate, "
                  "valid_until_days=excluded.valid_until_days, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                  (u["tenant_id"], data.license_number, data.insurance_text, data.payment_terms, _money(data.labor_rate),
                   data.valid_until_days, u["id"], _now()))
        audit(c, u, "update", "profile", u["tenant_id"])
        return dict(load_profile(c, u["tenant_id"]))


@app.post("/evidence")
def evidence(data: EvidenceIn, u=Depends(role("owner", "admin", "estimator"))):
    if data.source_type.lower() not in SOURCE_ALLOWED:
        raise HTTPException(422, "Evidence must be a current supplier-originated quote or invoice")
    if not data.stock_confirmed or not data.commercial_use:
        raise HTTPException(422, "Evidence requires stock confirmation and commercial-use permission")
    if data.valid_until < datetime.now(UTC).date():
        raise HTTPException(422, "Evidence is already expired")
    if data.unit not in UNITS:
        raise HTTPException(422, f"Unit '{data.unit}' is not supported")
    with connect() as c:
        scope_row = c.execute("SELECT * FROM scopes WHERE id=? AND tenant_id=?", (data.scope_id, u["tenant_id"])).fetchone()
        if not scope_row:
            raise HTTPException(404, "Scope not found")
        if scope_row["unit"] != data.unit:
            raise HTTPException(422, f"Unit mismatch: scope is '{scope_row['unit']}'")
        eid = str(uuid.uuid4())
        c.execute("INSERT INTO evidence(id,tenant_id,scope_id,supplier,source_type,unit_cost,currency,unit,spec,valid_until,sha256,"
                  "stock_confirmed,commercial_use,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (eid, u["tenant_id"], data.scope_id, data.supplier, data.source_type, data.unit_cost, data.currency, data.unit,
                   data.spec, data.valid_until.isoformat(), data.sha256.lower(), int(data.stock_confirmed), int(data.commercial_use), u["id"]))
        c.execute("UPDATE scopes SET source_type='evidence', source_id=? WHERE id=?", (eid, data.scope_id))
        audit(c, u, "create", "evidence", eid, {"scope_id": data.scope_id})
    return {"id": eid, "scope_id": data.scope_id}


@app.get("/evidence")
def evidence_list(scope_id: str | None = None, u=Depends(current_user)):
    cols = "id,scope_id,supplier,source_type,unit_cost,currency,unit,spec,valid_until,sha256,stock_confirmed,commercial_use,created_by,created_at"
    with connect() as c:
        if scope_id:
            rows = c.execute(f"SELECT {cols} FROM evidence WHERE tenant_id=? AND scope_id=? ORDER BY created_at DESC", (u["tenant_id"], scope_id))
        else:
            rows = c.execute(f"SELECT {cols} FROM evidence WHERE tenant_id=? ORDER BY created_at DESC", (u["tenant_id"],))
        return [dict(r) for r in rows]


# ---------- quotes ----------
@app.post("/quotes")
def create_quote(data: QuoteIn, u=Depends(role("owner", "admin", "estimator"))):
    with connect() as c:
        job = c.execute('SELECT result_json FROM jobs WHERE project_id=? AND tenant_id=?', (data.project_id, u['tenant_id'])).fetchone()
        if job and json.loads(job['result_json']).get('workflow') == 'supplier':
            raise HTTPException(409, 'Create a fresh supplier-materials job to reprice this supplier quote.')
        return build_quote(c, u, data.project_id, _policy(data))


@app.get("/quotes")
def quotes(u=Depends(current_user)):
    with connect() as c:
        return [dict(x) for x in c.execute(
            "SELECT id, project_id, version, status, subtotal, total, snapshot_hash, created_by, approved_by, approved_at, "
            "reviewed_by, reviewed_at, review_reason, created_at FROM quotes WHERE tenant_id=? ORDER BY created_at DESC", (u["tenant_id"],))]


@app.get("/quotes/{quote_id}")
def quote_detail(quote_id: str, u=Depends(current_user)):
    with connect() as c:
        q = c.execute("SELECT * FROM quotes WHERE id=? AND tenant_id=?", (quote_id, u["tenant_id"])).fetchone()
        if not q:
            raise HTTPException(404, "Quote not found")
        quote = dict(q)
        raw = quote.pop("snapshot_json")
    snapshot = json.loads(raw) if raw else None
    verified = bool(snapshot is not None and snapshot_hash(snapshot) == quote["snapshot_hash"])
    if snapshot and u['role'] == 'viewer':
        snapshot.pop('supplier_agents', None)
    return {"quote": quote, "snapshot": snapshot, "snapshot_verified": verified}


@app.post("/quotes/{quote_id}/approve")
async def approve(quote_id: str, data: ApproveIn, u=Depends(role("owner", "admin", "reviewer"))):
    with connect() as c:
        q = c.execute("SELECT * FROM quotes WHERE id=? AND tenant_id=?", (quote_id, u["tenant_id"])).fetchone()
        if not q:
            raise HTTPException(404, "Quote not found")
        if q["created_by"] == u["id"]:
            raise HTTPException(403, "Separation of duties: quote creator cannot approve")
        if q["status"] != "draft":
            raise HTTPException(409, "Only draft quotes may be approved")
        if not hmac.compare_digest(data.snapshot_hash, q["snapshot_hash"]):
            raise HTTPException(409, "Snapshot hash does not match the quote the reviewer saw")
        snapshot = json.loads(q['snapshot_json'])
        if snapshot_hash(snapshot) != q['snapshot_hash']:
            raise HTTPException(409, 'Quote snapshot integrity check failed')
        supplier_check = await supplier_agents.validate_approval(u, snapshot)
        # No subprocess/model wait occurs under the serialized database write lock.
        c.execute('BEGIN IMMEDIATE')
        changed = c.execute("UPDATE quotes SET status='approved', approved_by=?, approved_at=? WHERE id=? AND status='draft' AND snapshot_hash=?", (u["id"], _now(), quote_id, data.snapshot_hash))
        if changed.rowcount != 1:
            raise HTTPException(409, 'Quote changed during approval; refresh and review again.')
        supplier_agents.reserve_credit(c, quote_id, snapshot, supplier_check)
        audit(c, u, "approve", "quote", quote_id, {"created_by": q["created_by"], "snapshot_hash": q["snapshot_hash"]})
    return {"id": quote_id, "status": "approved", "snapshot_hash": q["snapshot_hash"]}


@app.post("/quotes/{quote_id}/reject")
def reject_quote(quote_id: str, data: ReviewDecision, u=Depends(role("owner", "admin", "reviewer"))):
    with connect() as c:
        q = c.execute("SELECT * FROM quotes WHERE id=? AND tenant_id=?", (quote_id, u["tenant_id"])).fetchone()
        if not q:
            raise HTTPException(404, "Quote not found")
        if q["created_by"] == u["id"]:
            raise HTTPException(403, "Separation of duties: quote creator cannot review")
        if q["status"] != "draft":
            raise HTTPException(409, "Only draft quotes may be rejected")
        c.execute("UPDATE quotes SET status='rejected', reviewed_by=?, reviewed_at=?, review_reason=? WHERE id=?",
                  (u["id"], _now(), data.reason, quote_id))
        audit(c, u, "reject", "quote", quote_id, {"created_by": q["created_by"], "reason": data.reason})
    return {"id": quote_id, "status": "rejected", "reason": data.reason}


@app.get("/quotes/{quote_id}/pdf")
def quote_pdf(quote_id: str, u=Depends(current_user)):
    with connect() as c:
        q = c.execute("SELECT * FROM quotes WHERE id=? AND tenant_id=?", (quote_id, u["tenant_id"])).fetchone()
        if not q:
            raise HTTPException(404, "Quote not found")
        if q["status"] != "approved":
            raise HTTPException(409, "Only approved quotes can be exported")
        snapshot = json.loads(q["snapshot_json"])
        if snapshot_hash(snapshot) != q["snapshot_hash"]:
            raise HTTPException(409, "Stored snapshot does not match its hash; export refused")
        status = q["status"]
    pdf = render_quote_pdf(snapshot, quote_id, q["snapshot_hash"], status)
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="quote-{quote_id[:8]}.pdf"'})


# ---------- jobs (the crew) ----------
def _job_view(row, user=None) -> dict:
    data = json.loads(row["result_json"] or "{}")
    if user and user['role'] != 'viewer':
        data['notes'] = row['notes']
    if user and user['role'] == 'viewer':
        for key in ['agents', 'questions', 'trace', 'problems', 'flags']:
            data.pop(key, None)
    return {"id": row["id"], "status": row["status"], "project_name": row["project_name"], "customer_name": row["customer_name"],
            "project_id": row["project_id"], "quote_id": row["quote_id"], "created_at": row["created_at"], **data}


@app.post("/jobs")
async def create_job(data: JobIn, idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=8, max_length=128),
                     u=Depends(role("owner", "admin", "estimator"))):
    with connect() as c:
        existing = c.execute("SELECT * FROM jobs WHERE tenant_id=? AND idempotency_key=?", (u["tenant_id"], idempotency_key)).fetchone()
        if existing:
            return _job_view(existing, u)
    job = {"id": str(uuid.uuid4()), "notes": data.notes, "project_name": data.project_name,
           "customer_name": data.customer_name, "idempotency_key": idempotency_key, "created_at": _now()}
    try:
        execute = supplier_agents.execute if data.workflow == 'supplier' else crew_service.execute
        output = await supplier_agents.claimed_execute(connect, u, job, _policy(data), execute, initial=True)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except sqlite3.IntegrityError as exc:
        # A concurrent request with the same Idempotency-Key won the race.
        raise HTTPException(409, "A request with this Idempotency-Key is already being processed") from exc
    return {"id": job["id"], **output}


@app.get("/jobs")
def list_jobs(u=Depends(current_user)):
    with connect() as c:
        return [_job_view(r, u) for r in c.execute("SELECT * FROM jobs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100", (u["tenant_id"],))]


@app.get("/jobs/{job_id}")
def get_job(job_id: str, u=Depends(current_user)):
    with connect() as c:
        row = c.execute("SELECT * FROM jobs WHERE id=? AND tenant_id=?", (job_id, u["tenant_id"])).fetchone()
    if not row:
        raise HTTPException(404, "Job not found")
    return _job_view(row, u)


@app.post("/jobs/{job_id}/answers")
async def answer_job(job_id: str, data: AnswerIn, u=Depends(role("owner", "admin", "estimator"))):
    with connect() as c:
        row = c.execute("SELECT * FROM jobs WHERE id=? AND tenant_id=?", (job_id, u["tenant_id"])).fetchone()
    if not row:
        raise HTTPException(404, "Job not found")
    if row["status"] == "ready":
        raise HTTPException(409, "This job already has a draft quote")
    job = dict(row)
    job["notes"] = f"{row['notes']}\nContractor answer: {data.answers}"
    previous = json.loads(row["result_json"] or "{}")
    if previous.get('workflow') == 'supplier':
        job['notes'] = data.answers
    try:
        execute = supplier_agents.execute if previous.get('workflow') == 'supplier' else crew_service.execute
        output = await supplier_agents.claimed_execute(connect, u, job, previous.get("policy", {}) or {}, execute)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"id": job_id, **output}


# ---------- audit ----------
@app.get('/job-progress/{progress_key}')
def job_progress(progress_key: str, u=Depends(current_user)):
    if len(progress_key) > 160:
        raise HTTPException(422, 'Invalid progress key')
    return progress.view(connect, u, progress_key)


@app.get("/audit")
def audit_events(u=Depends(role("owner", "admin"))):
    with connect() as c:
        return [dict(x) for x in c.execute("SELECT * FROM audit_log WHERE tenant_id=? ORDER BY rowid DESC LIMIT 500", (u["tenant_id"],))]


@app.get("/audit/verify")
def audit_verify(u=Depends(role("owner", "admin"))):
    with connect() as c:
        return verify_chain(c, u["tenant_id"])
