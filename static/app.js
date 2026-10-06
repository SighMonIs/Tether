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
async function fetchLinks(tag, uncat) {
  let url = "/api/links";
  const params = new URLSearchParams();
  if (tag) params.set("tag", tag);
  if (uncat) params.set("uncategorised", "true");
  if (params.size) url += "?" + params.toString();
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return [];
  return res.json();
}

let _cachedLinks = [];

async function loadLinks() {
  _cachedLinks = await fetchLinks(currentTag, currentUncat);
  renderCurrentLinks();
}

function renderCurrentLinks() {
  renderCards(_cachedLinks);
}

async function updateCounts() {
  const counts = document.getElementById("link-counts");
  if (!counts) return;
  try {
    const all = await fetchLinks(currentTag, currentUncat);
    counts.textContent = `${all.length} total`;
  } catch {}
}

/* ── Render helpers ──────────────────────────────────────── */
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

function linkCardHtml(link, selectable = false) {
  const domain = escHtml(getDomain(link.url));
  return `
    <article class="link-row" data-id="${link.id}">
      ${selectable && _selectMode
        ? `<label class="link-pick">
             <input type="checkbox" class="link-check" value="${link.id}" ${_selected.has(link.id) ? "checked" : ""}>
           </label>`
        : `<span class="link-thumb">
             ${link.favicon_url ? `<img src="${escHtml(link.favicon_url)}" alt="" onerror="this.style.display='none'">` : ""}
           </span>`}
      <span class="link-main">
        <a class="link-title" href="${escHtml(link.url)}" target="_blank" rel="noopener">${escHtml(link.title || domain)}</a>
        <span class="link-url">${domain}</span>
      </span>
      ${link.note_id ? `
      <button class="link-note-btn" title="Open note" data-note-for="${link.id}" data-note-id="${link.note_id}">
        <i data-lucide="file-text"></i>
      </button>` : ""}
      <span class="link-meta">
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
// The top bar searches everything, wherever you are; results drop down under it
function initSearch() {
  const input = document.getElementById("search-input");
  if (!input) return;
  const panel = document.createElement("div");
  panel.className = "search-results";
  input.closest(".search-box").appendChild(panel);
  let seq = 0;
  const close = () => panel.classList.remove("open");

  const section = (label, rows) => rows.length
    ? `<div class="search-label">${label}</div>${rows.join("")}` : "";
  async function run() {
    const q = input.value.trim();
    if (!q) { close(); return; }
    const mine = ++seq;
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { headers: headers() });
    if (mine !== seq) return;                     // a newer keystroke won
    const { links, notes } = res.ok ? await res.json() : { links: [], notes: [] };
    panel.innerHTML = (section("Links", links.map(l => `
        <a class="search-row" href="${escHtml(l.url)}" target="_blank" rel="noopener">
          <i data-lucide="link"></i>
          <span class="search-title">${escHtml(l.title || getDomain(l.url))}</span>
          <span class="search-meta">${escHtml(l.tag_name || getDomain(l.url))}</span>
        </a>`)) +
      section("Notes", notes.map(n => `
        <a class="search-row" href="${escHtml(n.path)}" data-note="${n.id}" data-tag="${n.tag_id ?? ""}">
          <i data-lucide="file-text"></i>
          <span class="search-title">${escHtml(n.title || "Untitled")}</span>
          <span class="search-meta">${escHtml(n.tag_name || "Untagged")}</span>
        </a>`)))
      || `<div class="search-empty">Nothing matches "${escHtml(q)}"</div>`;
    panel.classList.add("open");
    lucide.createIcons();
  }

  input.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(run, 200);
  });
  input.addEventListener("focus", () => { if (input.value.trim()) run(); });
  input.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { close(); input.blur(); }
  });
  document.addEventListener("click", ev => { if (!ev.target.closest(".search-box")) close(); });
  panel.addEventListener("click", ev => {
    const a = ev.target.closest("a[data-note]");
    // a note opens in place when the Notes side is already on screen
    if (!a || MODE !== "notes" || !window.openNoteById || ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    close();
    setViewTag(a.dataset.tag);
    openSidebarTag(a.dataset.tag);
    if (location.pathname !== a.getAttribute("href")) history.pushState({}, "", a.getAttribute("href"));
    window.openNoteById(a.dataset.note);
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
    body: JSON.stringify({ name, color, kind: MODE }),
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
  const res = await fetch(`/api/tags?kind=${MODE}`, { headers: headers() });
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
    if (!await showConfirm("This permanently deletes every link and note in this tag. This can't be undone.", "Delete everything")) return;
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
  label.textContent = n ? `${n} tag${n === 1 ? "" : "s"} selected` : "All tags";
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

function copyText(id) {
  const text = document.getElementById(id)?.textContent.trim();
  if (!text) return;
  // navigator.clipboard only exists on HTTPS/localhost; the LAN address is plain HTTP
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast("Copied!")).catch(() => execCopy(text));
  } else {
    execCopy(text);
  }
}

function execCopy(text) {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.cssText = "position:fixed;top:0;left:0;width:2em;height:2em;opacity:0;";
  document.body.appendChild(el);
  el.focus();
  el.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  el.remove();
  toast(ok ? "Copied!" : "Copy failed");
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

/* ── Quick add (from share sheet) ────────────────────────── */
let _quickAddUrl = "";
let _quickAddMeta = {};

async function openQuickAdd(url) {
  _quickAddUrl = url;
  _quickAddMeta = {};
  document.getElementById("quick-add-note").value = "";
  document.getElementById("quick-add-form").style.display = "none";
  document.getElementById("quick-add-loading").style.display = "";
  document.getElementById("quick-add-modal").showModal();

  const [metaRes, tagsRes] = await Promise.all([
    fetch(`/api/metadata/preview?url=${encodeURIComponent(url)}`, { headers: headers() }),
    fetch("/api/tags", { headers: headers() }),
  ]);
  const meta = metaRes.ok ? await metaRes.json() : {};
  if (tagsRes.ok && !_sidebarTags.length) _sidebarTags = await tagsRes.json();

  _quickAddMeta = meta;
  document.getElementById("quick-add-favicon").src = meta.favicon_url || "";
  document.getElementById("quick-add-title").value = meta.title || getDomain(url);
  document.getElementById("quick-add-desc").value = meta.description || "";
  document.getElementById("quick-add-url").textContent = url;
  const catSelect = document.getElementById("quick-add-category");
  fillCategorySelect(catSelect, "");
  catSelect.insertAdjacentHTML("beforeend", `<option value="__new__">+ New tag…</option>`);
  document.getElementById("quick-add-new-cat").value = "";
  toggleQuickAddNewCat();

  document.getElementById("quick-add-loading").style.display = "none";
  document.getElementById("quick-add-form").style.display = "flex";
}

function toggleQuickAddNewCat() {
  const isNew = document.getElementById("quick-add-category").value === "__new__";
  const input = document.getElementById("quick-add-new-cat");
  input.style.display = isNew ? "" : "none";
  input.required = isNew;
  if (isNew) input.focus();
}

function quickAddCategory() {
  const id = document.getElementById("quick-add-category").value;
  const cat = _sidebarTags.find(t => String(t.id) === String(id));
  return cat ? [cat.name] : [];
}

async function submitQuickAdd(e) {
  e.preventDefault();
  // e.submitter is absent when the form is submitted other than by its button
  const btn = e.submitter || e.target.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

  // create the new category first so the link and its note both land in it
  const catSelect = document.getElementById("quick-add-category");
  if (catSelect.value === "__new__") {
    const tagRes = await fetch("/api/tags", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: document.getElementById("quick-add-new-cat").value.trim() }),
    });
    if (!tagRes.ok) {
      toast("Failed to create tag");
      if (btn) { btn.disabled = false; btn.textContent = "Save"; }
      return;
    }
    const tag = await tagRes.json();
    if (!_sidebarTags.some(t => t.id === tag.id)) _sidebarTags.push(tag);
    catSelect.insertAdjacentHTML("afterbegin", `<option value="${tag.id}">${escHtml(tag.name)}</option>`);
    catSelect.value = tag.id;
    toggleQuickAddNewCat();
  }

  const res = await fetch("/api/links", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      url: _quickAddUrl,
      title: document.getElementById("quick-add-title").value.trim(),
      description: document.getElementById("quick-add-desc").value.trim(),
      favicon_url: _quickAddMeta.favicon_url || "",
      tags: quickAddCategory(),
    }),
  });

  if (res.ok) {
    const { id } = await res.json();
    const noteText = document.getElementById("quick-add-note").value.trim();
    if (noteText && id) {
      const noteRes = await fetch("/api/notes", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          title: document.getElementById("quick-add-title").value.trim() || getDomain(_quickAddUrl),
          link_id: id,
          // the note belongs wherever the link was filed
          tag_id: Number(document.getElementById("quick-add-category").value) || null,
        }),
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

  if (btn) { btn.disabled = false; btn.textContent = "Save"; }
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
// every category picker is a plain single select now
function fillCategorySelect(el, selectedId) {
  if (!el) return;
  el.innerHTML = `<option value="">No tag</option>` +
    _sidebarTags.map(t =>
      `<option value="${t.id}" ${String(t.id) === String(selectedId) ? "selected" : ""}>${escHtml(t.name)}</option>`
    ).join("");
}

let _allTags  = []; // [{id, name, color}] from server

async function editLink(id) {
  const res = await fetch(`/api/links/${id}`, { headers: headers() });
  if (!res.ok) return;
  const link = await res.json();

  document.getElementById("edit-link-id").value = id;
  document.getElementById("edit-title").value = link.title || "";
  document.getElementById("edit-url").value = link.url || "";
  document.getElementById("edit-desc").value = link.description || "";
  fillCategorySelect(document.getElementById("edit-category"), link.tags[0]?.id);

  document.getElementById("edit-modal").showModal();
  setTimeout(() => document.getElementById("edit-title").focus(), 50);
}

async function saveLink(e) {
  e.preventDefault();
  const id = document.getElementById("edit-link-id").value;
  const catId = document.getElementById("edit-category").value;
  const cat = _sidebarTags.find(t => String(t.id) === String(catId));
  const res = await fetch(`/api/links/${id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({
      title: document.getElementById("edit-title").value.trim(),
      url: document.getElementById("edit-url").value.trim(),
      description: document.getElementById("edit-desc").value.trim(),
      tags: cat ? [cat.name] : [],
    }),
  });
  if (res.ok) {
    document.getElementById("edit-modal").close();
    await loadSidebarCats();
    if (typeof loadLinks === "function") await loadLinks();
    if (VIEW.ct) renderContentTypeView(VIEW.ct);
    toast("Link updated");
  }
}

