/* ── Confirm modal ───────────────────────────────────────── */
function showConfirm(message, okLabel = "Delete") {
  return new Promise(resolve => {
    const modal = document.getElementById("confirm-modal");
    document.getElementById("confirm-modal-msg").textContent = message;
    document.getElementById("confirm-modal-ok").textContent = okLabel;
    modal.showModal();
    const ok = document.getElementById("confirm-modal-ok");
    const cancel = document.getElementById("confirm-modal-cancel");
    function cleanup(result) {
      modal.close();
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
  });
}

/* ── Settings "back" button ──────────────────────────────── */
// Clicking a sidebar anchor (#extension, #api-key, ...) pushes its own history
// entry, so a plain history.back() only un-does the last hash jump instead of
// leaving the settings page. Count hash hops made since arriving here and skip
// over all of them in one go.
let _settingsHashHops = 0;
if (location.pathname === "/settings") {
  window.addEventListener("hashchange", () => { _settingsHashHops++; });
}
function settingsGoBack(ev) {
  ev.preventDefault();
  history.go(-(_settingsHashHops + 1));
  _settingsHashHops = 0;
}

const savedSidebarWidth = localStorage.getItem("sidebarWidth");
if (savedSidebarWidth) {
  document.documentElement.style.setProperty("--sidebar-w", `${savedSidebarWidth}px`);
}

/* ── Sidebar resize ──────────────────────────────────────── */
function initSidebarResize() {
  const handle = document.getElementById("sidebar-resize-handle");
  if (!handle) return;
  const MIN_WIDTH = 220;
  const MAX_WIDTH = 500;

  handle.addEventListener("mousedown", e => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = document.querySelector(".sidebar").offsetWidth;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMouseMove(ev) {
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (ev.clientX - startX)));
      document.documentElement.style.setProperty("--sidebar-w", `${width}px`);
    }
    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("sidebarWidth", document.querySelector(".sidebar").offsetWidth);
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

/* global state */
let currentView = localStorage.getItem("view") || "cards";
let currentTag = null;
let currentUnread = null;
let currentRead = null;
let currentUncat = null;
let searchTimeout = null;

const UUID_HEADER = () => {
  // read from a meta tag injected by the server (we'll add it on the home page)
  const m = document.querySelector('meta[name="tether-uuid"]');
  return m ? m.content : "";
};

function headers() {
  return { "X-Tether-UUID": UUID_HEADER(), "Content-Type": "application/json" };
}

/* ── Toast ───────────────────────────────────────────────── */
function toast(msg, duration = 2200) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

/* ── View toggle ─────────────────────────────────────────── */
function setView(v) {
  currentView = v;
  localStorage.setItem("view", v);
  document.getElementById("btn-cards")?.classList.toggle("active", v === "cards");
  document.getElementById("btn-table")?.classList.toggle("active", v === "table");
  renderCurrentLinks();
}

/* ── Fetch links ─────────────────────────────────────────── */
async function fetchLinks(tag, unread, read, uncat, query) {
  let url;
  if (query) {
    url = `/api/links/search?q=${encodeURIComponent(query)}`;
  } else {
    url = "/api/links";
    const params = new URLSearchParams();
    if (tag) params.set("tag", tag);
    if (unread) params.set("unread", "true");
    if (read) params.set("read", "true");
    if (uncat) params.set("uncategorised", "true");
    if (params.size) url += "?" + params.toString();
  }
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return [];
  return res.json();
}

let _cachedLinks = [];

async function loadLinks() {
  const query = document.getElementById("search-input")?.value.trim();
  _cachedLinks = await fetchLinks(currentTag, currentUnread, currentRead, currentUncat, query);
  renderCurrentLinks();
}

function renderCurrentLinks() {
  if (currentView === "table") {
    renderTable(_cachedLinks);
  } else {
    renderCards(_cachedLinks);
  }
}

async function updateCounts() {
  const counts = document.getElementById("link-counts");
  if (!counts) return;
  try {
    const all = await fetchLinks(currentTag, null, null, currentUncat, null);
    const unread = all.filter(l => !l.is_read).length;
    counts.textContent = `${unread} unread · ${all.length} total`;
  } catch {}
}

/* ── Render helpers ──────────────────────────────────────── */
function tagPills(tags) {
  return tags.map(t =>
    `<span class="tag-pill" style="background:color-mix(in srgb,${t.color} 18%,transparent);color:${t.color}">${escHtml(t.name)}</span>`
  ).join("");
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function friendlyDate(iso) {
  const d = new Date(iso + "Z");
  const now = new Date();
  const diff = now - d;
  if (diff < 60000)  return "just now";
  if (diff < 3600000) return Math.floor(diff/60000) + "m ago";
  if (diff < 86400000) return Math.floor(diff/3600000) + "h ago";
  if (diff < 604800000) return Math.floor(diff/86400000) + "d ago";
  return d.toLocaleDateString();
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function renderCards(links) {
  const container = document.getElementById("links-container");
  const table = document.getElementById("links-table");
  if (!container) return;
  container.classList.remove("hidden");
  container.className = "cards-view";
  table?.classList.add("hidden");

  if (!links.length) {
    container.innerHTML = '<div class="empty-state">No links yet. Send some from your iPhone!</div>';
    return;
  }

  container.innerHTML = links.map(link => `
    <article class="link-card ${link.is_read ? "is-read" : ""}" data-id="${link.id}">
      <div class="card-header">
        ${link.favicon_url ? `<img class="favicon" src="${escHtml(link.favicon_url)}" alt="" onerror="this.style.display='none'">` : ""}
        <a class="card-title" href="${escHtml(link.url)}" target="_blank" rel="noopener">
          ${escHtml(link.title || getDomain(link.url))}
        </a>
        <button class="icon-btn read-btn ${link.is_read ? "is-read" : ""}" title="${link.is_read ? "Mark unread" : "Mark as read"}" onclick="toggleRead('${link.id}', ${!link.is_read})">
          <i data-lucide="${link.is_read ? "check" : "eye"}"></i>
        </button>
        <button class="icon-btn note-btn ${link.note_id ? "has-note" : ""}" title="${link.note_id ? "Open note" : "Add note"}" onclick="openNoteForLink('${link.id}', ${link.note_id ? `'${link.note_id}'` : "null"})">
          <i data-lucide="file-text"></i>
        </button>
        <button class="icon-btn edit-btn" title="Edit" onclick="editLink('${link.id}')">
          <i data-lucide="square-pen"></i>
        </button>
        <button class="icon-btn delete-btn" title="Delete" onclick="deleteLink('${link.id}')">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
      ${link.description ? `<p class="card-desc">${escHtml(link.description)}</p>` : ""}
      <div class="card-footer">
        <span class="card-url">${escHtml(getDomain(link.url))}</span>
        <span class="card-date">${friendlyDate(link.created_at)}</span>
        <div class="card-tags">${tagPills(link.tags)}</div>
      </div>
    </article>
  `).join("");
  lucide.createIcons();
}

function renderTable(links) {
  const container = document.getElementById("links-container");
  const table = document.getElementById("links-table");
  if (!table) return;
  container?.classList.add("hidden");
  table.classList.remove("hidden");

  const tbody = table.querySelector("tbody");
  if (!links.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:3rem;color:var(--subtext)">No links yet.</td></tr>';
    return;
  }

  tbody.innerHTML = links.map(link => `
    <tr data-id="${link.id}" class="${link.is_read ? "is-read" : ""}">
      <td class="row-favicon">
        ${link.favicon_url ? `<img class="favicon" src="${escHtml(link.favicon_url)}" alt="" onerror="this.style.display='none'">` : ""}
      </td>
      <td class="row-title">
        <a href="${escHtml(link.url)}" target="_blank" rel="noopener">${escHtml(link.title || getDomain(link.url))}</a>
        <br><small>${escHtml(getDomain(link.url))}</small>
      </td>
      <td class="row-tags">${tagPills(link.tags)}</td>
      <td class="row-date">${friendlyDate(link.created_at)}</td>
      <td class="row-actions">
        <button class="row-read-btn ${link.is_read ? "is-read" : ""}" title="${link.is_read ? "Mark unread" : "Mark as read"}" onclick="toggleRead('${link.id}', ${!link.is_read})">
          <i data-lucide="${link.is_read ? "check" : "eye"}"></i>
        </button>
        <button class="row-icon-btn ${link.note_id ? "has-note" : ""}" title="${link.note_id ? "Open note" : "Add note"}" onclick="openNoteForLink('${link.id}', ${link.note_id ? `'${link.note_id}'` : "null"})">
          <i data-lucide="file-text"></i>
        </button>
        <button class="row-icon-btn" title="Edit" onclick="editLink('${link.id}')">
          <i data-lucide="square-pen"></i>
        </button>
        <button class="row-icon-btn danger" title="Delete" onclick="deleteLink('${link.id}')">
          <i data-lucide="trash-2"></i>
        </button>
      </td>
    </tr>
  `).join("");
  lucide.createIcons();
}

/* ── Row overflow menu ───────────────────────────────────── */
function closeRowMenus() {
  document.querySelectorAll(".row-menu.open").forEach(m => m.classList.remove("open"));
}
function toggleRowMenu(btn) {
  const menu = btn.nextElementSibling;
  const isOpen = menu.classList.contains("open");
  closeRowMenus();
  if (!isOpen) menu.classList.add("open");
}
document.addEventListener("click", e => {
  if (!e.target.closest(".row-menu-wrap")) closeRowMenus();
});

/* ── Actions ─────────────────────────────────────────────── */
async function toggleRead(id, isRead) {
  await fetch(`/api/links/${id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ is_read: isRead }),
  });
  await loadLinks();
  loadSidebarCats();
  updateCounts();
  toast(isRead ? "Marked as read" : "Marked as unread");
}

async function confirmMarkAll(isRead) {
  const label = isRead ? "Mark all as read" : "Mark all as unread";
  const msg = isRead
    ? "Mark all visible links as read?"
    : "Mark all visible links as unread?";
  if (!await showConfirm(msg, label)) return;
  const body = {};
  if (currentTag) body.tag = parseInt(currentTag);
  if (currentUncat) body.uncategorised = true;
  body.is_read = isRead;
  await fetch("/api/links/mark-all", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  await Promise.all([loadLinks(), loadSidebarCats(), updateCounts()]);
  toast(isRead ? "Marked all as read" : "Marked all as unread");
}

async function deleteLink(id) {
  if (!await showConfirm("Delete this link? This can't be undone.")) return;
  await fetch(`/api/links/${id}`, { method: "DELETE", headers: headers() });
  await Promise.all([loadLinks(), loadSidebarCats(), updateCounts()]);
  toast("Link deleted");
}

/* ── Filter chips ────────────────────────────────────────── */
function initFilters() {
  document.querySelectorAll(".filter-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      currentUnread = chip.dataset.unread ? true : null;
      currentRead = chip.dataset.read ? true : null;
      loadLinks();
      updateCounts();
    });
  });
}

/* ── Search ──────────────────────────────────────────────── */
function initSearch() {
  const input = document.getElementById("search-input");
  if (!input) return;
  input.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadLinks, 300);
  });
}

/* ── Categories page ─────────────────────────────────────── */
function openNewTagModal() {
  document.getElementById("new-tag-modal")?.showModal();
  setTimeout(() => document.getElementById("new-tag-name")?.focus(), 50);
}

function openEditTag(id, name, color) {
  document.getElementById("edit-tag-id").value = id;
  document.getElementById("edit-tag-name").value = name;
  document.getElementById("edit-tag-color").value = color;
  document.getElementById("edit-tag-modal").showModal();
  setTimeout(() => document.getElementById("edit-tag-name")?.focus(), 50);
}

async function saveTag(e) {
  e.preventDefault();
  const id = document.getElementById("edit-tag-id").value;
  const name = document.getElementById("edit-tag-name").value.trim();
  const color = document.getElementById("edit-tag-color").value;
  if (!name) return;
  const res = await fetch(`/api/tags/${id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ name, color }),
  });
  if (res.ok) {
    toast("Tag updated");
    setTimeout(() => location.reload(), 400);
  }
}

async function createTag(e) {
  e.preventDefault();
  const name = document.getElementById("new-tag-name").value.trim();
  const color = document.getElementById("new-tag-color").value;
  if (!name) return;
  const res = await fetch("/api/tags", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name, color }),
  });
  if (res.ok) {
    toast("Tag Created");
    setTimeout(() => location.reload(), 500);
  }
}

