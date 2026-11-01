"use strict";
const $ = (id) => document.getElementById(id);
let token = null;
let projects = [];
let quotes = [];
let priceItems = [];

try { token = sessionStorage.getItem("qbc_token"); } catch (_) { token = null; }

function newIdempotencyKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function money(value) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(value || 0));
}
function notify(el, text, type = "error") {
  el.textContent = text;
  el.className = "notice " + type;
  setTimeout(() => { if (el.textContent === text) el.className = "notice"; }, 6000);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.json);
  }
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) { signOut(); throw new Error("Your session has ended. Sign in again."); }
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  if (!response.ok) {
    const detail = data && data.detail;
    const message = typeof detail === "string" ? detail : (detail && detail.message) || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

function showApp() {
  $("auth-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("logout").classList.remove("hidden");
  loadAll();
}
function signOut() {
  if (token) { fetch("/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {}); }
  token = null;
  try { sessionStorage.removeItem("qbc_token"); } catch (_) { /* storage may be blocked */ }
  $("app-view").classList.add("hidden");
  $("auth-view").classList.remove("hidden");
  $("logout").classList.add("hidden");
}

async function loadAll() {
  try {
    [projects, quotes, priceItems] = await Promise.all([api("/projects"), api("/quotes"), api("/price-items?limit=200")]);
    render();
  } catch (err) {
    notify($("notice"), err.message);
  }
}

function projectName(id) {
  const p = projects.find((x) => x.id === id);
  return p ? p.name : "Project";
}

function render() {
  $("project-count").textContent = projects.length;
  $("review-count").textContent = quotes.filter((q) => q.status === "draft").length;
  $("approved-count").textContent = quotes.filter((q) => q.status === "approved").length;
  $("quotes-table").innerHTML = quotes.length
    ? quotes.map((q) => `<tr><td>${esc(projectName(q.project_id))} <span class="small">v${esc(q.version)}</span></td>
        <td class="amount">${money(q.total)}</td>
        <td><span class="status ${q.status === "approved" ? "ok" : q.status === "draft" ? "warn" : ""}">${esc(q.status)}</span></td>
        <td><button class="btn secondary" data-open="${esc(q.id)}">Open</button></td></tr>`).join("")
    : '<tr><td colspan="4" class="empty">No quotes yet. Create a job to draft one.</td></tr>';
  $("projects-table").innerHTML = projects.length
    ? projects.map((p) => `<tr><td>${esc(p.name)}</td><td class="small">${esc(p.created_at)}</td></tr>`).join("")
    : '<tr><td colspan="2" class="empty">No projects yet.</td></tr>';
  const options = projects.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  $("scope-project").innerHTML = options || '<option value="">Create a project first</option>';
  renderPriceOptions();
}

function renderPriceOptions() {
  const query = $("scope-search").value.trim().toLowerCase();
  const matches = priceItems.filter((p) => !query || p.name.toLowerCase().includes(query)).slice(0, 100);
  $("scope-price").innerHTML = matches.length
    ? matches.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.unit)}, ${money(p.unit_price)})</option>`).join("")
    : '<option value="">No price items. Upload a price list.</option>';
}

// ---------- sign in ----------
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const response = await fetch("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_id: $("tenant").value, email: $("email").value, password: $("password").value }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Sign-in failed");
    token = data.access_token;
    try { sessionStorage.setItem("qbc_token", token); } catch (_) { /* storage may be blocked */ }
    $("password").value = "";
    showApp();
  } catch (err) {
    notify($("auth-notice"), err.message);
  } finally {
    button.disabled = false;
  }
});
$("logout").addEventListener("click", signOut);
$("refresh").addEventListener("click", loadAll);
$("scope-search").addEventListener("input", renderPriceOptions);

// ---------- job from notes ----------
function renderJob(job) {
  const panel = $("job-result");
  const lines = [];
  lines.push(`<p><span class="status ${job.status === "ready" ? "ok" : "warn"}">${esc(job.status)}</span>
    ${job.failed_half ? `<span class="small">half that failed: ${esc(job.failed_half)}</span>` : ""}</p>`);
  if (job.questions && job.questions.length) {
    lines.push(`<p><strong>Questions for you</strong></p><ul>${job.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>`);
  }
  if (job.missing && job.missing.length) {
    lines.push(`<p class="small">Not priced: ${job.missing.map((m) => esc(m.name)).join(", ")}</p>`);
  }
  if (job.quote) {
    lines.push(`<p>Draft total <span class="amount">${money(job.quote.costs.total)}</span>
      ${job.quote.review_required ? '<span class="status warn">review before sending</span>' : ""}</p>
      <p class="mono">snapshot ${esc(job.quote.snapshot_hash)}</p>
      <button class="btn primary" data-open="${esc(job.quote.id)}">Open for review</button>`);
  }
  if (job.status !== "ready") {
    lines.push(`<form id="answer-form" class="quote-lines">
      <div class="field"><label for="answer-text">Answer the questions</label><textarea id="answer-text" rows="3" maxlength="2000" required></textarea></div>
      <button class="btn primary full" type="submit">Send answer and re-run</button></form>`);
    panel.dataset.jobId = job.id;
  }
  panel.innerHTML = lines.join("");
  panel.classList.remove("hidden");
}

$("job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const job = await api("/jobs", {
      method: "POST",
      headers: { "Idempotency-Key": newIdempotencyKey() },
      json: {
        notes: $("job-notes").value, project_name: $("job-project").value, customer_name: $("job-customer").value || null,
        overhead_pct: Number($("job-overhead").value) / 100, markup_pct: Number($("job-markup").value) / 100,
      },
    });
    renderJob(job);
    await loadAll();
    notify($("notice"), job.status === "ready" ? "Draft quote created for review." : "The crew needs answers before it can draft a quote.", job.status === "ready" ? "success" : "error");
  } catch (err) {
    notify($("notice"), err.message);
  }
});

$("job-result").addEventListener("submit", async (event) => {
  if (event.target.id !== "answer-form") return;
  event.preventDefault();
  try {
    const jobId = $("job-result").dataset.jobId;
    const job = await api(`/jobs/${encodeURIComponent(jobId)}/answers`, { method: "POST", json: { answers: $("answer-text").value } });
    renderJob(job);
    await loadAll();
  } catch (err) {
    notify($("notice"), err.message);
  }
});

// ---------- quote review ----------
async function openQuote(id) {
  const data = await api(`/quotes/${encodeURIComponent(id)}`);
  const q = data.quote;
  const snap = data.snapshot || {};
  const text = snap.customer_text || {};
  const rows = text.lines_text ? text.lines_text.map((l) => `<li>${esc(l)}</li>`).join("")
    : (snap.lines || []).map((l) => `<li>${esc(l.description)}: ${money(l.line_total)} direct cost</li>`).join("");
  const warnings = (snap.warnings || []).map((w) => `<li>${esc(w)}</li>`).join("");
  const reviewable = q.status === "draft";
  $("quote-body").innerHTML = `
    <p><strong>${esc(projectName(q.project_id))}</strong> · version ${esc(q.version)} ·
      <span class="status ${q.status === "approved" ? "ok" : "warn"}">${esc(q.status)}</span>
      ${data.snapshot_verified ? '<span class="status ok">snapshot verified</span>' : '<span class="status warn">snapshot NOT verified</span>'}</p>
    ${warnings ? `<ul class="small">${warnings}</ul>` : ""}
    <div class="quote-lines"><ul>${rows}</ul>
      ${text.total_text ? `<p>${esc(text.total_text)}</p>` : ""}
      ${snap.costs ? `<p class="small">Subtotal ${money(snap.costs.subtotal)} · Tax ${money(snap.costs.tax)} · Total <span class="amount">${money(snap.costs.total)}</span></p>` : ""}
      ${text.assumptions && text.assumptions.length ? `<p class="small">Assumptions: ${text.assumptions.map(esc).join("; ")}</p>` : ""}
      ${text.exclusions && text.exclusions.length ? `<p class="small">Exclusions: ${text.exclusions.map(esc).join("; ")}</p>` : ""}
    </div>
    <p class="mono">snapshot ${esc(q.snapshot_hash)}</p>
    ${reviewable ? `<div class="actions">
      <button class="btn primary" data-approve="${esc(q.id)}" data-hash="${esc(q.snapshot_hash)}">Approve this exact snapshot</button>
      <form id="reject-form"><div class="field"><label for="reject-reason">Reason for rejecting (3+ characters)</label>
        <input id="reject-reason" required minlength="3" maxlength="2000"></div>
        <button class="btn danger" type="submit" data-reject="${esc(q.id)}">Reject draft</button></form></div>` : ""}
    ${q.status === "approved" ? `<button class="btn secondary" data-pdf="${esc(q.id)}">Download approved PDF</button>` : ""}
  `;
  $("quote-detail").classList.remove("hidden");
  $("quote-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.dataset.open) return await openQuote(target.dataset.open);
    if (target.dataset.approve) {
      await api(`/quotes/${encodeURIComponent(target.dataset.approve)}/approve`, { method: "POST", json: { snapshot_hash: target.dataset.hash } });
      notify($("notice"), "Quote approved. You can now download the PDF.", "success");
      await loadAll();
      return openQuote(target.dataset.approve);
    }
    if (target.dataset.pdf) {
      const response = await fetch(`/quotes/${encodeURIComponent(target.dataset.pdf)}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("PDF export was refused. Check that the snapshot is verified.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "quote.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (err) {
    notify($("notice"), err.message);
  }
});

$("quote-body").addEventListener("submit", async (event) => {
  if (event.target.id !== "reject-form") return;
  event.preventDefault();
  const id = event.target.querySelector("button[data-reject]").dataset.reject;
  try {
    await api(`/quotes/${encodeURIComponent(id)}/reject`, { method: "POST", json: { reason: $("reject-reason").value } });
    notify($("notice"), "Draft rejected. The reason is recorded in the audit log.", "success");
    await loadAll();
    $("quote-detail").classList.add("hidden");
  } catch (err) {
    notify($("notice"), err.message);
  }
});

// ---------- price list, profile, scope ----------
$("price-upload").addEventListener("click", async () => {
  const file = $("price-file").files[0];
  if (!file) { notify($("notice"), "Choose a CSV file first."); return; }
  try {
    const body = await file.text();
    const response = await fetch("/price-lists", { method: "POST", headers: { "Content-Type": "text/csv", Authorization: `Bearer ${token}` }, body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : (data.detail && data.detail.message) || "Upload failed");
    $("price-result").textContent = `Accepted ${data.accepted} rows. Rejected ${data.rejected.length}.`;
    priceItems = await api("/price-items?limit=200");
    renderPriceOptions();
  } catch (err) {
    notify($("notice"), err.message);
  }
});

$("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/profile", {
      method: "PUT",
      json: {
        license_number: $("p-license").value || null, insurance_text: $("p-insurance").value || null,
        payment_terms: $("p-terms").value || null, labor_rate: Number($("p-rate").value), valid_until_days: Number($("p-days").value),
      },
    });
    notify($("notice"), "Profile saved.", "success");
  } catch (err) {
    notify($("notice"), err.message);
  }
});

$("scope-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api(`/projects/${encodeURIComponent($("scope-project").value)}/scopes`, {
      method: "POST",
      json: {
        description: $("scope-description").value, quantity: Number($("scope-qty").value),
        unit: (priceItems.find((p) => p.id === $("scope-price").value) || {}).unit || "ea",
        labor_hours_per_unit: Number($("scope-hours").value), waste_pct: Number($("scope-waste").value) / 100,
        source_type: "price_item", source_id: $("scope-price").value,
      },
    });
    notify($("notice"), "Scope added to project.", "success");
    event.target.reset();
    renderPriceOptions();
  } catch (err) {
    notify($("notice"), err.message);
  }
});

// Start: a stored session is checked by the first API call; a stale one signs the user out.
if (token) showApp();