/* ── Add link panel ──────────────────────────────────────── */
let _addMode = "one";        // "one" | "many"
let _addPanelMeta = {};      // favicon from the preview, carried to the save
let _addPreviewSeq = 0;      // ignore previews that resolve out of order

// the panel drops down from whichever + opened it
function openAddPanel(anchor = document.getElementById("topbar-add")) {
  const panel = document.getElementById("add-panel");
  if (!panel) return;
  panel.classList.add("open");
  const r = anchor.getBoundingClientRect();
  panel.style.top = `${r.bottom + 8}px`;
  panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))}px`;
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
  setAddMode("one");
}

function setAddMode(mode) {
  const panel = document.getElementById("add-panel");
  if (!panel) return;
  _addMode = mode;
  panel.querySelectorAll(".add-mode .toggle-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === mode));
  document.getElementById("add-mode-one").style.display = mode === "one" ? "" : "none";
  document.getElementById("add-mode-many").style.display = mode === "many" ? "" : "none";
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
  const tagId = document.getElementById("add-panel-category").value;
  const tag = _sidebarTags.find(t => String(t.id) === String(tagId));
  const category = tag ? [tag.name] : [];

  const urls = _addMode === "many"
    ? document.getElementById("add-panel-bulk").value.split(/[\n,]+/).map(u => u.trim()).filter(Boolean)
    : [document.getElementById("add-panel-url").value.trim()].filter(Boolean);
  if (!urls.length) return;

  btn.disabled = true;
  btn.textContent = urls.length > 1 ? "Saving…" : "Save";
  let saved = 0, dupes = 0;

  for (const url of urls) {
    // only the single-link form has title/description to send
    const extra = _addMode === "one" ? {
      title: document.getElementById("add-panel-title").value.trim(),
      description: document.getElementById("add-panel-desc").value.trim(),
      favicon_url: _addPanelMeta.favicon_url || "",
    } : {};
    const res = await fetch("/api/links", {
      method: "POST", headers: headers(),
      body: JSON.stringify({ url, tags: category, ...extra }),
    });
    if (res.ok) {
      const body = await res.json();
      body.duplicate ? dupes++ : saved++;
    }
  }

  btn.disabled = false;
  btn.textContent = "Save";
  closeAddPanel();
  if (urls.length === 1) toast(dupes ? "Already saved" : "Link saved");
  else toast(`Saved ${saved} of ${urls.length}${dupes ? ` · ${dupes} already there` : ""}`);

  await loadSidebarCats();
  if (typeof loadLinks === "function") await loadLinks();
  if (VIEW.ct) renderContentTypeView(VIEW.ct);
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
  panel.querySelectorAll(".add-mode .toggle-btn").forEach(b =>
    b.addEventListener("click", () => setAddMode(b.dataset.mode)));
  const url = document.getElementById("add-panel-url");
  url.addEventListener("change", previewAddPanelUrl);
  url.addEventListener("paste", () => setTimeout(previewAddPanelUrl, 0));
}

/* ── Tags sidebar ────────────────────────────────────────── */
// A flat list of tags. The Category sidebar (Links / Notes) picks which of the
// two each tag opens; the mode comes from the path the server resolved.
let _sidebarTags = [];
let _uncatCount = 0;
let _sidebarNotes = [];                 // Notes tab only: every note, grouped under its tag
let _openNoteId = VIEW.note || null;
const MODE = ["notes", "editor"].includes(VIEW.type) ? "notes" : "links";

/* ── Readable paths ──────────────────────────────────────── */
// The server resolves the path into ids before the page loads; from then on the
// front end builds the same paths back out of the slugs the API returns.

const MODE_ROOT = MODE === "notes" ? "/note" : "/link";

function tagPath(tagId) {
  if (tagId === "") return "untagged";
  const t = _sidebarTags.find(x => String(x.id) === String(tagId));
  return t ? t.path : "";
}

// tail is a note's slug, already prefixed with "/"
function categoryPath(tagId, tail = "") {
  const path = tagPath(tagId);
  return path ? `${MODE_ROOT}/${path}${tail}` : MODE_ROOT;
}

function folderSvg(color) {
  return `<svg class="sidebar-cat-folder" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
}