let _tagDeleteId = null;

async function openTagDeleteModal(id, name) {
  _tagDeleteId = id;
  document.getElementById("tag-delete-title").textContent = "Delete tag";
  document.getElementById("tag-delete-msg").textContent =
    `Deleting tag "${name}" is permanent, what would you like to do with the Links and Notes:`;
  const select = document.getElementById("tag-delete-select");
  const res = await fetch("/api/tags", { headers: headers() });
  const tags = res.ok ? await res.json() : [];
  const moveOptions = `<option value="">Untagged</option>` + tags
    .filter(t => t.id !== id)
    .map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join("");
  select.innerHTML = `<option value="purge">Delete as well</option>`
    + `<optgroup label="Move to:">${moveOptions}</optgroup>`;
  document.getElementById("tag-delete-modal").showModal();
}

async function confirmTagDelete() {
  const id = _tagDeleteId;
  const value = document.getElementById("tag-delete-select").value;
  if (value === "purge") {
    if (!await showConfirm("This permanently deletes every link and note in this category. This can't be undone.", "Delete everything")) return;
    await fetch(`/api/tags/${id}/purge`, { method: "DELETE", headers: headers() });
  } else {
    await fetch(`/api/tags/${id}/reassign`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ to_tag_id: value ? Number(value) : null }),
    });
  }
  document.getElementById("tag-delete-modal").close();
  toast("Tag deleted");
  setTimeout(() => location.reload(), 400);
}

