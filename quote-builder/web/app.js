"use strict";
const $ = (id) => document.getElementById(id);
const apiBaseUrl = window.QBC_CONFIG?.apiBaseUrl || '';
function apiUrl(path) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
  return apiBaseUrl + path;
}
let token = null;
let projects = [];
let quotes = [];
let priceItems = [];
let jobs = [];
let currentUser = null;
let profileDirty = false;
let pendingJob = null;

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
  if (type === 'success') setTimeout(() => { if (el.textContent === text) el.className = "notice"; }, 8000);
}

const canCreate = () => ['owner', 'admin', 'estimator'].includes(currentUser?.role);
const canManage = () => ['owner', 'admin'].includes(currentUser?.role);
const canReview = () => ['owner', 'admin', 'reviewer'].includes(currentUser?.role);
const jobLabel = status => ({ ready: 'Draft ready', needs_input: 'Needs your input', failed: 'Failed — retry' })[status] || status;
function showError(error) { if (!error.staleSession) notify($("notice"), error.message); }
function busyForm(form, label) {
  if (form.dataset.busy) return null;
  form.dataset.busy = 'true';
  form.setAttribute('aria-busy', 'true');
  const controls = [...form.querySelectorAll('button, input, select, textarea')].map(control => [control, control.disabled]);
  const button = form.querySelector('button[type="submit"]');
  const text = button.textContent;
  controls.forEach(([control]) => { control.disabled = true; });
  button.textContent = label;
  return () => {
    controls.forEach(([control, disabled]) => { control.disabled = disabled; });
    button.textContent = text;
    delete form.dataset.busy;
    form.setAttribute('aria-busy', 'false');
  };
}

async function api(path, options = {}) {
  const requestToken = token;
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.json);
  }
  const response = await fetch(apiUrl(path), { ...options, headers });
  if (requestToken !== token) throw Object.assign(new Error('Session changed.'), { staleSession: true });
  if (response.status === 401) { signOut(); throw new Error("Your session has ended. Sign in again."); }
  let data = null;
  try { data = await response.json(); } catch (_) { data = null; }
  if (requestToken !== token) throw Object.assign(new Error('Session changed.'), { staleSession: true });
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
  if (token) { fetch(apiUrl("/auth/logout"), { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {}); }
  token = null;
  currentUser = null;
  $('workspace-name').textContent = 'Construction quote desk';
  projects = []; quotes = []; priceItems = []; jobs = [];
  profileDirty = false; pendingJob = null;
  for (const id of ['job-form', 'profile-form', 'scope-form']) $(id).reset();
  for (const id of ['job-result', 'quote-body', 'quotes-table', 'projects-table', 'jobs-table', 'price-result', 'scope-project', 'scope-price']) $(id).innerHTML = '';
  delete $('job-result').dataset.jobId;
  $('price-file').value = '';
  $('job-result').classList.add('hidden');
  $('quote-detail').classList.add('hidden');
  $('notice').className = 'notice';
  $('auth-notice').className = 'notice';
  for (const id of ['project-count', 'review-count', 'approved-count']) $(id).textContent = '-';
  try { sessionStorage.removeItem("qbc_token"); } catch (_) { /* storage may be blocked */ }
  $("app-view").classList.add("hidden");
  $("auth-view").classList.remove("hidden");
  $("logout").classList.add("hidden");
}