// the current tag, in categoryPath's terms: null = none, "" = Untagged
function currentTagId() {
  if (VIEW.uncategorised) return "";
  return VIEW.tag ? String(VIEW.tag) : null;
}

function renderSidebar() {
  const ul = document.getElementById("sidebar-cats");
  if (!ul) return;

  const activeTag = VIEW.tag ? String(VIEW.tag) : null;
  // chevron is a parent's toggle; other top-level rows get a spacer so names line up
  const row = (id, name, color, badge, menu, lead = "", cls = "") => `
    <li ${id === "" ? "" : `data-order="${id}"`} class="${cls}">
      ${lead}
      <a href="${categoryPath(id)}" ${id === "" ? "" : `data-cat="${id}"`}
         class="sidebar-cat-link ${!_openNoteId && (id === "" ? VIEW.uncategorised : activeTag === String(id)) ? "active" : ""}">
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

  const menuItem = (action, id, icon, label, extra = "") => `
    <button type="button" class="row-menu-item ${action === "delete" ? "danger" : ""}"
            data-action="${action}" data-id="${id}" ${extra}>
      <i data-lucide="${icon}"></i> ${label}
    </button>`;

  // a child whose parent is gone shows at the top level
  const isTop = t => !t.parent_id || !_sidebarTags.some(p => p.id === t.parent_id);
  const tops = _sidebarTags.filter(isTop);
  const kidsOf = id => _sidebarTags.filter(t => !isTop(t) && t.parent_id === id);
  const spacer = `<span class="tag-chevron-space"></span>`;

  // Links: only parents fold, open by default. Notes: every tag folds over its
  // notes, shut by default. Keys are tag ids, or "u" for Untagged.
  const folds = foldState();
  const isOpen = key => MODE === "notes" ? folds.has(key) : !folds.has(key);
  const chevron = key => `
    <button type="button" class="tag-chevron" data-toggle="${key}" title="${isOpen(key) ? "Collapse" : "Expand"}">
      <i data-lucide="${isOpen(key) ? "chevron-down" : "chevron-right"}"></i>
    </button>`;
  const notesOf = key => {
    if (MODE !== "notes") return "";
    const deep = _sidebarTags.some(t => t.id === key && !isTop(t)) ? "deep" : "";
    const tagId = key === "u" ? "" : key;
    return _sidebarNotes
      .filter(n => String(n.tag_id ?? "u") === String(key))
      .map(n => `
        <li class="sidebar-note ${deep}">
          <a href="${categoryPath(tagId, `/${n.slug}`)}" data-note="${n.id}" data-tag="${tagId}"
             class="sidebar-cat-link ${_openNoteId === n.id ? "active" : ""}">
            <i data-lucide="${n.link_id ? "link" : "file-text"}"></i>
            <span class="sidebar-cat-name">${escHtml(n.title || "Untitled")}</span>
          </a>
          <div class="row-menu-wrap">
            <button class="row-overflow" type="button" title="More">
              <i data-lucide="ellipsis-vertical"></i>
            </button>
            <div class="row-menu">
              <button type="button" class="row-menu-item" data-note-action="tag" data-id="${n.id}" data-tag="${tagId}">
                <i data-lucide="tag"></i> Change tag
              </button>
              <button type="button" class="row-menu-item danger" data-note-action="delete" data-id="${n.id}">
                <i data-lucide="trash-2"></i> Delete
              </button>
            </div>
          </div>
        </li>`).join("")
      || `<li class="sidebar-note sidebar-empty ${deep}">No notes</li>`;
  };

  const tagRow = (t, parentId, kids) => {
    // nesting is one level deep, so a parent can't become a child itself
    const above = tops[tops.indexOf(t) - 1];
    const nest = parentId != null
      ? menuItem("unnest", t.id, "corner-up-left", "Move out of parent")
      : (above && !kids.length
          ? menuItem("nest", t.id, "corner-down-right", "Child of above", `data-parent="${above.id}"`)
          : "");
    const lead = MODE === "notes" || kids.length ? chevron(t.id) : spacer;
    return row(t.id, escHtml(t.name), escHtml(t.color), "",
      menuItem("rename", t.id, "square-pen", "Edit") + nest +
      menuItem("export", t.id, "download", "Export data") +
      menuItem("delete", t.id, "trash-2", "Delete"),
      lead, parentId != null ? "tag-child" : "");
  };

  // ponytail: the badge counts untagged links only, so in Notes the row always shows
  const showUncat = MODE === "notes" || _uncatCount > 0;
  const withNotes = (key, html) => html + (isOpen(key) ? notesOf(key) : "");
  ul.innerHTML =
    (showUncat
      ? withNotes("u", row("", "Untagged", "var(--n-500)",
            MODE === "links" ? `<span class="sidebar-cat-badge">${_uncatCount}</span>` : "", "",
            MODE === "notes" ? chevron("u") : spacer))
      : "") +
    tops.map(t => {
      const kids = kidsOf(t.id);
      if (!isOpen(t.id)) return tagRow(t, null, kids);
      // child tags first, like folders above files
      return tagRow(t, null, kids) +
        kids.map(k => withNotes(k.id, tagRow(k, t.id, []))).join("") + notesOf(t.id);
    }).join("");

  ul.querySelectorAll("[data-toggle]").forEach(btn => {
    btn.addEventListener("click", () => toggleFold(btn.dataset.toggle === "u" ? "u" : Number(btn.dataset.toggle)));
  });
  // a tag swaps the content area in place: Links shows its links, Notes just
  // opens or closes the tag (its notes are right there in the sidebar)
  ul.querySelectorAll("a.sidebar-cat-link:not([data-note])").forEach(a => {
    a.addEventListener("click", ev => {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey || !document.getElementById("links-container")) return;
      ev.preventDefault();
      const id = a.dataset.cat ?? "";
      if (MODE === "notes") toggleFold(id === "" ? "u" : Number(id));
      else showLinksTag(id, a.getAttribute("href"));
    });
  });
  // the note menus need notes.js, which only the home page loads
  ul.querySelectorAll("[data-note-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      closeRowMenus();
      if (btn.dataset.noteAction === "tag") window.openNoteCategory?.(btn.dataset.id, btn.dataset.tag);
      else window.deleteNoteById?.(btn.dataset.id);
    });
  });
  // a note opens in the editor in place, whichever tag it's in
  ul.querySelectorAll("[data-note]").forEach(a => {
    a.addEventListener("click", ev => {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey || !window.openNoteById) return;
      ev.preventDefault();
      setViewTag(a.dataset.tag);
      if (location.pathname !== a.getAttribute("href")) history.pushState({}, "", a.getAttribute("href"));
      window.openNoteById(a.dataset.note);
    });
  });

  bindRowMenus(ul);
  initListDrag(ul, "[data-cat]", "cat", async ids => {
    await fetch("/api/tags/reorder", {
      method: "PATCH", headers: headers(),
      body: JSON.stringify({ order: ids.filter(Boolean).map(Number) }),
    });
    _sidebarTags.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id)));
    renderSidebar();
  });
  lucide.createIcons();
}

function toggleFold(key) {
  const folds = foldState();
  folds.has(key) ? folds.delete(key) : folds.add(key);
  saveFoldState(folds);
  renderSidebar();
}

// open a tag (and its parent) in the Notes sidebar so the note in it shows
function openSidebarTag(tagId) {
  const f = foldState();
  if (tagId === "") f.add("u");
  else {
    const t = _sidebarTags.find(x => String(x.id) === String(tagId));
    if (t) { f.add(t.id); if (t.parent_id) f.add(t.parent_id); }
  }
  saveFoldState(f);
}

// a new note lands in a tag: point the page at it and open it in the sidebar
window.showNoteTag = async tagId => {
  const id = tagId ? String(tagId) : "";
  setViewTag(id);
  openSidebarTag(id);
  await window.reloadSidebarNotes();
};

// tagId as the sidebar holds it: "" = Untagged, otherwise the id as a string
function setViewTag(tagId) {
  VIEW.tag = tagId === "" ? null : Number(tagId);
  VIEW.uncategorised = tagId === "";
  const t = _sidebarTags.find(x => String(x.id) === tagId);
  setPageTitle(t ? t.name : "Untagged");
}

async function showLinksTag(tagId, href) {
  setViewTag(tagId);
  if (location.pathname !== href) history.pushState({}, "", href);
  _openNoteId = null;
  renderSidebar();
  // a tag's links live in its links content type; Untagged has none, so it
  // uses the plain filtered list
  let ct = null;
  if (tagId !== "") {
    const res = await fetch(`/api/content-types?tag=${tagId}`, { headers: headers() });
    ct = (res.ok ? await res.json() : []).find(c => c.kind === "links") || null;
  }
  VIEW.ct = ct ? ct.id : null;
  VIEW.type = ct ? "ct" : "links";
  if (ct) { window.showContentTypeView?.(String(ct.id)); return; }
  currentTag = tagId === "" ? null : tagId;
  currentUncat = tagId === "";
  window.setShowingLinks?.(true);
  await loadLinks();
}

// Links keeps the parents folded shut, Notes the tags opened up — a per-browser
// convenience, so storage can fail
const FOLD_KEY = MODE === "notes" ? "openNoteTags" : "collapsedTags";
function foldState() {
  try { return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveFoldState(set) {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify([...set])); } catch {}
}

async function setTagParent(id, parentId) {
  const res = await fetch(`/api/tags/${id}`, {
    method: "PATCH", headers: headers(), body: JSON.stringify({ parent_id: parentId }),
  });
  if (!res.ok) { toast("Couldn't move that tag"); return; }
  if (parentId != null) {
    // open the parent so the tag doesn't vanish into a closed group
    const f = foldState();
    MODE === "notes" ? f.add(parentId) : f.delete(parentId);
    saveFoldState(f);
  }
  await loadSidebarCats();
}

/* ── Drag to reorder ─────────────────────────────────────── */
// Rows are dragged by their <li>; `sel` marks which rows take part, so the
// Untagged row stays put.
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

// the open note gets its own readable path when the page is scoped to a tag
window.setSidebarNote = (noteId, slug) => {
  if ((noteId || null) !== _openNoteId) {
    _openNoteId = noteId || null;
    renderSidebar();
  }
  const tag = currentTagId();
  if (!noteId || !slug || tag === null) return;
  const path = categoryPath(tag, `/${slug}`);
  if (location.pathname !== path) history.pushState({}, "", path);
};

// notes.js calls reloadSidebarNotes after a create, rename or delete
async function loadSidebarNotes() {
  if (MODE !== "notes") return;
  try {
    const res = await fetch("/api/notes", { headers: headers() });
    _sidebarNotes = res.ok ? await res.json() : [];
  } catch { _sidebarNotes = []; }
}
window.reloadSidebarNotes = async () => {
  await loadSidebarNotes();
  renderSidebar();
};

// The path is resolved server-side, so let a real load handle back/forward
// rather than duplicating that resolution here.
window.addEventListener("popstate", () => location.reload());

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
  ul.querySelectorAll('[data-action="nest"]').forEach(btn => {
    btn.addEventListener("click", () => {
      closeRowMenus();
      setTagParent(Number(btn.dataset.id), Number(btn.dataset.parent));
    });
  });
  ul.querySelectorAll('[data-action="unnest"]').forEach(btn => {
    btn.addEventListener("click", () => {
      closeRowMenus();
      setTagParent(Number(btn.dataset.id), null);
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

let _sidebarLoaded = false;
async function loadSidebarCats() {
  const ul = document.getElementById("sidebar-cats");
  if (!ul) return;
  try {
    const [tagsRes, uncatRes] = await Promise.all([
      fetch(`/api/tags?kind=${MODE}`, { headers: headers() }),
      fetch("/api/links/uncategorised-count", { headers: headers() }),
    ]);
    if (!tagsRes.ok) return;
    _sidebarTags = await tagsRes.json();
    // count is links + notes; the badge only sits on the Links side
    _uncatCount = (uncatRes.ok ? await uncatRes.json() : {}).links || 0;
    await loadSidebarNotes();
    if (MODE === "notes" && !_sidebarLoaded) {
      // land with the tag you're in (and its parent) opened up
      const f = foldState();
      const tag = currentTagId();
      if (tag === "") f.add("u");
      else if (tag !== null) {
        const t = _sidebarTags.find(x => String(x.id) === tag);
        if (t) { f.add(t.id); if (t.parent_id) f.add(t.parent_id); }
      }
      saveFoldState(f);
    }
    _sidebarLoaded = true;
    renderSidebar();
    // the links pane is headed by its tag's name, which may only now be known
    if (_ctData) renderCtPane(_ctData.content_type.id);
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

let _selectMode = false;
let _selected = new Set();

let _ctData = null;                                  // the fetched bucket, unfiltered
let _ctFilter = { sites: [], from: "", to: "" };

function ctFilterCount() {
  return (_ctFilter.sites.length ? 1 : 0) + [_ctFilter.from, _ctFilter.to].filter(Boolean).length;
}

function filteredCtLinks() {
  const links = (_ctData && _ctData.links) || [];
  return links.filter(l => {
    if (_ctFilter.sites.length && !_ctFilter.sites.includes(getDomain(l.url))) return false;
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
        <div class="add-field">
          <div class="filter-head">
            <span>Websites</span>
            <span class="filter-pick" id="site-pick"></span>
          </div>
          <div class="filter-sites">
            ${sites.map(d => `
              <label class="filter-site-row">
                <input type="checkbox" class="filter-site" value="${escHtml(d)}"
                       ${_ctFilter.sites.includes(d) ? "checked" : ""}>
                <span>${escHtml(d)}</span>
                <span class="filter-site-count">${counts[d]}</span>
              </label>`).join("")}
          </div>
          <p class="form-note">None ticked means every website.</p>
        </div>
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

// the Actions menu sits in the header's centre column
function ctActionsMenu() {
  if (!_selectMode) return "";
  const n = _selected.size;
  return `
    <div class="filter-wrap">
      <button type="button" class="btn-ghost" id="bulk-actions-btn" ${n ? "" : "disabled"}>
        Actions${n ? ` · ${n}` : ""} <i data-lucide="chevron-down"></i>
      </button>
      <div class="row-menu" id="bulk-actions-menu">
        <button type="button" class="row-menu-item" data-bulk="export">
          <i data-lucide="download"></i> Export selected
        </button>
        <button type="button" class="row-menu-item" data-bulk="category">
          <i data-lucide="tag"></i> Change tag
        </button>
        <button type="button" class="row-menu-item danger" data-bulk="delete">
          <i data-lucide="trash-2"></i> Delete
        </button>
      </div>
    </div>`;
}

// Select all grows leftwards from the checkbox, so the checkbox itself never moves
function ctSelectControls() {
  return `
    ${_selectMode ? `<button type="button" class="btn-ghost" id="select-all">Select all</button>` : ""}
    <label class="select-toggle" title="Select links">
      <input type="checkbox" id="select-mode" aria-label="Select links" ${_selectMode ? "checked" : ""}>
    </label>`;
}

function bindCtSelect(pane, ctId) {
  const toggle = pane.querySelector("#select-mode");
  if (toggle) {
    toggle.addEventListener("change", () => {
      _selectMode = toggle.checked;
      if (!_selectMode) _selected.clear();
      renderCtPane(ctId);
    });
  }
  if (!_selectMode) return;

  // only what the filter is currently showing
  pane.querySelector("#select-all")?.addEventListener("click", () => {
    const visible = filteredCtLinks().map(l => l.id);
    const allOn = visible.every(id => _selected.has(id));
    visible.forEach(id => allOn ? _selected.delete(id) : _selected.add(id));
    renderCtPane(ctId);
  });

  pane.querySelectorAll(".link-check").forEach(box => {
    box.addEventListener("change", () => {
      box.checked ? _selected.add(box.value) : _selected.delete(box.value);
      const btn = pane.querySelector("#bulk-actions-btn");
      if (btn) {
        btn.disabled = _selected.size === 0;
        btn.innerHTML = `Actions${_selected.size ? ` · ${_selected.size}` : ""} <i data-lucide="chevron-down"></i>`;
        lucide.createIcons();
      }
    });
  });

  const abtn = pane.querySelector("#bulk-actions-btn");
  const amenu = pane.querySelector("#bulk-actions-menu");
  if (abtn && amenu) {
    abtn.addEventListener("click", ev => { ev.stopPropagation(); toggleRowMenu(abtn); });
    amenu.addEventListener("click", ev => ev.stopPropagation());
    amenu.querySelectorAll("[data-bulk]").forEach(b => {
      b.addEventListener("click", () => {
        closeRowMenus();
        runBulkAction(b.dataset.bulk, ctId);
      });
    });
  }
}

function selectedLinks() {
  return ((_ctData && _ctData.links) || []).filter(l => _selected.has(l.id));
}

async function runBulkAction(action, ctId) {
  const links = selectedLinks();
  if (!links.length) return;

  if (action === "export") {
    // same shape as /api/export, built from what is already in hand
    const tags = [];
    const seen = new Set();
    const link_tags = [];
    for (const l of links) {
      for (const t of l.tags) {
        if (!seen.has(t.id)) { seen.add(t.id); tags.push(t); }
        link_tags.push({ link_id: l.id, tag_id: t.id });
      }
    }
    const payload = { version: 1, links: links.map(({ tags: _t, ...rest }) => rest), tags, link_tags };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tether-selection.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${links.length} link${links.length === 1 ? "" : "s"}`);
    return;
  }

  if (action === "category") {
    _bulkCtId = ctId;
    fillCategorySelect(document.getElementById("bulk-category-select"), "");
    document.getElementById("bulk-category-title").textContent =
      `Move ${links.length} link${links.length === 1 ? "" : "s"}`;
    document.getElementById("bulk-category-modal").showModal();
    return;
  }

  if (action === "delete") {
    const ok = await showConfirm(
      `Delete ${links.length} link${links.length === 1 ? "" : "s"}? This can't be undone.`);
    if (!ok) return;
    for (const l of links) {
      await fetch(`/api/links/${l.id}`, { method: "DELETE", headers: headers() });
    }
    _selected.clear();
    toast(`Deleted ${links.length}`);
    await loadSidebarCats();
    renderContentTypeView(ctId);
  }
}