let _refreshPollTimer = null;

function showRefreshToast(text) {
  const el = document.getElementById("refresh-progress-toast");
  document.getElementById("refresh-toast-text").textContent = text;
  el.style.display = "flex";
  lucide.createIcons();
}

function hideRefreshToast() {
  document.getElementById("refresh-progress-toast").style.display = "none";
  clearInterval(_refreshPollTimer);
  _refreshPollTimer = null;
}

function startRefreshPolling() {
  if (_refreshPollTimer) return;
  _refreshPollTimer = setInterval(async () => {
    try {
      const s = await fetch("/api/links/refresh-all/status", { headers: headers() }).then(r => r.json());
      if (s.running) {
        showRefreshToast(`Refreshing metadata… ${s.done} / ${s.total}`);
      } else {
        hideRefreshToast();
        if (s.done > 0) toast(`Metadata refreshed for ${s.done} links`);
      }
    } catch {
      hideRefreshToast();
    }
  }, 2000);
}

async function startBulkRefresh(btn) {
  btn.disabled = true;
  await fetch("/api/links/refresh-all", { method: "POST", headers: headers() });
  btn.disabled = false;
  showRefreshToast("Starting metadata refresh…");
  startRefreshPolling();
}

// On every page load, resume the toast if a refresh is already running
(async () => {
  try {
    const s = await fetch("/api/links/refresh-all/status", { headers: headers() }).then(r => r.json());
    if (s.running) {
      showRefreshToast(`Refreshing metadata… ${s.done} / ${s.total}`);
      startRefreshPolling();
    }
  } catch { /* ignore */ }
})();

/* ── Link cleanup ────────────────────────────────────────── */
function stepCleanupValue(delta) {
  const input = document.getElementById("cleanup-value");
  input.value = Math.max(1, (parseInt(input.value, 10) || 1) + delta);
}

