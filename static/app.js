// The server resolves the readable path into ids before the page loads.
const VIEW = window.TETHER_VIEW || { tag: null, uncategorised: false, type: "all", ct: null, note: null };

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
  const MIN_WIDTH = 180;
  const MAX_WIDTH = 420;

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

  // double click resets: drop the override and let the stylesheet default win
  handle.addEventListener("dblclick", () => {
    document.documentElement.style.removeProperty("--sidebar-w");
    localStorage.removeItem("sidebarWidth");
  });
}

/* global state */
let currentTag = null;
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

/* ── Fetch links ─────────────────────────────────────────── */
async function fetchLinks(tag, uncat, query) {
  let url;
  if (query) {
    url = `/api/links/search?q=${encodeURIComponent(query)}`;
  } else {
    url = "/api/links";
    const params = new URLSearchParams();
    if (tag) params.set("tag", tag);
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
  _cachedLinks = await fetchLinks(currentTag, currentUncat, query);
  renderCurrentLinks();
}

function renderCurrentLinks() {
  renderCards(_cachedLinks);
}

async function updateCounts() {
  const counts = document.getElementById("link-counts");
  if (!counts) return;
  try {
    const all = await fetchLinks(currentTag, currentUncat, null);
    counts.textContent = `${all.length} total`;
  } catch {}
}

/* ── Render helpers ──────────────────────────────────────── */
function tagPills(tags) {
  return tags.map(t =>
    `<span class="tag-pill" style="border:1px solid color-mix(in srgb,${t.color} 45%,transparent);color:${t.color}">${escHtml(t.name)}</span>`
  ).join("");
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

window.friendlyDate = friendlyDate;
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

function linkCardHtml(link) {
  const domain = escHtml(getDomain(link.url));
  return `
    <article class="link-row" data-id="${link.id}">
      <span class="link-thumb">
        ${link.favicon_url ? `<img src="${escHtml(link.favicon_url)}" alt="" onerror="this.style.display='none'">` : ""}
      </span>
      <span class="link-main">
        <a class="link-title" href="${escHtml(link.url)}" target="_blank" rel="noopener">${escHtml(link.title || domain)}</a>
        <span class="link-url">${domain}</span>
      </span>
      ${link.note_id ? `
      <button class="link-note-btn" title="Open note" data-note-for="${link.id}" data-note-id="${link.note_id}">
        <i data-lucide="file-text"></i>
      </button>` : ""}
      <span class="link-meta">
        <span class="card-tags">${tagPills(link.tags)}</span>
        <span class="link-date">${friendlyDate(link.created_at)}</span>
      </span>
      <div class="row-menu-wrap">
        <button class="row-overflow" type="button" title="More">
          <i data-lucide="ellipsis-vertical"></i>
        </button>
        <div class="row-menu">
          <button type="button" class="row-menu-item" onclick="openNoteForLink('${link.id}', ${link.note_id ? `'${link.note_id}'` : "null"})">
            <i data-lucide="file-text"></i> ${link.note_id ? "Open note" : "Add note"}
          </button>
          <button type="button" class="row-menu-item" onclick="editLink('${link.id}')">
            <i data-lucide="square-pen"></i> Edit
          </button>
          <button type="button" class="row-menu-item danger" onclick="deleteLink('${link.id}')">
            <i data-lucide="trash-2"></i> Delete
          </button>
        </div>
      </div>
    </article>`;
}

window.linkCardHtml = linkCardHtml;
window.bindLinkRowMenus = bindLinkRowMenus;

function bindLinkRowMenus(root) {
  root.querySelectorAll(".link-row .row-overflow").forEach(btn => {
    btn.addEventListener("click", () => toggleRowMenu(btn));
  });
  root.querySelectorAll("[data-note-for]").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      openNoteForLink(btn.dataset.noteFor, btn.dataset.noteId);
    });
  });
  root.querySelectorAll(".link-row .row-menu-item").forEach(btn => {
    btn.addEventListener("click", () => closeRowMenus());
  });
}

function renderCards(links) {
  const container = document.getElementById("links-container");
  if (!container) return;
  container.className = "cards-view";

  if (!links.length) {
    container.innerHTML = '<div class="empty-state">No links yet. Send some from your iPhone!</div>';
    return;
  }

  container.innerHTML = links.map(linkCardHtml).join("");
  bindLinkRowMenus(container);
  lucide.createIcons();
}