let _bulkCtId = null;

async function submitBulkCategory(ev) {
  ev.preventDefault();
  const id = document.getElementById("bulk-category-select").value;
  const cat = _sidebarTags.find(t => String(t.id) === String(id));
  const links = selectedLinks();
  for (const l of links) {
    await fetch(`/api/links/${l.id}`, {
      method: "PATCH", headers: headers(),
      body: JSON.stringify({ tags: cat ? [cat.name] : [] }),
    });
  }
  document.getElementById("bulk-category-modal").close();
  _selected.clear();
  toast(`Moved ${links.length} link${links.length === 1 ? "" : "s"}`);
  await loadSidebarCats();
  renderContentTypeView(_bulkCtId);
}

function sitePickHtml(total, checked) {
  const all = `<button type="button" data-pick="all">All</button>`;
  const none = `<button type="button" data-pick="none">None</button>`;
  if (!total) return "";
  if (checked === 0) return all;
  if (checked === total) return none;
  return `${all}<span class="filter-pick-sep">/</span>${none}`;
}

function refreshSitePick(pane) {
  const el = pane.querySelector("#site-pick");
  if (!el) return;
  const boxes = [...pane.querySelectorAll(".filter-site")];
  el.innerHTML = sitePickHtml(boxes.length, boxes.filter(b => b.checked).length);
  el.querySelectorAll("[data-pick]").forEach(btn => {
    btn.addEventListener("click", () => {
      const on = btn.dataset.pick === "all";
      boxes.forEach(b => { b.checked = on; });
      refreshSitePick(pane);
    });
  });
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

  refreshSitePick(pane);
  pane.querySelectorAll(".filter-site").forEach(box =>
    box.addEventListener("change", () => refreshSitePick(pane)));

  pane.querySelector("#filter-apply").addEventListener("click", () => {
    _ctFilter = {
      sites: [...pane.querySelectorAll(".filter-site:checked")].map(c => c.value),
      from: pane.querySelector("#filter-from").value,
      to: pane.querySelector("#filter-to").value,
    };
    close();
    renderCtPane(ctId);
  });
  pane.querySelector("#filter-clear").addEventListener("click", () => {
    _ctFilter = { sites: [], from: "", to: "" };
    close();
    renderCtPane(ctId);
  });
}