async function cleanupOldLinks() {
  const value = parseInt(document.getElementById("cleanup-value").value, 10);
  const unit = document.getElementById("cleanup-unit").value;
  if (!value || value < 1) { toast("Enter a number greater than 0"); return; }

  const qs = `value=${value}&unit=${unit}`;
  const previewRes = await fetch(`/api/links/cleanup-preview?${qs}`, { headers: headers() });
  const { count } = previewRes.ok ? await previewRes.json() : { count: 0 };
  if (!count) { toast("No links older than that"); return; }

  const label = `${value} ${value === 1 ? unit.slice(0, -1) : unit}`;
  if (!await showConfirm(`Delete ${count} link${count !== 1 ? "s" : ""} older than ${label}? This can't be undone.`, "Delete")) return;

  const res = await fetch(`/api/links/cleanup?${qs}`, { method: "DELETE", headers: headers() });
  if (res.ok) {
    const { deleted } = await res.json();
    toast(`Deleted ${deleted} link${deleted !== 1 ? "s" : ""}`);
    loadLinks();
    loadSidebarCats();
    updateCounts();
  }
}

/* ── Settings page ───────────────────────────────────────── */
async function loadErrorLog() {
  const wrap = document.getElementById("error-log-entries");
  const empty = document.getElementById("error-log-empty");
  if (!wrap) return;
  const errors = await fetch("/api/errors", { headers: headers() }).then(r => r.json());
  if (!errors.length) { wrap.style.display = "none"; empty.style.display = ""; return; }
  empty.style.display = "none";
  wrap.style.display = "flex";
  wrap.innerHTML = errors.map(e => `
    <div class="error-entry">
      <span class="error-entry-ts">${e.ts.replace("T", " ").replace("+00:00", " UTC")}</span>
      <span class="error-entry-type">${e.error}</span>
      <span class="error-entry-source">${e.source}</span>
      <span class="error-entry-detail">${e.detail}</span>
    </div>`).join("");
}

async function clearErrorLog() {
  await fetch("/api/errors", { method: "DELETE", headers: headers() });
  const wrap = document.getElementById("error-log-entries");
  const empty = document.getElementById("error-log-empty");
  if (wrap) { wrap.style.display = "none"; wrap.innerHTML = ""; }
  if (empty) empty.style.display = "";
  toast("Error log cleared");
}

const EXPORT_KINDS = {
  links: { url: "/api/export", filename: "tether-export.json" },
  notes: { url: "/api/export/notes", filename: "tether-notes.zip" },
  all: { url: "/api/export/all", filename: "tether-export.zip" },
};

function doExport(kind, tagId) {
  document.getElementById("export-modal")?.close();
  const { url, filename } = EXPORT_KINDS[kind];
  const finalUrl = tagId ? `${url}?tag=${tagId}` : url;
  fetch(finalUrl, { headers: headers() })
    .then(r => r.blob())
    .then(blob => {
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(objUrl);
    });
}

async function importData(input) {
  const file = input.files[0];
  if (!file) return;
  const hint = document.getElementById("import-hint");
  hint.textContent = "Importing…";
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "X-Tether-UUID": UUID_HEADER() },
      body: form,
    });
    const data = await res.json();
    if (res.ok) {
      hint.textContent = "";
      const parts = [];
      if (data.imported > 0) parts.push(`${data.imported} new link${data.imported !== 1 ? "s" : ""}`);
      if (data.skipped > 0) parts.push(`${data.skipped} already existed`);
      if (data.tags > 0) parts.push(`${data.tags} tag${data.tags !== 1 ? "s" : ""}`);
      toast(parts.length ? `Imported: ${parts.join(", ")}` : "Nothing new to import");
    } else {
      hint.textContent = "";
      toast(`Import failed: ${data.detail || "Unknown error"}`);
    }
  } catch {
    hint.textContent = "Something went wrong.";
  }
  input.value = "";
}

function copyUUID() {
  const text = document.getElementById("uuid-text")?.textContent;
  if (text) navigator.clipboard.writeText(text).then(() => toast("Copied!"));
}

function copyExtUUID() {
  const text = document.getElementById("ext-uuid-text")?.textContent;
  if (text) navigator.clipboard.writeText(text).then(() => toast("Copied!"));
}

function confirmRegenerate() {
  document.getElementById("regen-modal")?.showModal();
}

async function regenerateKey() {
  const { v4: uuidv4 } = await import("https://cdn.jsdelivr.net/npm/uuid@11/dist/esm-browser/v4.js");
  const newUUID = uuidv4();
  const res = await fetch("/api/settings/uuid", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ value: newUUID }),
  });
  if (res.ok) {
    toast("Key regenerated — re-download your shortcut!");
    setTimeout(() => location.reload(), 1500);
  }
  document.getElementById("regen-modal")?.close();
}

/* ── Add link modal ──────────────────────────────────────── */
let _addLinkTags  = []; // [{name, color}]
let _importTags   = []; // [{name, color}]