/* ── Row overflow menu ───────────────────────────────────── */
function closeRowMenus() {
  document.querySelectorAll(".row-menu.open").forEach(m => m.classList.remove("open"));
}
// The menu is position:fixed so it never counts towards the scroll height of a
// scrolling parent (the sidebar list), which otherwise grew a scrollbar when open.
function toggleRowMenu(btn) {
  const menu = btn.nextElementSibling;
  const isOpen = menu.classList.contains("open");
  closeRowMenus();
  if (isOpen) return;
  menu.classList.add("open");

  const r = btn.getBoundingClientRect();
  const h = menu.offsetHeight;
  const w = menu.offsetWidth;
  const below = r.bottom + 4;
  const top = below + h > window.innerHeight ? r.top - h - 4 : below;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
}
document.addEventListener("click", e => {
  if (!e.target.closest(".row-menu-wrap")) closeRowMenus();
});
// a fixed menu would otherwise hang in place while its row scrolls away
document.addEventListener("scroll", () => closeRowMenus(), true);
window.addEventListener("resize", () => closeRowMenus());

/* ── Actions ─────────────────────────────────────────────── */
async function deleteLink(id) {
  if (!await showConfirm("Delete this link? This can't be undone.")) return;
  await fetch(`/api/links/${id}`, { method: "DELETE", headers: headers() });
  await Promise.all([loadLinks(), loadSidebarCats(), updateCounts()]);
  toast("Link deleted");
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

function exportSelectedTags() {
  return [...document.querySelectorAll(".export-cat:checked")].map(c => c.value);
}

function toggleAllExportCats(on) {
  document.querySelectorAll(".export-cat").forEach(c => { c.checked = on; });
  updateExportScopeLabel();
}

function updateExportScopeLabel() {
  const label = document.getElementById("export-scope");
  if (!label) return;
  const n = exportSelectedTags().length;
  label.textContent = n ? `${n} categor${n === 1 ? "y" : "ies"} selected` : "All categories";
}

async function fillExportCategories() {
  const box = document.getElementById("export-cats");
  if (!box) return;
  const res = await fetch("/api/tags", { headers: headers() });
  const tags = res.ok ? await res.json() : [];
  box.innerHTML = tags.map(t => `
    <label class="export-cat-row">
      <input type="checkbox" class="export-cat" value="${t.id}" onchange="updateExportScopeLabel()">
      <span class="sidebar-cat-dot" style="background:${escHtml(t.color)}"></span>
      <span>${escHtml(t.name)}</span>
    </label>`).join("");
  updateExportScopeLabel();
}

const EXPORT_KINDS = {
  links: { url: "/api/export", filename: "tether-export.json" },
  notes: { url: "/api/export/notes", filename: "tether-notes.zip" },
  all: { url: "/api/export/all", filename: "tether-export.zip" },
};

// tagIds: undefined/empty = everything, otherwise the chosen categories
function openExportModal() {
  fillExportCategories();
  document.getElementById("export-modal")?.showModal();
}

function doExport(kind, tagIds) {
  document.getElementById("export-modal")?.close();
  const { url, filename } = EXPORT_KINDS[kind];
  const list = [].concat(tagIds || []).filter(Boolean);
  const finalUrl = list.length ? `${url}?tags=${list.join(",")}` : url;
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

async function openAddLink(preTag) {
  _addLinkTags = preTag ? [preTag] : [];
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
    <span class="edit-tag-chip" style="border:1px solid color-mix(in srgb,${escHtml(t.color)} 45%,transparent);color:${escHtml(t.color)}">
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
    <span class="edit-tag-chip" style="border:1px solid color-mix(in srgb,${escHtml(t.color)} 45%,transparent);color:${escHtml(t.color)}">
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
    <span class="edit-tag-chip" style="border:1px solid color-mix(in srgb,${escHtml(t.color)} 45%,transparent);color:${escHtml(t.color)}">
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
    <span class="edit-tag-chip" style="border:1px solid color-mix(in srgb,${escHtml(t.color)} 45%,transparent);color:${escHtml(t.color)}">
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

/* ── Add link panel ──────────────────────────────────────── */
let _addPanelMeta = {};      // favicon from the preview, carried to the save
let _addPreviewSeq = 0;      // ignore previews that resolve out of order

function openAddPanel() {
  const panel = document.getElementById("add-panel");
  if (!panel) return;
  panel.classList.add("open");
  const sel = document.getElementById("add-panel-category");
  const current = VIEW.tag ? String(VIEW.tag) : null;
  sel.innerHTML = `<option value="">Untagged</option>` +
    _sidebarTags.map(t =>
      `<option value="${t.id}" ${String(t.id) === current ? "selected" : ""}>${escHtml(t.name)}</option>`
    ).join("");
  setTimeout(() => document.getElementById("add-panel-url").focus(), 30);
}

function closeAddPanel() {
  const panel = document.getElementById("add-panel");
  if (!panel) return;
  panel.classList.remove("open");
  document.getElementById("add-panel-form").reset();
  document.getElementById("add-panel-status").textContent = "";
  _addPanelMeta = {};
}

async function previewAddPanelUrl() {
  const url = document.getElementById("add-panel-url").value.trim();
  const status = document.getElementById("add-panel-status");
  if (!url) return;
  const seq = ++_addPreviewSeq;
  status.textContent = "Fetching page info…";
  try {
    const res = await fetch(`/api/metadata/preview?url=${encodeURIComponent(url)}`, { headers: headers() });
    if (seq !== _addPreviewSeq) return;          // a newer paste won
    const meta = res.ok ? await res.json() : {};
    _addPanelMeta = meta;
    const title = document.getElementById("add-panel-title");
    const desc = document.getElementById("add-panel-desc");
    // never clobber something the user has already typed
    if (!title.value && meta.title) title.value = meta.title;
    if (!desc.value && meta.description) desc.value = meta.description;
    status.textContent = meta.title ? "Found page info — edit it if you like." : "No page info found.";
  } catch {
    if (seq === _addPreviewSeq) status.textContent = "Could not reach that page.";
  }
}

async function submitAddPanel(ev) {
  ev.preventDefault();
  const btn = document.getElementById("add-panel-save");
  const url = document.getElementById("add-panel-url").value.trim();
  const tagId = document.getElementById("add-panel-category").value;
  const tag = _sidebarTags.find(t => String(t.id) === String(tagId));
  if (!url) return;

  btn.disabled = true;
  const res = await fetch("/api/links", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      url,
      title: document.getElementById("add-panel-title").value.trim(),
      description: document.getElementById("add-panel-desc").value.trim(),
      favicon_url: _addPanelMeta.favicon_url || "",
      tags: tag ? [tag.name] : [],
    }),
  });
  btn.disabled = false;

  if (!res.ok) { toast("Could not save that link"); return; }
  const body = await res.json();
  closeAddPanel();
  toast(body.duplicate ? "Already saved" : "Link saved");
  await loadSidebarCats();
  if (typeof loadLinks === "function") await loadLinks();
  const ctId = new URLSearchParams(location.search).get("ct");
  if (ctId) renderContentTypeView(ctId);
  else window.showCategoryOverview?.();
}