function renderCtPane(ctId) {
  const pane = document.getElementById("ct-pane");
  if (!pane || !_ctData) return;
  const ct = _ctData.content_type;
  const kind = ct.kind;
  // headed by the tag it belongs to, not the bucket's own name ("Links")
  const heading = _sidebarTags.find(t => t.id === ct.tag_id)?.name || ct.title;
  const links = kind === "links" ? filteredCtLinks() : [];
  const n = ctFilterCount();

  const head = kind === "links" ? `
    <div class="ct-head">
      <h1>${escHtml(heading)}</h1>
      <div class="ct-head-mid">${ctActionsMenu()}</div>
      <div class="ct-head-right">
        ${ctSelectControls()}
        ${ctFilterPanel()}
      </div>
    </div>` : `
    <div class="ct-head"><h1>${escHtml(heading)}</h1></div>`;

  let body;
  if (kind === "links") {
    body = links.map(l => linkCardHtml(l, true)).join("")
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
  if (kind === "links") { bindCtFilter(pane, ctId); bindCtSelect(pane, ctId); }
  lucide.createIcons();
}

async function renderContentTypeView(ctId) {
  const pane = document.getElementById("ct-pane");
  if (!pane) return;
  pane.innerHTML = '<div class="loading-state">Loading…</div>';
  const res = await fetch(`/api/content-types/${ctId}/items`, { headers: headers() });
  if (!res.ok) { pane.innerHTML = '<div class="empty-state">Not found.</div>'; return; }
  _ctData = await res.json();
  _ctFilter = { sites: [], from: "", to: "" };   // a fresh bucket starts unfiltered
  _selectMode = false;
  _selected.clear();
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
      fetch("/api/tags?kind=all", { headers: headers() })
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