async function openAddLink() {
  _addLinkTags = [];
  document.getElementById("add-link-url").value = "";
  document.getElementById("add-link-new-tag-row").style.display = "none";
  document.getElementById("add-link-new-tag").value = "";
  document.getElementById("import-links-text").value = "";
  document.getElementById("import-new-tag-row").style.display = "none";
  document.getElementById("import-new-tag").value = "";
  _importTags = [];
  renderAddLinkTags();
  switchAddTab("single");

  const tagsRes = await fetch("/api/tags", { headers: headers() });
  const allTags = tagsRes.ok ? await tagsRes.json() : [];
  const sel = document.getElementById("add-link-tag-select");
  sel.innerHTML = '<option value="">— Add tag —</option><option value="__new__">＋ Add new tag</option>';
  allTags.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.dataset.color = t.color;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });

  // Populate import tab select too
  const isel = document.getElementById("import-tag-select");
  isel.innerHTML = '<option value="">— Add tag —</option><option value="__new__">＋ Add new tag</option>';
  allTags.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.dataset.color = t.color;
    opt.textContent = t.name;
    isel.appendChild(opt);
  });
  renderImportTags();

  document.getElementById("add-link-modal").showModal();
  setTimeout(() => document.getElementById("add-link-url").focus(), 50);
}

function switchAddTab(tab) {
  const isSingle = tab === "single";
  document.getElementById("add-link-form").style.display = isSingle ? "flex" : "none";
  document.getElementById("import-links-form").style.display = isSingle ? "none" : "flex";
  document.querySelectorAll(".modal-tab").forEach((btn, i) => {
    btn.classList.toggle("active", (i === 0) === isSingle);
  });
  if (!isSingle) setTimeout(() => document.getElementById("import-links-text").focus(), 50);
}

async function submitImportLinks(e) {
  e.preventDefault();
  const raw = document.getElementById("import-links-text").value;
  const urls = raw.split(/[\n,]+/).map(s => s.trim()).filter(s => s.length > 0);
  if (!urls.length) return;

  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = `Importing…`;

  let saved = 0;
  for (const url of urls) {
    const res = await fetch("/api/links", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ url, tags: _importTags.map(t => t.name) }),
    });
    if (res.ok) saved++;
  }

  btn.disabled = false;
  btn.textContent = "Import";
  document.getElementById("add-link-modal").close();
  toast(`Imported ${saved} of ${urls.length} links`);
  if (document.getElementById("links-container")) {
    await Promise.all([loadLinks(), loadSidebarCats(), updateCounts()]);
  }
}

function renderAddLinkTags() {
  const el = document.getElementById("add-link-tag-list");
  if (!el) return;
  el.innerHTML = _addLinkTags.map((t, i) => `
    <span class="edit-tag-chip" style="background:color-mix(in srgb,${escHtml(t.color)} 18%,transparent);color:${escHtml(t.color)}">
      ${escHtml(t.name)}
      <button type="button" onclick="removeAddLinkTag(${i})" aria-label="Remove">×</button>
    </span>
  `).join("");
}

function handleAddLinkTagSelect(sel) {
  const val = sel.value;
  if (!val) return;
  if (val === "__new__") {
    document.getElementById("add-link-new-tag-row").style.display = "flex";
    setTimeout(() => document.getElementById("add-link-new-tag").focus(), 50);
    sel.value = "";
    return;
  }
  const opt = sel.options[sel.selectedIndex];
  const color = opt.dataset.color || "#6366f1";
  if (!_addLinkTags.find(t => t.name === val)) {
    _addLinkTags.push({ name: val, color });
    renderAddLinkTags();
  }
  opt.remove();
  sel.value = "";
}

function addNewLinkTags() {
  const input = document.getElementById("add-link-new-tag");
  const names = input.value.split(",").map(s => s.trim()).filter(Boolean);
  names.forEach(name => {
    if (!_addLinkTags.find(t => t.name === name)) {
      _addLinkTags.push({ name, color: "#6366f1" });
    }
  });
  input.value = "";
  document.getElementById("add-link-new-tag-row").style.display = "none";
  renderAddLinkTags();
}

function removeAddLinkTag(i) {
  _addLinkTags.splice(i, 1);
  renderAddLinkTags();
}

async function submitAddLink(e) {
  e.preventDefault();
  const url = document.getElementById("add-link-url").value.trim();
  const res = await fetch("/api/links", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url, tags: _addLinkTags.map(t => t.name) }),
  });
  if (res.ok) {
    document.getElementById("add-link-modal").close();
    toast("Link saved!");
    if (document.getElementById("links-container")) {
      await Promise.all([loadLinks(), loadSidebarCats(), updateCounts()]);
    } else {
      setTimeout(() => window.location.href = "/", 400);
    }
  }
}

/* ── Quick add (from share sheet) ────────────────────────── */
let _quickAddTags = []; // [{name, color}]
let _quickAddUrl = "";
let _quickAddTitle = "";

async function openQuickAdd(url) {
  _quickAddTags = [];
  _quickAddUrl = url;
  _quickAddTitle = "";
  renderQuickAddTags();
  document.getElementById("quick-add-note").value = "";
  document.getElementById("quick-add-new-tag-row").style.display = "none";
  document.getElementById("quick-add-new-tag").value = "";
  document.getElementById("quick-add-form").style.display = "none";
  document.getElementById("quick-add-loading").style.display = "";
  document.getElementById("quick-add-modal").showModal();

  const [metaRes, tagsRes] = await Promise.all([
    fetch(`/api/metadata/preview?url=${encodeURIComponent(url)}`, { headers: headers() }),
    fetch("/api/tags", { headers: headers() }),
  ]);
  const meta = metaRes.ok ? await metaRes.json() : {};
  const allTags = tagsRes.ok ? await tagsRes.json() : [];

  _quickAddTitle = meta.title || "";
  document.getElementById("quick-add-favicon").src = meta.favicon_url || "";
  document.getElementById("quick-add-title").textContent = meta.title || getDomain(url);
  document.getElementById("quick-add-desc").textContent = meta.description || "";
  document.getElementById("quick-add-desc").style.display = meta.description ? "" : "none";
  document.getElementById("quick-add-url").textContent = url;

  const sel = document.getElementById("quick-add-tag-select");
  sel.innerHTML = '<option value="">— Add tag —</option><option value="__new__">＋ Add new tag</option>';
  allTags.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.dataset.color = t.color;
    opt.textContent = t.name;
    sel.appendChild(opt);
  });

  document.getElementById("quick-add-loading").style.display = "none";
  document.getElementById("quick-add-form").style.display = "flex";
}