// the bulk paste form lives in the add-link modal, which the panel now fronts
async function openBulkImport() {
  closeAddPanel();
  await openAddLink();
  switchAddTab("import");
}

function initAddPanel() {
  const btn = document.getElementById("topbar-add");
  const panel = document.getElementById("add-panel");
  if (!btn || !panel) return;
  btn.addEventListener("click", ev => {
    ev.stopPropagation();
    panel.classList.contains("open") ? closeAddPanel() : openAddPanel();
  });
  panel.addEventListener("click", ev => ev.stopPropagation());
  document.addEventListener("click", () => {
    if (panel.classList.contains("open")) closeAddPanel();
  });
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && panel.classList.contains("open")) closeAddPanel();
  });
  const url = document.getElementById("add-panel-url");
  url.addEventListener("change", previewAddPanelUrl);
  url.addEventListener("paste", () => setTimeout(previewAddPanelUrl, 0));
}

/* ── Sidebar categories ──────────────────────────────────── */
// Two states: the category list, and one category drilled down to its content
// types. The drill is derived from the URL so a reload keeps you where you were.
let _sidebarTags = [];
let _uncatCount = 0;
let _drillId = null;   // null = list, "" = Untagged, otherwise a tag id (string)

const KIND_ICON = { links: "link", notes: "file-text" };
const KIND_LABEL = { links: "Links", notes: "Notes" };
let _contentTypes = [];   // for the category currently drilled into
let _ctNotes = {};        // notes keyed by their notes-kind content type id
let _openNoteId = null;   // the note in the editor wins over the path's highlight
let _activeCt = VIEW.ct ? String(VIEW.ct) : null;
let _activeType = VIEW.type === "ct" ? "ct" : VIEW.type;