async function loadAll() {
  const loadToken = token;
  try {
    const values = await Promise.all([api('/projects'), api('/quotes'), api('/price-items?limit=200'), api('/jobs'), api('/profile'), api('/auth/me')]);
    if (loadToken !== token) return;
    [projects, quotes, priceItems, jobs] = values;
    const profile = values[4]; currentUser = values[5];
    $('workspace-name').textContent = currentUser.tenant_id;
    if (!profileDirty) {
      for (const [id, value] of Object.entries({ 'p-license': profile.license_number || '', 'p-insurance': profile.insurance_text || '', 'p-terms': profile.payment_terms || '', 'p-rate': profile.labor_rate ?? '', 'p-days': profile.valid_until_days ?? 30 })) $(id).value = value;
    }
    $('job-form').classList.toggle('hidden', !canCreate());
    $('job-heading').textContent = canCreate() ? 'New quote' : 'Job details';
    $('job-mode-label').textContent = canCreate() ? 'Drafting' : 'View details';
    $('job-readonly-hint').classList.toggle('hidden', canCreate() || !$('job-result').classList.contains('hidden'));
    $('welcome-description').textContent = canCreate() ? 'Create a draft or pick up a job that needs review.' : 'Review quotes and resolve the details before approval.';
    $('settings-description').textContent = canManage() ? 'Contractor details, price lists, and scope' : canCreate() ? 'Contractor details and project scope' : 'Contractor details';
    $('scope-form').closest('section').classList.toggle('hidden', !canCreate());
    $('price-upload').closest('section').classList.toggle('hidden', !canManage());
    $('profile-form').querySelectorAll('input, button').forEach(control => { control.disabled = !canManage(); });
    render();
  } catch (err) {
    showError(err);
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
  $('jobs-table').innerHTML = jobs.length ? jobs.map(job => `<tr><td>${esc(job.project_name)}</td><td>${esc(jobLabel(job.status))}</td><td><button class="btn secondary" data-open-job="${esc(job.id)}">Open job</button></td></tr>`).join('')
    : '<tr><td colspan="3" class="empty">No saved jobs yet.</td></tr>';
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
    const response = await fetch(apiUrl("/auth/login"), {
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
$('settings-link').addEventListener('click', () => { $('workspace-settings').open = true; });
$("refresh").addEventListener("click", loadAll);
$("scope-search").addEventListener("input", renderPriceOptions);
$('profile-form').addEventListener('input', () => { profileDirty = true; });
function updateJobHint() {
  const supplier = $("job-workflow").value === 'supplier';
  $('job-notes-label').textContent = supplier ? 'Materials list' : 'Job description';
  $('workflow-help').textContent = supplier
    ? 'One material per line. Prices and availability are checked against your supplier account. Labor is excluded.'
    : 'Estimate materials and labor from the job notes using your uploaded price list.';
  $("job-notes").placeholder = supplier
    ? '10 of 2x4x8 SPF studs\n2 sheets of 4x8 half-inch drywall'
    : 'Replace 40 ft of 3/4in copper pipe, 2 shutoff valves, Friday install';
}
$("job-workflow").addEventListener('change', updateJobHint);
updateJobHint();

// ---------- job from notes ----------
function renderJob(job) {
  $('job-readonly-hint').classList.add('hidden');
  const panel = $("job-result");
  const lines = [];
  lines.push(`<p><span class="status ${job.status === "ready" ? "ok" : "warn"}">${esc(jobLabel(job.status))}</span>
    ${job.failed_half ? `<span class="small">Step that failed: ${esc(job.failed_half)}</span>` : ""}</p>`);
  if (job.questions && job.questions.length) {
    lines.push(`<p><strong>Questions for you</strong></p><ul>${job.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>`);
  }
  if (job.missing && job.missing.length) {
    lines.push(`<p class="small">Not priced: ${job.missing.map((m) => esc(m.name)).join(", ")}</p>`);
  }
  if (job.agents) {
    const supplier = job.agents.supplier;
    if (supplier && supplier.data) {
      lines.push(`<p><strong>Supplier desk</strong> · ${esc(supplier.data.branch)} ${supplier.data.sample_data ? '<span class="status warn">SAMPLE DATA</span>' : ''}</p>`);
      lines.push(`<ul>${supplier.data.lines.map(line => `<li>${esc(line.quantity)} ${esc(line.unit)} ${esc(line.item)}${line.unresolved_quantity ? ` — ${esc(line.unresolved_quantity)} unresolved` : ''}</li>`).join('')}</ul>`);
    }
    for (const result of job.agents.research || []) {
      lines.push(`<p><strong>Specification research</strong>: ${esc(result.data?.answer || 'Evidence could not be verified; rep review is required.')}</p>`);
      for (const source of result.data?.sources || []) {
        let url; try { url = new URL(source.url); } catch (_) { continue; }
        if (url.protocol === 'https:') lines.push(`<p class="small"><a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">Source</a>: ${esc(source.quoted_text)}</p>`);
      }
    }
  }
  if (job.quote) {
    lines.push(`<p>Draft total <span class="amount">${money(job.quote.costs.total)}</span>
      ${job.quote.review_required ? '<span class="status warn">review before sending</span>' : ""}</p>
      <details class="record-details"><summary>Quote record</summary><p class="mono">Revision ID: ${esc(job.quote.snapshot_hash)}</p></details>
      <button class="btn primary" data-open="${esc(job.quote.id)}">Open for review</button>`);
  }
  if (job.status !== "ready" && canCreate()) {
    lines.push(`<form id="answer-form" class="quote-lines">
      <div class="field"><label for="answer-text">${job.workflow === 'supplier' ? 'Corrected complete materials list (replaces the previous list)' : 'Answer the questions'}</label><textarea id="answer-text" rows="3" maxlength="2000" required></textarea></div>
      <button class="btn primary full" type="submit">Send answer and re-run</button></form>`);
    panel.dataset.jobId = job.id;
  }
  panel.innerHTML = lines.join("");
  panel.classList.remove("hidden");
}

$("job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const restore = busyForm(event.target, 'Creating draft…');
  if (!restore) return;
  try {
    const input = {
      workflow: $('job-workflow').value, notes: $('job-notes').value,
      project_name: $('job-project').value, customer_name: $('job-customer').value || null,
      overhead_pct: Number($('job-overhead').value) / 100, markup_pct: Number($('job-markup').value) / 100,
    };
    const signature = JSON.stringify([token, input]);
    if (pendingJob?.signature !== signature) pendingJob = { signature, key: newIdempotencyKey() };
    const job = await api("/jobs", {
      method: "POST",
      headers: { "Idempotency-Key": pendingJob.key }, json: input,
    });
    pendingJob = null;
    renderJob(job);
    await loadAll();
    notify($("notice"), job.status === "ready" ? "Draft quote created for review." : job.status === 'failed' ? 'An agent could not finish. Review the job details and retry.' : "Review the questions below before drafting.", job.status === "ready" ? "success" : "error");
    $('job-result').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    showError(err);
  } finally { restore(); }
});

$("job-result").addEventListener("submit", async (event) => {
  if (event.target.id !== "answer-form") return;
  event.preventDefault();
  const restore = busyForm(event.target, 'Updating job…');
  if (!restore) return;
  try {
    const jobId = $("job-result").dataset.jobId;
    const answers = $("answer-text").value;
    const job = await api(`/jobs/${encodeURIComponent(jobId)}/answers`, { method: "POST", json: { answers } });
    if (job.workflow === 'supplier') $('job-notes').value = answers;
    renderJob(job);
    await loadAll();
  } catch (err) {
    showError(err);
  } finally { restore(); }
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
  const reviewable = q.status === 'draft' && canReview() && q.created_by !== currentUser?.id && data.snapshot_verified;
  $("quote-body").innerHTML = `
    <p><strong>${esc(projectName(q.project_id))}</strong> · version ${esc(q.version)} ·
      <span class="status ${q.status === "approved" ? "ok" : "warn"}">${esc(q.status)}</span>
      ${data.snapshot_verified ? '<span class="status ok">revision checked</span>' : '<span class="status warn">revision could not be verified</span>'}</p>
    ${warnings ? `<ul class="small">${warnings}</ul>` : ""}
    <div class="quote-lines"><ul>${rows}</ul>
      ${text.total_text ? `<p>${esc(text.total_text)}</p>` : ""}
      ${snap.costs ? `<p class="small">Subtotal ${money(snap.costs.subtotal)} · Tax ${money(snap.costs.tax)} · Total <span class="amount">${money(snap.costs.total)}</span></p>` : ""}
      ${text.assumptions && text.assumptions.length ? `<p class="small">Assumptions: ${text.assumptions.map(esc).join("; ")}</p>` : ""}
      ${text.exclusions && text.exclusions.length ? `<p class="small">Exclusions: ${text.exclusions.map(esc).join("; ")}</p>` : ""}
    </div>
    <details class="record-details"><summary>Quote record</summary><p class="mono">Revision ID: ${esc(q.snapshot_hash)}</p></details>
    ${reviewable ? `<div class="actions">
      <button class="btn primary" data-approve="${esc(q.id)}" data-hash="${esc(q.snapshot_hash)}">Approve this revision</button>
      <form id="reject-form"><div class="field"><label for="reject-reason">Reason for rejecting (3+ characters)</label>
        <input id="reject-reason" required minlength="3" maxlength="2000"></div>
        <button class="btn danger" type="submit" data-reject="${esc(q.id)}">Reject draft</button></form></div>` : ""}
    ${q.status === 'draft' && q.created_by === currentUser?.id ? '<p class="small">A different authorized reviewer must approve this draft.</p>' : ''}
    ${q.status === "approved" && data.snapshot_verified ? `<button class="btn secondary" data-pdf="${esc(q.id)}">Download approved PDF</button>` : ""}
  `;
  $("quote-detail").classList.remove("hidden");
  $("quote-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.dataset.openJob) {
      const job = await api(`/jobs/${encodeURIComponent(target.dataset.openJob)}`);
      $('job-workflow').value = job.workflow || 'crew';
      $('job-notes').value = job.notes || '';
      $('job-project').value = job.project_name;
      $('job-customer').value = job.customer_name || '';
      $('job-overhead').value = Number(job.policy?.overhead_pct || 0) * 100;
      $('job-markup').value = Number(job.policy?.markup_pct || 0) * 100;
      updateJobHint(); renderJob(job);
      $('job-result').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (target.dataset.open) return await openQuote(target.dataset.open);
    if (target.dataset.approve) {
      await api(`/quotes/${encodeURIComponent(target.dataset.approve)}/approve`, { method: "POST", json: { snapshot_hash: target.dataset.hash } });
      notify($("notice"), "Quote approved. You can now download the PDF.", "success");
      await loadAll();
      return openQuote(target.dataset.approve);
    }
    if (target.dataset.pdf) {
      const response = await fetch(apiUrl(`/quotes/${encodeURIComponent(target.dataset.pdf)}/pdf`), { headers: { Authorization: `Bearer ${token}` } });
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
    const response = await fetch(apiUrl("/price-lists"), { method: "POST", headers: { "Content-Type": "text/csv", Authorization: `Bearer ${token}` }, body });
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
    profileDirty = false;
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