function renderQuickAddTags() {
  const el = document.getElementById("quick-add-tag-list");
  el.innerHTML = _quickAddTags.map((t, i) => `
    <span class="edit-tag-chip" style="background:color-mix(in srgb,${escHtml(t.color)} 18%,transparent);color:${escHtml(t.color)}">
      ${escHtml(t.name)}
      <button type="button" onclick="removeQuickAddTag(${i})" aria-label="Remove">×</button>
    </span>
  `).join("");
}

function handleQuickAddTagSelect(sel) {
  const val = sel.value;
  if (!val) return;
  if (val === "__new__") {
    document.getElementById("quick-add-new-tag-row").style.display = "flex";
    setTimeout(() => document.getElementById("quick-add-new-tag").focus(), 50);
    sel.value = "";
    return;
  }
  const opt = sel.options[sel.selectedIndex];
  const color = opt.dataset.color || "#6366f1";
  if (!_quickAddTags.find(t => t.name === val)) {
    _quickAddTags.push({ name: val, color });
    renderQuickAddTags();
  }
  opt.remove();
  sel.value = "";
}

function addNewQuickAddTags() {
  const input = document.getElementById("quick-add-new-tag");
  const names = input.value.split(",").map(s => s.trim()).filter(Boolean);
  names.forEach(name => {
    if (!_quickAddTags.find(t => t.name === name)) {
      _quickAddTags.push({ name, color: "#6366f1" });
    }
  });
  input.value = "";
  document.getElementById("quick-add-new-tag-row").style.display = "none";
  renderQuickAddTags();
}

function removeQuickAddTag(i) {
  _quickAddTags.splice(i, 1);
  renderQuickAddTags();
}

async function submitQuickAdd(e) {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = "Saving…";

  const res = await fetch("/api/links", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url: _quickAddUrl, tags: _quickAddTags.map(t => t.name) }),
  });

  if (res.ok) {
    const { id } = await res.json();
    const noteText = document.getElementById("quick-add-note").value.trim();
    if (noteText && id) {
      const noteRes = await fetch("/api/notes", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ title: _quickAddTitle || getDomain(_quickAddUrl), link_id: id }),
      });
      if (noteRes.ok) {
        const note = await noteRes.json();
        await fetch(`/api/notes/${note.id}`, {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ content: `${_quickAddUrl}\n\n${noteText}` }),
        });
      }
    }
    document.getElementById("quick-add-modal").close();
    toast("Saved to Tether!");
    window.setShowingLinks?.(true);
    await Promise.all([loadLinks(), loadSidebarCats(), updateCounts()]);
  } else {
    toast("Failed to save link");
  }

  btn.disabled = false;
  btn.textContent = "Save";
}

/* ── Add note from link ──────────────────────────────────── */
async function addNoteFromLink(id) {
  const res = await fetch(`/api/links/${id}`, { headers: headers() });
  if (!res.ok) return;
  const link = await res.json();
  await window.createNoteFromLink(link.title || getDomain(link.url), link.url, id);
}

async function openNoteForLink(linkId, noteId) {
  if (noteId && await window.openNoteById?.(noteId)) return;
  // note_id was stale (note deleted elsewhere) — fall back to creating a fresh one
  await addNoteFromLink(linkId);
}

/* ── Edit modal ──────────────────────────────────────────── */
let _editTags = []; // [{name, color}]
let _allTags  = []; // [{id, name, color}] from server

async function editLink(id) {
  const [linkRes, tagsRes] = await Promise.all([
    fetch(`/api/links/${id}`, { headers: headers() }),
    fetch("/api/tags", { headers: headers() }),
  ]);
  if (!linkRes.ok) return;
  const link = await linkRes.json();
  _allTags = tagsRes.ok ? await tagsRes.json() : [];

  _editTags = link.tags.map(t => ({ name: t.name, color: t.color }));
  document.getElementById("edit-link-id").value = id;
  document.getElementById("edit-title").value = link.title || "";
  document.getElementById("edit-url").value = link.url || "";

  // Populate dropdown
  const sel = document.getElementById("edit-tag-select");
  sel.innerHTML = '<option value="">— Add tag —</option><option value="__new__">＋ Add new tag</option>';
  _allTags.forEach(t => {
    if (!_editTags.find(e => e.name === t.name)) {
      const opt = document.createElement("option");
      opt.value = t.name;
      opt.dataset.color = t.color;
      opt.textContent = t.name;
      sel.appendChild(opt);
    }
  });

  document.getElementById("edit-new-tag-row").style.display = "none";
  document.getElementById("edit-new-tag").value = "";
  renderEditTags();
  document.getElementById("edit-modal").showModal();
  setTimeout(() => document.getElementById("edit-title").focus(), 50);
}