/* ── Readable paths ──────────────────────────────────────── */
// The server resolves the path into ids before the page loads; from then on the
// front end builds the same paths back out of the slugs the API returns.

function categorySlug(drillId) {
  if (drillId === "") return "untagged";
  const t = _sidebarTags.find(x => String(x.id) === String(drillId));
  return t ? t.slug : "";
}

function categoryPath(drillId, tail = "") {
  const slug = categorySlug(drillId);
  if (!slug) return "/";
  return `/${slug}${tail}`;
}

function folderSvg(color) {
  return `<svg class="sidebar-cat-folder" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
}

function drillMeta(id) {
  if (id === "") return { name: "Untagged", color: "var(--n-500)" };
  const t = _sidebarTags.find(x => String(x.id) === String(id));
  return t ? { name: t.name, color: t.color } : null;
}

function renderSidebar(slide) {
  const ul = document.getElementById("sidebar-cats");
  if (!ul) return;
  const back = document.getElementById("sidebar-back");
  const title = document.getElementById("sidebar-cat-title");
  const newCat = document.getElementById("sidebar-new-cat");
  const newContent = document.getElementById("sidebar-new-content");
  const meta = _drillId === null ? null : drillMeta(_drillId);

  if (!meta) {
    _drillId = null;
    if (back) back.style.display = "none";
    if (title) title.style.display = "none";
    if (newCat) newCat.style.display = "";
    if (newContent) newContent.style.display = "none";
    renderCategoryList(ul);
  } else {
    if (back) back.style.display = "";
    if (title) {
      // the category itself is the default view — what "All" used to be
      const onOverview = !_activeCt && _activeType === "all" && !_openNoteId;
      title.style.display = "";
      title.href = categoryPath(_drillId);
      title.classList.toggle("active", onOverview);
      title.innerHTML = folderSvg(escHtml(meta.color)) +
        `<span>${escHtml(meta.name)}</span>`;
    }
    if (newCat) newCat.style.display = "none";
    if (newContent) newContent.style.display = "";
    renderContentTypes(ul, meta);
  }
  lucide.createIcons();

  if (slide) {
    ul.classList.remove("slide-from-right", "slide-from-left");
    void ul.offsetWidth;                     // restart the animation
    ul.classList.add(`slide-from-${slide}`);
  }
}

function renderCategoryList(ul) {
  const activeTag = VIEW.tag ? String(VIEW.tag) : null;
  const activeUncat = VIEW.uncategorised;

  // navigating loads the category's overview; the sidebar lands drilled in
  const row = (id, name, color, badge, menu) => `
    <li ${id === "" ? "" : `data-order="${id}"`}>
      <a href="${categoryPath(id)}" ${id === "" ? "" : `data-cat="${id}"`}
         class="sidebar-cat-link ${(id === "" ? activeUncat : activeTag === String(id)) ? "active" : ""}">
        ${folderSvg(color)}
        <span class="sidebar-cat-name">${name}</span>
        ${badge}
      </a>
      ${menu ? `
      <div class="row-menu-wrap">
        <button class="row-overflow" type="button" title="More">
          <i data-lucide="ellipsis-vertical"></i>
        </button>
        <div class="row-menu">${menu}</div>
      </div>` : ""}
    </li>`;

  ul.innerHTML =
    (_uncatCount > 0
      ? row("", "Untagged", "var(--n-500)", `<span class="sidebar-cat-badge">${_uncatCount}</span>`, "")
      : "") +
    _sidebarTags.map(t => row(t.id, escHtml(t.name), escHtml(t.color), "", `
      <button type="button" class="row-menu-item" data-action="rename" data-id="${t.id}">
        <i data-lucide="square-pen"></i> Edit
      </button>
      <button type="button" class="row-menu-item" data-action="export" data-id="${t.id}">
        <i data-lucide="download"></i> Export data
      </button>
      <button type="button" class="row-menu-item danger" data-action="delete" data-id="${t.id}">
        <i data-lucide="trash-2"></i> Delete
      </button>`)).join("");

  bindRowMenus(ul);
  initListDrag(ul, "[data-cat]", "cat", async ids => {
    await fetch("/api/tags/reorder", {
      method: "PATCH", headers: headers(),
      body: JSON.stringify({ order: ids.filter(Boolean).map(Number) }),
    });
    _sidebarTags.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
  });
}

/* ── Drag to reorder ─────────────────────────────────────── */
// Rows are dragged by their <li>; `sel` marks which rows take part, so the
// Untagged row and the Notes heading stay put.
function initListDrag(ul, sel, key, save) {
  const items = [...ul.querySelectorAll(sel)]
    .map(el => el.closest("li"))
    .filter(li => li && li.dataset.order !== undefined);
  if (items.length < 2) return;

  let dragging = null;
  for (const li of items) {
    li.draggable = true;
    li.addEventListener("dragstart", ev => {
      dragging = li;
      li.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", li.dataset.order);
    });
    li.addEventListener("dragend", async () => {
      li.classList.remove("dragging");
      if (!dragging) return;
      dragging = null;
      const ids = [...ul.querySelectorAll(sel)].map(el => el.closest("li").dataset.order);
      await save(ids);
    });
  }

  ul.addEventListener("dragover", ev => {
    if (!dragging) return;
    ev.preventDefault();
    const after = items
      .filter(li => li !== dragging && li.isConnected)
      .reduce((closest, li) => {
        const box = li.getBoundingClientRect();
        const offset = ev.clientY - box.top - box.height / 2;
        return offset < 0 && offset > closest.offset ? { offset, el: li } : closest;
      }, { offset: -Infinity, el: null }).el;
    if (after) ul.insertBefore(dragging, after);
    else ul.appendChild(dragging);
  });
}

function renderContentTypes(ul, meta) {
  const activeCt = _activeCt;
  const activeType = _activeType;
  const rows = [];

  // Untagged is the absence of a category, so it owns no content types — give it
  // the same two rows backed by the built-in filtered views
  if (_drillId === "") {
    rows.push(`
      <li>
        <a href="${categoryPath(_drillId, "/links")}" class="sidebar-cat-link ${activeType === "links" ? "active" : ""}">
          <i data-lucide="link"></i>
          <span class="sidebar-cat-name">Links</span>
        </a>
      </li>
      <li class="ct-heading"><span class="ct-heading-label">Notes</span></li>`);
    const notes = _ctNotes.untagged || [];
    rows.push(notes.length
      ? notes.map(n => `
        <li data-order="${n.id}">
          <button type="button" class="sidebar-cat-link ct-note ${_openNoteId === n.id ? "active" : ""}"
                  data-note="${n.id}" title="${n.link_id ? "Note on a saved link" : ""}">
            <i data-lucide="${n.link_id ? "link" : "file-text"}"></i>
            <span class="sidebar-cat-name">${escHtml(n.title || "Untitled")}</span>
          </button>
      <div class="row-menu-wrap">
        <button class="row-overflow" type="button" title="More">
          <i data-lucide="ellipsis-vertical"></i>
        </button>
        <div class="row-menu">
          <button type="button" class="row-menu-item" data-note-action="category" data-id="${n.id}">
            <i data-lucide="tag"></i> Change category
          </button>
          <button type="button" class="row-menu-item danger" data-note-action="delete" data-id="${n.id}">
            <i data-lucide="trash-2"></i> Delete
          </button>
        </div>
      </div>
        </li>`).join("")
      : `<li class="sidebar-empty">No notes yet.</li>`);
  }

  for (const ct of _contentTypes) {
    if (ct.kind === "notes") {
      // a heading rather than a link: its notes are listed right below it
      rows.push(`
        <li class="ct-heading">
          <span class="ct-heading-label">${escHtml(ct.title)}</span>
        </li>`);
      const notes = _ctNotes[ct.id] || [];
      if (!notes.length) {
        rows.push(`<li class="sidebar-empty">No notes yet.</li>`);
      } else {
        for (const n of notes) {
          rows.push(`
            <li data-order="${n.id}">
              <button type="button" class="sidebar-cat-link ct-note ${_openNoteId === n.id ? "active" : ""}"
                      data-note="${n.id}" title="${n.link_id ? "Note on a saved link" : ""}">
                <i data-lucide="${n.link_id ? "link" : "file-text"}"></i>
                <span class="sidebar-cat-name">${escHtml(n.title || "Untitled")}</span>
              </button>
              <div class="row-menu-wrap">
                <button class="row-overflow" type="button" title="More">
                  <i data-lucide="ellipsis-vertical"></i>
                </button>
                <div class="row-menu">
                  <button type="button" class="row-menu-item" data-note-action="category" data-id="${n.id}">
                    <i data-lucide="tag"></i> Change category
                  </button>
                  <button type="button" class="row-menu-item danger" data-note-action="delete" data-id="${n.id}">
                    <i data-lucide="trash-2"></i> Delete
                  </button>
                </div>
              </div>
            </li>`);
        }
      }
    } else {
      rows.push(`
        <li>
          <a href="${categoryPath(_drillId, ct.kind === "links" ? "/links" : "/notes")}" data-ct="${ct.id}"
             class="sidebar-cat-link ${activeCt === String(ct.id) && !_openNoteId ? "active" : ""}">
            <i data-lucide="${KIND_ICON[ct.kind] || "file"}"></i>
            <span class="sidebar-cat-name">${escHtml(ct.title)}</span>
            ${ct.count ? `<span class="sidebar-cat-badge">${ct.count}</span>` : ""}
          </a>
        </li>`);
    }
  }

  ul.innerHTML = rows.join("");

  ul.querySelectorAll(".row-overflow").forEach(btn => {
    btn.addEventListener("click", () => toggleRowMenu(btn));
  });
  ul.querySelectorAll("[data-note]").forEach(btn => {
    btn.addEventListener("click", () => {
      _openNoteId = btn.dataset.note;
      markSidebarActive(null);
      btn.classList.add("active");
      window.openNoteById?.(btn.dataset.note);
    });
  });
  initListDrag(ul, "[data-note]", "note", async ids => {
    await fetch("/api/notes/reorder", {
      method: "PATCH", headers: headers(), body: JSON.stringify({ order: ids }),
    });
  });
  ul.querySelectorAll("[data-ct]").forEach(a => {
    a.addEventListener("click", ev => {
      ev.preventDefault();
      goContentType(a.dataset.ct);
    });
  });
  ul.querySelectorAll(".row-overflow").forEach(btn => {
    btn.addEventListener("click", () => toggleRowMenu(btn));
  });
  ul.querySelectorAll("[data-note-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      closeRowMenus();
      if (btn.dataset.noteAction === "category") window.openNoteCategory?.(btn.dataset.id);
      else window.deleteNoteById?.(btn.dataset.id);
    });
  });
}

/* ── In-place view switching ─────────────────────────────── */
// ctId null means the category overview
window.setSidebarNote = (noteId, slug) => {
  _openNoteId = noteId || null;
  if (noteId && slug && _drillId !== null) {
    const path = categoryPath(_drillId, `/notes/${slug}`);
    if (path !== "/" && location.pathname !== path) history.pushState({}, "", path);
  }
  renderSidebar();
};

function markSidebarActive(ctId) {
  document.querySelectorAll("#sidebar-cats .sidebar-cat-link")
    .forEach(el => el.classList.toggle("active", ctId != null && el.dataset.ct === String(ctId)));
  document.getElementById("sidebar-cat-title")?.classList.toggle("active", ctId === "overview");
}

function goContentType(ctId) {
  _openNoteId = null;
  _activeCt = String(ctId);
  _activeType = "ct";
  const ct = _contentTypes.find(c => String(c.id) === String(ctId));
  history.pushState({}, "", categoryPath(_drillId, ct && ct.kind === "notes" ? "/notes" : "/links"));
  markSidebarActive(ctId);
  window.showContentTypeView?.(ctId);
}

function goCategoryOverview() {
  _openNoteId = null;
  _activeCt = null;
  _activeType = "all";
  history.pushState({}, "", categoryPath(_drillId));
  markSidebarActive("overview");
  window.showCategoryOverview?.();
}

// keep browser back/forward working for those pushes
// The path is resolved server-side, so let a real load handle back/forward
// rather than duplicating that resolution here.
window.addEventListener("popstate", () => location.reload());

async function loadCtNotes() {
  _ctNotes = {};
  if (_drillId === "") {
    try {
      const res = await fetch("/api/notes?uncategorised=true", { headers: headers() });
      _ctNotes.untagged = res.ok ? await res.json() : [];
    } catch { _ctNotes.untagged = []; }
    return;
  }
  await Promise.all(_contentTypes.filter(ct => ct.kind === "notes").map(async ct => {
    try {
      const res = await fetch(`/api/content-types/${ct.id}/items`, { headers: headers() });
      _ctNotes[ct.id] = res.ok ? (await res.json()).notes : [];
    } catch { _ctNotes[ct.id] = []; }
  }));
}
window.reloadSidebarNotes = async () => {
  if (_drillId === null) return;
  await loadCtNotes();
  renderSidebar();
};

async function loadContentTypes(drillId) {
  if (drillId === null || drillId === "") { _contentTypes = []; return; }
  try {
    const res = await fetch(`/api/content-types?tag=${encodeURIComponent(drillId)}`, { headers: headers() });
    _contentTypes = res.ok ? await res.json() : [];
  } catch { _contentTypes = []; }
}

function bindRowMenus(ul) {
  ul.querySelectorAll(".row-overflow").forEach(btn => {
    btn.addEventListener("click", () => toggleRowMenu(btn));
  });
  ul.querySelectorAll('[data-action="rename"]').forEach(btn => {
    btn.addEventListener("click", () => {
      closeRowMenus();
      const t = _sidebarTags.find(x => x.id === Number(btn.dataset.id));
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
      const t = _sidebarTags.find(x => x.id === Number(btn.dataset.id));
      if (t) openTagDeleteModal(t.id, t.name);
    });
  });
}

function initSidebarBack() {
  const back = document.getElementById("sidebar-back");
  if (back) {
    back.addEventListener("click", () => {
      _drillId = null;
      renderSidebar("left");
    });
  }
  const newContent = document.getElementById("sidebar-new-content");
  if (newContent) newContent.addEventListener("click", () => window.createNoteInCategory?.());

  const title = document.getElementById("sidebar-cat-title");
  if (title) {
    title.addEventListener("click", ev => {
      ev.preventDefault();
      goCategoryOverview();
    });
  }
}

async function loadSidebarCats() {
  const ul = document.getElementById("sidebar-cats");
  if (!ul) return;
  try {
    const [tagsRes, uncatRes] = await Promise.all([
      fetch("/api/tags", { headers: headers() }),
      fetch("/api/links/uncategorised-count", { headers: headers() }),
    ]);
    if (!tagsRes.ok) return;
    _sidebarTags = await tagsRes.json();
    _uncatCount = (uncatRes.ok ? await uncatRes.json() : {}).count || 0;

    // land already drilled in when the page is scoped to one category
    if (VIEW.uncategorised) _drillId = "";
    else if (VIEW.tag) _drillId = String(VIEW.tag);
    _openNoteId = VIEW.note || null;

    await loadContentTypes(_drillId);
    await loadCtNotes();
    renderSidebar(_drillId === null ? undefined : "right");
  } catch {}
}

/* ── Content type view ───────────────────────────────────── */
function noteRow(note) {
  return `
    <div class="ov-row" onclick="window.openNoteById && window.openNoteById('${note.id}')">
      <span class="ov-title">${escHtml(note.title || "Untitled")}</span>
      <span class="ov-date">${friendlyDate(note.updated_at)}</span>
    </div>`;
}

let _ctData = null;                                  // the fetched bucket, unfiltered
let _ctFilter = { site: "", from: "", to: "" };

function ctFilterCount() {
  return [_ctFilter.site, _ctFilter.from, _ctFilter.to].filter(Boolean).length;
}

function filteredCtLinks() {
  const links = (_ctData && _ctData.links) || [];
  return links.filter(l => {
    if (_ctFilter.site && getDomain(l.url) !== _ctFilter.site) return false;
    // created_at is "YYYY-MM-DD HH:MM:SS", so a plain string compare on the date works
    const day = (l.created_at || "").slice(0, 10);
    if (_ctFilter.from && day < _ctFilter.from) return false;
    if (_ctFilter.to && day > _ctFilter.to) return false;
    return true;
  });
}

function ctFilterPanel() {
  const links = (_ctData && _ctData.links) || [];
  const counts = {};
  for (const l of links) {
    const d = getDomain(l.url);
    counts[d] = (counts[d] || 0) + 1;
  }
  const sites = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  const n = ctFilterCount();
  return `
    <div class="filter-wrap">
      <button type="button" class="btn-ghost filter-btn ${n ? "on" : ""}" id="ct-filter-btn">
        <i data-lucide="list-filter"></i> Filter${n ? ` · ${n}` : ""}
      </button>
      <div class="filter-panel" id="ct-filter-panel">
        <label class="add-field">
          <span>Website</span>
          <select id="filter-site" class="edit-tag-select">
            <option value="">All websites</option>
            ${sites.map(d => `
              <option value="${escHtml(d)}" ${_ctFilter.site === d ? "selected" : ""}>
                ${escHtml(d)} (${counts[d]})
              </option>`).join("")}
          </select>
        </label>
        <div class="filter-dates">
          <label class="add-field">
            <span>Saved from</span>
            <input type="date" id="filter-from" value="${_ctFilter.from}">
          </label>
          <label class="add-field">
            <span>Saved to</span>
            <input type="date" id="filter-to" value="${_ctFilter.to}">
          </label>
        </div>
        <div class="add-actions">
          <button type="button" class="btn-ghost" id="filter-clear">Clear</button>
          <button type="button" class="btn-primary" id="filter-apply">Apply</button>
        </div>
      </div>
    </div>`;
}

function bindCtFilter(pane, ctId) {
  const btn = pane.querySelector("#ct-filter-btn");
  const panel = pane.querySelector("#ct-filter-panel");
  if (!btn || !panel) return;

  const close = () => panel.classList.remove("open");
  btn.addEventListener("click", ev => {
    ev.stopPropagation();
    panel.classList.toggle("open");
  });
  panel.addEventListener("click", ev => ev.stopPropagation());
  document.addEventListener("click", close);

  pane.querySelector("#filter-apply").addEventListener("click", () => {
    _ctFilter = {
      site: pane.querySelector("#filter-site").value,
      from: pane.querySelector("#filter-from").value,
      to: pane.querySelector("#filter-to").value,
    };
    close();
    renderCtPane(ctId);
  });
  pane.querySelector("#filter-clear").addEventListener("click", () => {
    _ctFilter = { site: "", from: "", to: "" };
    close();
    renderCtPane(ctId);
  });
}

function renderCtPane(ctId) {
  const pane = document.getElementById("ct-pane");
  if (!pane || !_ctData) return;
  const ct = _ctData.content_type;
  const kind = ct.kind;
  const links = kind === "links" ? filteredCtLinks() : [];
  const n = ctFilterCount();

  const head = `
    <div class="ct-head">
      <h1>${escHtml(ct.title)}</h1>
      <span class="ct-kind">${KIND_LABEL[kind] || kind}</span>
      ${kind === "links" ? ctFilterPanel() : ""}
    </div>`;

  let body;
  if (kind === "links") {
    body = links.map(l => linkCardHtml(l)).join("")
      || `<div class="empty-state">${n ? "No links match that filter." : "No links in here yet."}</div>`;
    if (n) {
      body = `<div class="filter-summary">Showing ${links.length} of ${_ctData.links.length}</div>` + body;
    }
  } else {
    body = _ctData.notes.map(noteRow).join("")
      || '<div class="empty-state">No notes in here yet.</div>';
  }

  pane.innerHTML = head + body;
  bindLinkRowMenus(pane);
  if (kind === "links") bindCtFilter(pane, ctId);
  lucide.createIcons();
}

async function renderContentTypeView(ctId) {
  const pane = document.getElementById("ct-pane");
  if (!pane) return;
  pane.innerHTML = '<div class="loading-state">Loading…</div>';
  const res = await fetch(`/api/content-types/${ctId}/items`, { headers: headers() });
  if (!res.ok) { pane.innerHTML = '<div class="empty-state">Not found.</div>'; return; }
  _ctData = await res.json();
  _ctFilter = { site: "", from: "", to: "" };   // a fresh bucket starts unfiltered
  renderCtPane(ctId);
}

window.renderContentTypeView = renderContentTypeView;

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

/* ── Init ────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  loadSidebarCats();
  initSidebarResize();
  initSidebarBack();
  initAddPanel();

  const addUrl = new URLSearchParams(location.search).get("add");
  if (addUrl) {
    const clean = new URL(location.href);
    clean.searchParams.delete("add");
    history.replaceState({}, "", clean);
    openQuickAdd(addUrl);
  }

  if (document.getElementById("links-container")) {
    // scope the links list to whatever category the path resolved to
    if (VIEW.tag) {
      currentTag = String(VIEW.tag);
      fetch("/api/tags", { headers: headers() })
        .then(r => r.json())
        .then(tags => {
          const tag = tags.find(t => String(t.id) === String(VIEW.tag));
          if (tag) setPageTitle(tag.name);
        });
    } else if (VIEW.uncategorised) {
      currentUncat = true;
      setPageTitle("Untagged");
    }
    initSearch();
    loadLinks();
    updateCounts();
  }
  loadErrorLog();
  initSettingsTabs();
});