function renderEditTags() {
  const el = document.getElementById("edit-tag-list");
  if (!el) return;
  el.innerHTML = _editTags.map((t, i) => `
    <span class="edit-tag-chip" style="background:color-mix(in srgb,${escHtml(t.color)} 18%,transparent);color:${escHtml(t.color)}">
      ${escHtml(t.name)}
      <button type="button" onclick="removeEditTag(${i})" aria-label="Remove">×</button>
    </span>
  `).join("");
}

function handleTagSelect(sel) {
  const val = sel.value;
  if (!val) return;
  if (val === "__new__") {
    document.getElementById("edit-new-tag-row").style.display = "flex";
    setTimeout(() => document.getElementById("edit-new-tag").focus(), 50);
    sel.value = "";
    return;
  }
  const opt = sel.options[sel.selectedIndex];
  const color = opt.dataset.color || "#6366f1";
  if (!_editTags.find(t => t.name === val)) {
    _editTags.push({ name: val, color });
    renderEditTags();
  }
  // Remove from dropdown
  opt.remove();
  sel.value = "";
}

function addNewEditTags() {
  const input = document.getElementById("edit-new-tag");
  const names = input.value.split(",").map(s => s.trim()).filter(Boolean);
  names.forEach(name => {
    if (!_editTags.find(t => t.name === name)) {
      const existing = _allTags.find(t => t.name === name);
      _editTags.push({ name, color: existing?.color || "#6366f1" });
    }
  });
  input.value = "";
  document.getElementById("edit-new-tag-row").style.display = "none";
  renderEditTags();
}

function removeEditTag(i) {
  const removed = _editTags.splice(i, 1)[0];
  renderEditTags();
  // Add back to dropdown if it was an existing tag
  const existing = _allTags.find(t => t.name === removed.name);
  if (existing) {
    const sel = document.getElementById("edit-tag-select");
    const opt = document.createElement("option");
    opt.value = existing.name;
    opt.dataset.color = existing.color;
    opt.textContent = existing.name;
    sel.appendChild(opt);
  }
}

function renderImportTags() {
  const el = document.getElementById("import-tag-list");
  if (!el) return;
  el.innerHTML = _importTags.map((t, i) => `
    <span class="edit-tag-chip" style="background:color-mix(in srgb,${escHtml(t.color)} 18%,transparent);color:${escHtml(t.color)}">
      ${escHtml(t.name)}
      <button type="button" onclick="removeImportTag(${i})" aria-label="Remove">×</button>
    </span>
  `).join("");
}

function handleImportTagSelect(sel) {
  const val = sel.value;
  if (!val) return;
  if (val === "__new__") {
    document.getElementById("import-new-tag-row").style.display = "flex";
    setTimeout(() => document.getElementById("import-new-tag").focus(), 50);
    sel.value = "";
    return;
  }
  const opt = sel.options[sel.selectedIndex];
  const color = opt.dataset.color || "#6366f1";
  if (!_importTags.find(t => t.name === val)) {
    _importTags.push({ name: val, color });
    renderImportTags();
  }
  opt.remove();
  sel.value = "";
}

function addNewImportTags() {
  const input = document.getElementById("import-new-tag");
  const names = input.value.split(",").map(s => s.trim()).filter(Boolean);
  names.forEach(name => {
    if (!_importTags.find(t => t.name === name)) {
      const existing = _allTags.find(t => t.name === name);
      _importTags.push({ name, color: existing?.color || "#6366f1" });
    }
  });
  input.value = "";
  document.getElementById("import-new-tag-row").style.display = "none";
  renderImportTags();
}

function removeImportTag(i) {
  const removed = _importTags.splice(i, 1)[0];
  renderImportTags();
  const existing = _allTags.find(t => t.name === removed.name);
  if (existing) {
    const sel = document.getElementById("import-tag-select");
    const opt = document.createElement("option");
    opt.value = existing.name;
    opt.dataset.color = existing.color;
    opt.textContent = existing.name;
    sel.appendChild(opt);
  }
}

function handleTagKey(e) {
  if (e.key === "Enter") { e.preventDefault(); addNewEditTags(); }
}

async function refreshLinkMetadata() {
  const id = document.getElementById("edit-link-id").value;
  if (!id) return;
  const btn = document.getElementById("edit-refresh-btn");
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="refresh-cw"></i> Refreshing…';
  lucide.createIcons();
  await fetch(`/api/links/${id}/refresh`, { method: "POST", headers: headers() });
  const link = await fetch(`/api/links/${id}`, { headers: headers() }).then(r => r.json());
  document.getElementById("edit-title").value = link.title || "";
  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="refresh-cw"></i> Refresh metadata';
  lucide.createIcons();
  toast("Metadata refreshed");
}

async function saveLink(e) {
  e.preventDefault();
  const id = document.getElementById("edit-link-id").value;
  const title = document.getElementById("edit-title").value.trim();
  const url = document.getElementById("edit-url").value.trim();
  const res = await fetch(`/api/links/${id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ title, url, tags: _editTags.map(t => t.name) }),
  });
  if (res.ok) {
    document.getElementById("edit-modal").close();
    await loadLinks();
    loadSidebarCats();
    updateCounts();
    toast("Link updated");
  }
}

/* ── Sidebar categories ──────────────────────────────────── */
async function loadSidebarCats() {
  const ul = document.getElementById("sidebar-cats");
  if (!ul) return;
  try {
    const [tagsRes, uncatRes] = await Promise.all([
      fetch("/api/tags", { headers: headers() }),
      fetch("/api/links/uncategorised-count", { headers: headers() }),
    ]);
    if (!tagsRes.ok) return;
    const tags = await tagsRes.json();
    const { unread_count: uncatUnread } = uncatRes.ok ? await uncatRes.json() : { unread_count: 0 };

    const params = new URLSearchParams(location.search);
    const activeTag = params.get("tag");
    const activeUncat = params.get("uncategorised") === "true";

    const uncatItem = `
      <li>
        <a href="/?uncategorised=true"
           class="sidebar-cat-link ${activeUncat ? "active" : ""}">
          <span class="sidebar-cat-dot" style="background:var(--subtext);opacity:0.4"></span>
          <span class="sidebar-cat-name">Untagged</span>
          ${uncatUnread > 0 ? `<span class="sidebar-cat-badge">${uncatUnread}</span>` : ""}
        </a>
      </li>`;

    ul.innerHTML = uncatItem + tags.map(t => `
      <li>
        <a href="/?tag=${encodeURIComponent(t.id)}"
           class="sidebar-cat-link ${activeTag === String(t.id) ? "active" : ""}">
          <span class="sidebar-cat-dot" style="background:${escHtml(t.color)}"></span>
          <span class="sidebar-cat-name">${escHtml(t.name)}</span>
        </a>
        <div class="row-menu-wrap">
          <button class="row-overflow" type="button" title="More">
            <i data-lucide="ellipsis"></i>
          </button>
          <div class="row-menu">
            <button type="button" class="row-menu-item" data-action="rename" data-id="${t.id}">
              <i data-lucide="square-pen"></i> Rename
            </button>
            <button type="button" class="row-menu-item" data-action="export" data-id="${t.id}">
              <i data-lucide="download"></i> Export data
            </button>
            <button type="button" class="row-menu-item danger" data-action="delete" data-id="${t.id}">
              <i data-lucide="trash-2"></i> Delete
            </button>
          </div>
        </div>
      </li>
    `).join("");

    ul.querySelectorAll(".row-overflow").forEach(btn => {
      btn.addEventListener("click", () => toggleRowMenu(btn));
    });
    ul.querySelectorAll('[data-action="rename"]').forEach(btn => {
      btn.addEventListener("click", () => {
        closeRowMenus();
        const t = tags.find(x => x.id === Number(btn.dataset.id));
        if (t) openEditTag(t.id, t.name, t.color);
      });
    });
    ul.querySelectorAll('[data-action="export"]').forEach(btn => {
      btn.addEventListener("click", () => {
        closeRowMenus();
        doExport("all", btn.dataset.id);
      });
    });
    ul.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener("click", () => {
        closeRowMenus();
        const t = tags.find(x => x.id === Number(btn.dataset.id));
        if (t) openTagDeleteModal(t.id, t.name);
      });
    });
    lucide.createIcons();
  } catch {}
}

function setPageTitle(title) {
  document.title = `${title} — Tether`;
}

/* ── Settings tabs ───────────────────────────────────────── */
function initSettingsTabs() {
  document.querySelectorAll(".settings-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".settings-group").forEach(g => {
        g.style.display = g.dataset.group === btn.dataset.group ? "" : "none";
      });
    });
  });
}

/* ── Notes toolbar setting ───────────────────────────────── */
function toggleNotesToolbarSetting(show) {
  localStorage.setItem("notesToolbarHidden", show ? "" : "1");
}

function initNotesToolbarToggle() {
  const checkbox = document.getElementById("notes-toolbar-toggle");
  if (checkbox) checkbox.checked = localStorage.getItem("notesToolbarHidden") !== "1";
}

/* ── Init ────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  setView(currentView);
  loadSidebarCats();
  initSidebarResize();

  const addUrl = new URLSearchParams(location.search).get("add");
  if (addUrl) {
    const clean = new URL(location.href);
    clean.searchParams.delete("add");
    history.replaceState({}, "", clean);
    openQuickAdd(addUrl);
  }

  if (document.getElementById("links-container")) {
    // activate filter from URL param
    const urlParams = new URLSearchParams(location.search);
    const tagParam = urlParams.get("tag");
    const uncatParam = urlParams.get("uncategorised");
    if (tagParam) {
      currentTag = tagParam;
      document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
      document.querySelector(".filter-chip[data-tag='']")?.classList.add("active");
      // resolve tag name for heading
      fetch("/api/tags", { headers: headers() })
        .then(r => r.json())
        .then(tags => {
          const tag = tags.find(t => String(t.id) === String(tagParam));
          if (tag) setPageTitle(tag.name);
        });
    } else if (uncatParam === "true") {
      currentUncat = true;
      document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
      document.querySelector(".filter-chip[data-tag='']")?.classList.add("active");
      setPageTitle("Untagged");
    }
    initFilters();
    initSearch();
    loadLinks();
    updateCounts();
  }
  loadErrorLog();
  initSettingsTabs();
  initNotesToolbarToggle();
});
