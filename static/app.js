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
          <button type="button" class="row-menu-item" onclick="openAddToProject('link', ['${link.id}'])">
            <i data-lucide="folder-kanban"></i> Add to project
          </button>
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
  root.querySelectorAll(":is(.link-row, .picture-tile) .row-overflow").forEach(btn => {
    btn.addEventListener("click", () => toggleRowMenu(btn));
  });
  root.querySelectorAll("[data-note-for]").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      openNoteForLink(btn.dataset.noteFor, btn.dataset.noteId);
    });
  });
  root.querySelectorAll(":is(.link-row, .picture-tile) .row-menu-item").forEach(btn => {
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
// The rail's search button searches everything, wherever you are
function initSearch() {
  const input = document.getElementById("search-input");
  if (!input) return;
  const pop = document.getElementById("search-pop");
  const btn = document.getElementById("search-btn");
  const hide = () => { pop.classList.remove("open"); close(); };
  btn.addEventListener("click", ev => {
    ev.stopPropagation();
    if (pop.classList.contains("open")) return hide();
    pop.classList.add("open");
    placeBeside(pop, btn);
    input.focus();
  });
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
    const { links = [], notes = [], pictures = [], projects = [] } = res.ok ? await res.json() : {};
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
        </a>`)) +
      section("Images", pictures.map(p => `
        <a class="search-row" href="/api/pictures/${p.id}/file" target="_blank" rel="noopener">
          <i data-lucide="image"></i>
          <span class="search-title">${escHtml(p.title || "Image")}</span>
          <span class="search-meta">${escHtml(p.tag_name || "Untagged")}</span>
        </a>`)) +
      section("Projects", projects.map(p => `
        <a class="search-row" href="/project/${escHtml(p.slug)}">
          <i data-lucide="folder-kanban"></i>
          <span class="search-title">${escHtml(p.name)}</span>
          <span class="search-meta">${plural(p.count, "item")}</span>
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
    if (ev.key === "Escape") { hide(); input.blur(); }
  });
  document.addEventListener("click", ev => { if (!ev.target.closest(".search-box")) hide(); });
  panel.addEventListener("click", ev => {
    const a = ev.target.closest("a[data-note]");
    // a note opens in place when the Notes side is already on screen
    if (!a || MODE !== "notes" || !window.openNoteById || ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    hide();
    setViewTag(a.dataset.tag);
    openSidebarTag(a.dataset.tag);
    if (location.pathname !== a.getAttribute("href")) history.pushState({}, "", a.getAttribute("href"));
    window.openNoteById(a.dataset.note);
  });
}

/* ── Categories page ─────────────────────────────────────── */
function openNewTagModal() {
  const sel = document.getElementById("new-tag-parent");
  if (sel) {
    // one level deep, so only top-level tags can be parents; open on a tag's page, that tag is the default
    const tops = _sidebarTags.filter(t => !t.parent_id);
    const here = tops.find(t => String(t.id) === currentTagId());
    sel.innerHTML = `<option value="">None (top level)</option>` + tops
      .map(p => `<option value="${p.id}" ${p === here ? "selected" : ""}>${escHtml(p.name)}</option>`).join("");
    sel.closest(".form-group").hidden = !tops.length;
  }
  document.getElementById("new-tag-modal")?.showModal();
  setTimeout(() => document.getElementById("new-tag-name")?.focus(), 50);
}

// on a tag's page the dialog also handles nesting, export and delete;
// settings has its own buttons for those, so they only show here
function openEditTag(id, name, color) {
  document.getElementById("edit-tag-id").value = id;
  document.getElementById("edit-tag-name").value = name;
  document.getElementById("edit-tag-color").value = color;
  const t = _sidebarTags.find(x => x.id === Number(id));
  document.querySelectorAll(".edit-tag-extra").forEach(el => { el.hidden = !t; });
  if (t) {
    // one level deep: only top-level tags can be parents, and a parent can't become a child
    const hasKids = _sidebarTags.some(x => x.parent_id === t.id);
    const sel = document.getElementById("edit-tag-parent");
    sel.innerHTML = `<option value="">None (top level)</option>` + _sidebarTags
      .filter(x => !x.parent_id && x.id !== t.id)
      .map(p => `<option value="${p.id}" ${p.id === t.parent_id ? "selected" : ""}>${escHtml(p.name)}</option>`)
      .join("");
    sel.disabled = hasKids;
    sel.title = hasKids ? "This tag has children of its own" : "";
  }
  document.getElementById("edit-tag-modal").showModal();
  setTimeout(() => document.getElementById("edit-tag-name")?.focus(), 50);
}

async function saveTag(e) {
  e.preventDefault();
  const id = document.getElementById("edit-tag-id").value;
  const name = document.getElementById("edit-tag-name").value.trim();
  const color = document.getElementById("edit-tag-color").value;
  if (!name) return;
  const body = { name, color };
  const t = _sidebarTags.find(x => x.id === Number(id));
  const parent = document.getElementById("edit-tag-parent");
  if (t && !parent.disabled) body.parent_id = parent.value ? Number(parent.value) : null;
  const res = await fetch(`/api/tags/${id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { toast("Couldn't save that tag"); return; }
  document.getElementById("edit-tag-modal").close();
  toast("Tag updated");
  if (!t) { setTimeout(() => location.reload(), 400); return; }
  if (body.parent_id) {
    // open the parent so the tag doesn't vanish into a closed group
    const f = foldState();
    MODE === "notes" ? f.add(body.parent_id) : f.delete(body.parent_id);
    saveFoldState(f);
  }
  // a rename or move changes the tag's path, so follow it rather than reload into a redirect
  await loadSidebarCats();
  const tag = currentTagId();
  if (tag !== null) {
    history.replaceState({}, "", categoryPath(tag));
    setViewTag(tag);
  }
}

function exportEditedTag() {
  doExport("all", document.getElementById("edit-tag-id").value);
}

function deleteEditedTag() {
  document.getElementById("edit-tag-modal").close();
  openTagDeleteModal(Number(document.getElementById("edit-tag-id").value),
    document.getElementById("edit-tag-name").value);
}

async function createTag(e) {
  e.preventDefault();
  const name = document.getElementById("new-tag-name").value.trim();
  const color = document.getElementById("new-tag-color").value;
  const parent = document.getElementById("new-tag-parent")?.value;
  if (!name) return;
  const res = await fetch("/api/tags", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name, color, kind: MODE, parent_id: parent ? Number(parent) : null }),
  });
  if (!res.ok) { toast("Couldn't create that tag"); return; }
  if (parent) {
    // open the parent so the new tag doesn't land in a closed group
    const f = foldState();
    MODE === "notes" ? f.add(Number(parent)) : f.delete(Number(parent));
    saveFoldState(f);
  }
  toast("Tag Created");
  setTimeout(() => location.reload(), 500);
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
  // the doomed tag's children stay listed; with it gone they show at the top level
  const moveOptions = `<option value="">Untagged</option>` + tagOptions(tags.filter(t => t.id !== id));
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
  fillCategorySelect(catSelect, "", "No tag", false);   // quick add has its own new-tag field
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
// every category picker is a plain single select now; children sit under
// their parent, indented with nbsp since iOS ignores padding on <option>
function tagOptions(tags, selectedId) {
  const isTop = t => !t.parent_id || !tags.some(p => p.id === t.parent_id);
  const opt = (t, pad) =>
    `<option value="${t.id}" ${String(t.id) === String(selectedId) ? "selected" : ""}>${pad}${escHtml(t.name)}</option>`;
  return tags.filter(isTop).map(p =>
    opt(p, "") + tags.filter(t => !isTop(t) && t.parent_id === p.id)
      .map(t => opt(t, "&nbsp;&nbsp;&nbsp;&nbsp;")).join("")
  ).join("");
}

function fillCategorySelect(el, selectedId, emptyLabel = "No tag", withNew = true) {
  if (!el) return;
  el.innerHTML = `<option value="">${emptyLabel}</option>` + tagOptions(_sidebarTags, selectedId)
    + (withNew ? newTagOption() : "");
  el.dataset.prev = el.value;
}

// every tag picker ends with "+ New tag…": picking it asks for a name, makes the tag and selects it.
// The tag is made in the picker's data-tag-kind, else the side you're on.
const NEW_TAG = "__newtag__";
const newTagOption = () => `<option value="${NEW_TAG}">+ New tag…</option>`;
window.newTagOption = newTagOption;

// capture runs before the picker's own change listeners, so they never see the placeholder value
document.addEventListener("change", async ev => {
  const el = ev.target;
  if (!(el instanceof HTMLSelectElement)) return;
  if (el.value !== NEW_TAG) { el.dataset.prev = el.value; return; }
  ev.stopImmediatePropagation();
  const back = () => { el.value = el.dataset.prev ?? el.options[0]?.value ?? ""; };
  // ponytail: native prompt; swap for a dialog if it looks out of place
  const name = prompt("New tag name")?.trim();
  if (!name) return back();
  const kind = el.dataset.tagKind || MODE;
  const res = await fetch("/api/tags", { method: "POST", headers: headers(), body: JSON.stringify({ name, kind }) });
  if (!res.ok) { toast("Couldn't create that tag"); return back(); }
  const tag = await res.json();
  if (!el.querySelector(`option[value="${tag.id}"]`)) {
    el.querySelector(`option[value="${NEW_TAG}"]`).insertAdjacentHTML("beforebegin",
      `<option value="${tag.id}">${escHtml(tag.name)}</option>`);
  }
  el.value = el.dataset.prev = String(tag.id);
  // savers look tags up in _sidebarTags; a tag for this side also shows in the sidebar
  if (kind === MODE) await loadSidebarCats();
  else if (!_sidebarTags.some(t => t.id === tag.id)) _sidebarTags.push(tag);
  document.dispatchEvent(new CustomEvent("tether:tag-created", { detail: tag }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}, true);

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

// popovers open beside a rail button, or drop down from anything else
function placeBeside(panel, anchor) {
  const r = anchor.getBoundingClientRect();
  const rail = anchor.closest(".rail");
  panel.style.top = `${rail ? r.top : r.bottom + 8}px`;
  const left = rail ? r.right + 10 : r.left;
  panel.style.left = `${Math.max(8, Math.min(left, window.innerWidth - panel.offsetWidth - 8))}px`;
}

// the panel opens from whichever + opened it
function openAddPanel(anchor = document.getElementById("rail-add")) {
  const panel = document.getElementById("add-panel");
  if (!panel) return;
  panel.classList.add("open");
  placeBeside(panel, anchor);
  fillCategorySelect(document.getElementById("add-panel-category"), VIEW.tag, "Untagged");
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
  const btn = document.getElementById("rail-add");
  const panel = document.getElementById("add-panel");
  if (!btn || !panel) return;
  btn.addEventListener("click", ev => {
    ev.stopPropagation();
    if (MODE === "pictures") return pickPictures();
    if (MODE === "projects") return openProjectModal();
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
// Links, Notes and Pictures each have their own tags; Projects lists projects instead
const MODE = { notes: "notes", editor: "notes", pictures: "pictures", projects: "projects" }[VIEW.type] || "links";

/* ── Readable paths ──────────────────────────────────────── */
// The server resolves the path into ids before the page loads; from then on the
// front end builds the same paths back out of the slugs the API returns.

const MODE_ROOT = { links: "/link", notes: "/note", pictures: "/picture", projects: "/project" }[MODE];

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

// sub-notes follow their parent; one whose parent isn't in the list shows at the top level
function nestNotes(notes) {
  const ids = new Set(notes.map(n => n.id));
  const isTop = n => !n.parent_id || !ids.has(n.parent_id);
  return notes.filter(isTop).flatMap(p => [
    { ...p, _sub: false, _kids: notes.filter(k => !isTop(k) && k.parent_id === p.id).length },
    ...notes.filter(k => !isTop(k) && k.parent_id === p.id).map(k => ({ ...k, _sub: true, _kids: 0 })),
  ]);
}
window.nestNotes = nestNotes;

// a note with sub-notes folds over them, open by default
const SUBNOTE_FOLD_KEY = "closedNoteParents";
function closedNoteParents() {
  try { return new Set(JSON.parse(localStorage.getItem(SUBNOTE_FOLD_KEY) || "[]")); }
  catch { return new Set(); }
}
function toggleNoteFold(id) {
  const s = closedNoteParents();
  s.has(id) ? s.delete(id) : s.add(id);
  try { localStorage.setItem(SUBNOTE_FOLD_KEY, JSON.stringify([...s])); } catch {}
  renderSidebar();
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
  if (MODE === "projects") return renderProjectSidebar(ul);

  const activeTag = VIEW.tag ? String(VIEW.tag) : null;
  // chevron is a parent's toggle, at the row's right end; other rows get a spacer so the ⋮ lines up
  const row = (id, name, color, badge, fold = "", cls = "") => `
    <li ${id === "" ? "" : `data-order="${id}"`} class="${cls}">
      <a href="${categoryPath(id)}" ${id === "" ? "" : `data-cat="${id}"`}
         class="sidebar-cat-link ${!_openNoteId && (id === "" ? VIEW.uncategorised : activeTag === String(id)) ? "active" : ""}">
        ${folderSvg(color)}
        <span class="sidebar-cat-name">${name}</span>
        ${badge}
      </a>
      ${fold}
    </li>`;

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
    const closed = closedNoteParents();
    return nestNotes(_sidebarNotes.filter(n => String(n.tag_id ?? "u") === String(key)))
      .filter(n => !n._sub || !closed.has(n.parent_id))
      .map(n => `
        <li class="sidebar-note ${deep} ${n._sub ? "sub" : ""}">
          <a href="${categoryPath(tagId, `/${n.slug}`)}" data-note="${n.id}" data-tag="${tagId}"
             class="sidebar-cat-link ${_openNoteId === n.id ? "active" : ""}">
            <i data-lucide="${n.link_id ? "link" : "file-text"}"></i>
            <span class="sidebar-cat-name">${escHtml(n.title || "Untitled")}</span>
          </a>
          ${n._kids ? `
          <button type="button" class="tag-chevron" data-note-toggle="${n.id}" title="${closed.has(n.id) ? "Expand" : "Collapse"}">
            <i data-lucide="${closed.has(n.id) ? "chevron-right" : "chevron-down"}"></i>
          </button>` : ""}
        </li>`).join("")
      || `<li class="sidebar-note sidebar-empty ${deep}">No notes</li>`;
  };

  // editing a tag (name, parent, export, delete) lives behind the pencil on its page
  const tagRow = (t, parentId, kids) => {
    const fold = MODE === "notes" || kids.length ? chevron(t.id) : spacer;
    return row(t.id, escHtml(t.name), escHtml(t.color), "", fold, parentId != null ? "tag-child" : "");
  };

  // ponytail: the badge counts untagged links only, so in Notes the row always shows
  const showUncat = MODE !== "links" || _uncatCount > 0;
  const withNotes = (key, html) => html + (isOpen(key) ? notesOf(key) : "");
  ul.innerHTML =
    (showUncat
      ? withNotes("u", row("", "Untagged", "var(--n-500)",
            MODE === "links" ? `<span class="sidebar-cat-badge">${_uncatCount}</span>` : "",
            MODE === "notes" ? chevron("u") : spacer))
      : "") +
    tops.map(t => {
      const kids = kidsOf(t.id);
      if (!isOpen(t.id)) return tagRow(t, null, kids);
      // child tags first, like folders above files
      return tagRow(t, null, kids) +
        kids.map(k => withNotes(k.id, tagRow(k, t.id, []))).join("") + notesOf(t.id);
    }).join("");

  ul.querySelectorAll("[data-note-toggle]").forEach(btn => {
    btn.addEventListener("click", () => toggleNoteFold(btn.dataset.noteToggle));
  });
  ul.querySelectorAll("[data-toggle]").forEach(btn => {
    btn.addEventListener("click", () => toggleFold(btn.dataset.toggle === "u" ? "u" : Number(btn.dataset.toggle)));
  });
  // a tag swaps the content area in place for its page of links or notes
  ul.querySelectorAll("a.sidebar-cat-link:not([data-note])").forEach(a => {
    a.addEventListener("click", ev => {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey || !document.getElementById("links-container")) return;
      ev.preventDefault();
      const id = a.dataset.cat ?? "";
      // every click folds or unfolds the tag, as well as showing its page
      const key = id === "" ? "u" : Number(id);
      if (MODE === "notes" || _sidebarTags.some(t => t.parent_id === key)) {
        const f = foldState();
        f.has(key) ? f.delete(key) : f.add(key);
        saveFoldState(f);
      }
      if (MODE === "links") showLinksTag(id, a.getAttribute("href"));
      else showNotesTag(id, a.getAttribute("href"));
    });
  });
  bindNoteLinks(ul);
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

// a note opens in the editor in place, whichever tag it's in
function bindNoteLinks(root) {
  root.querySelectorAll("a[data-note]").forEach(a => {
    a.addEventListener("click", ev => {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey || !window.openNoteById) return;
      ev.preventDefault();
      setViewTag(a.dataset.tag);
      if (location.pathname !== a.getAttribute("href")) history.pushState({}, "", a.getAttribute("href"));
      window.openNoteById(a.dataset.note);
    });
  });
}

window.showNotesTag = showNotesTag;
window.categoryPath = categoryPath;
function showNotesTag(tagId, href) {
  // already on this tag's page: only the fold changed
  if (currentTagId() === tagId && !_openNoteId) { renderSidebar(); return; }
  setViewTag(tagId);
  if (location.pathname !== href) history.pushState({}, "", href);
  _openNoteId = null;
  renderSidebar();
  window.showNotesTagView?.();
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
  // before the tags load there's no path to build; the server's path still stands
  if (!noteId || !slug || tag === null || !tagPath(tag)) return;
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

let _sidebarLoaded = false;
async function loadSidebarCats() {
  const ul = document.getElementById("sidebar-cats");
  if (!ul) return;
  if (MODE === "projects") {
    const res = await fetch("/api/projects", { headers: headers() });
    _projects = res.ok ? await res.json() : [];
    return renderSidebar();
  }
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
// a note on its tag's page, laid out like a link row
function noteCardHtml(n) {
  const tagId = n.tag_id ? String(n.tag_id) : "";
  return `
    <article class="link-row ${n._sub ? "sub-note" : ""}" data-id="${n.id}">
      ${_selectMode
        ? `<label class="link-pick">
             <input type="checkbox" class="link-check" value="${n.id}" ${_selected.has(n.id) ? "checked" : ""}>
           </label>`
        : `<span class="link-thumb"><i data-lucide="${n.link_id ? "link" : "file-text"}"></i></span>`}
      <span class="link-main">
        <a class="link-title" href="${categoryPath(tagId, `/${n.slug}`)}" data-note="${n.id}" data-tag="${tagId}">${escHtml(n.title || "Untitled")}</a>
        <span class="link-url">Edited ${friendlyDate(n.updated_at)}</span>
      </span>
      <span class="link-meta">
        <span class="link-date">${friendlyDate(n.created_at)}</span>
      </span>
      <div class="row-menu-wrap">
        <button class="row-overflow" type="button" title="More"><i data-lucide="ellipsis-vertical"></i></button>
        <div class="row-menu">
          <button type="button" class="row-menu-item" onclick="openAddToProject('note', ['${n.id}'])">
            <i data-lucide="folder-kanban"></i> Add to project
          </button>
        </div>
      </div>
    </article>`;
}

let _selectMode = false;
let _selected = new Set();

let _ctData = null;                                  // the fetched bucket, unfiltered
let _ctReload = () => {};                            // refetches whichever page is showing
const ctKind = () => (_ctData && _ctData.content_type.kind) || "links";
const ctItems = () => (_ctData && _ctData[ctKind()]) || [];
let _ctFilter = { sites: [], from: "", to: "" };

function ctFilterCount() {
  return (_ctFilter.sites.length ? 1 : 0) + [_ctFilter.from, _ctFilter.to].filter(Boolean).length;
}

function filteredCtItems() {
  return ctItems().filter(l => {
    if (_ctFilter.sites.length && l.url && !_ctFilter.sites.includes(getDomain(l.url))) return false;
    // created_at is "YYYY-MM-DD HH:MM:SS", so a plain string compare on the date works
    const day = (l.created_at || "").slice(0, 10);
    if (_ctFilter.from && day < _ctFilter.from) return false;
    if (_ctFilter.to && day > _ctFilter.to) return false;
    return true;
  });
}

// notes have no website, so their filter is just the dates
function ctFilterPanel() {
  const links = (_ctData && _ctData.links) || [];
  const noun = ctKind() === "notes" ? "Created" : "Saved";
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
        ${sites.length ? `<div class="add-field">
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
        </div>` : ""}
        <div class="filter-dates">
          <label class="add-field">
            <span>${noun} from</span>
            <input type="date" id="filter-from" value="${_ctFilter.from}">
          </label>
          <label class="add-field">
            <span>${noun} to</span>
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
        ${ctKind() === "links" ? `<button type="button" class="row-menu-item" data-bulk="export">
          <i data-lucide="download"></i> Export selected
        </button>` : ""}
        <button type="button" class="row-menu-item" data-bulk="project">
          <i data-lucide="folder-kanban"></i> Add to project
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
  const label = `Select ${ctKind()}`;
  return `
    ${_selectMode ? `<button type="button" class="btn-ghost" id="select-all">Select all</button>` : ""}
    <label class="select-toggle" title="${label}">
      <input type="checkbox" id="select-mode" aria-label="${label}" ${_selectMode ? "checked" : ""}>
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
    const visible = filteredCtItems().map(l => l.id);
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

function selectedItems() {
  return ctItems().filter(l => _selected.has(l.id));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const itemWord = () => ({ links: "link", notes: "note", pictures: "image" })[ctKind()];

async function runBulkAction(action, ctId) {
  const links = selectedItems();
  if (!links.length) return;
  const word = itemWord();

  if (action === "project") return openAddToProject(word, links.map(l => l.id));

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
    document.getElementById("bulk-category-title").textContent = `Move ${plural(links.length, word)}`;
    document.getElementById("bulk-category-modal").showModal();
    return;
  }

  if (action === "delete") {
    const ok = await showConfirm(`Delete ${plural(links.length, word)}? This can't be undone.`);
    if (!ok) return;
    for (const l of links) {
      await fetch(`/api/${word}s/${l.id}`, { method: "DELETE", headers: headers() });
    }
    _selected.clear();
    toast(`Deleted ${links.length}`);
    await loadSidebarCats();
    _ctReload();
  }
}

let _bulkCtId = null;

async function submitBulkCategory(ev) {
  ev.preventDefault();
  const id = document.getElementById("bulk-category-select").value;
  const cat = _sidebarTags.find(t => String(t.id) === String(id));
  const items = selectedItems();
  const byId = ctKind() !== "links";
  for (const l of items) {
    // a note or picture takes the tag's id (0 = none), a link the tag's name
    await fetch(`/api/${ctKind()}/${l.id}`, {
      method: "PATCH", headers: headers(),
      body: JSON.stringify(byId ? { tag_id: cat ? cat.id : 0 } : { tags: cat ? [cat.name] : [] }),
    });
  }
  document.getElementById("bulk-category-modal").close();
  _selected.clear();
  toast(`Moved ${plural(items.length, itemWord())}`);
  await loadSidebarCats();
  _ctReload();
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
  const tag = _sidebarTags.find(t => t.id === ct.tag_id);
  const heading = tag?.name || ct.title;
  const items = filteredCtItems();
  const n = ctFilterCount();

  const head = `
    <div class="ct-head">
      <div class="ct-title">
        <h1>${escHtml(heading)}</h1>
        ${tag ? `<button type="button" class="ct-edit" id="ct-edit-tag" title="Edit tag"><i data-lucide="pencil"></i></button>` : ""}
      </div>
      <div class="ct-head-mid">${ctActionsMenu()}</div>
      <div class="ct-head-right">
        ${kind === "pictures" ? `<button type="button" class="btn-ghost" id="ct-upload"><i data-lucide="image-plus"></i> Upload</button>` : ""}
        ${ctSelectControls()}
        ${ctFilterPanel()}
      </div>
    </div>`;

  let body = kind === "pictures"
    ? (items.length ? `<div class="picture-grid">${items.map(pictureCardHtml).join("")}</div>` : "")
    : kind === "notes" ? nestNotes(items).map(noteCardHtml).join("")
    : items.map(l => linkCardHtml(l, true)).join("");
  body = body || `<div class="empty-state">${n ? `No ${kind === "pictures" ? "images" : kind} match that filter.`
    : kind === "pictures" ? "No images in here yet. Upload some, paste a screenshot, or drop files here."
    : `No ${kind} in here yet.`}</div>`;
  if (n) body = `<div class="filter-summary">Showing ${items.length} of ${ctItems().length}</div>` + body;

  pane.innerHTML = head + body;
  bindLinkRowMenus(pane);
  bindNoteLinks(pane);
  bindCtFilter(pane, ctId);
  bindCtSelect(pane, ctId);
  pane.querySelector("#ct-edit-tag")?.addEventListener("click", () => openEditTag(tag.id, tag.name, tag.color));
  pane.querySelector("#ct-upload")?.addEventListener("click", pickPictures);
  pane.querySelectorAll("[data-image]").forEach(a => a.addEventListener("click", ev => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey) return;   // let a new tab open the page
    ev.preventDefault();
    // while selecting, the whole image ticks its box instead of opening it
    if (_selectMode) return a.closest(".picture-tile").querySelector(".link-check")?.click();
    history.pushState({}, "", a.href);
    renderImagePage(a.dataset.image);
  }));
  lucide.createIcons();
}

async function renderContentTypeView(ctId) {
  const pane = document.getElementById("ct-pane");
  if (!pane) return;
  pane.innerHTML = '<div class="loading-state">Loading…</div>';
  const res = await fetch(`/api/content-types/${ctId}/items`, { headers: headers() });
  if (!res.ok) { pane.innerHTML = '<div class="empty-state">Not found.</div>'; return; }
  _ctData = await res.json();
  _ctReload = () => renderContentTypeView(ctId);
  _ctFilter = { sites: [], from: "", to: "" };   // a fresh bucket starts unfiltered
  _selectMode = false;
  _selected.clear();
  renderCtPane(ctId);
}

window.renderContentTypeView = renderContentTypeView;

// a Notes or Pictures tag's page: the same pane, listing what's in the tag on screen.
// Pictures with no tag picked shows every picture, like Links does.
async function renderTagPage() {
  if (MODE === "projects") return renderProjectPage();
  if (MODE === "pictures" && openImageId()) return renderImagePage(openImageId());
  const pane = document.getElementById("ct-pane");
  const tag = currentTagId();
  if (!pane || (tag === null && MODE !== "pictures")) return;
  pane.innerHTML = '<div class="loading-state">Loading…</div>';
  const qs = tag === null ? "" : tag === "" ? "uncategorised=true" : `tag=${tag}`;
  const res = await fetch(`/api/${MODE}?${qs}`, { headers: headers() });
  if (currentTagId() !== tag) return;            // moved on while this loaded
  if (tag === null) setPageTitle("Images");
  _ctData = {
    content_type: { id: null, kind: MODE, tag_id: tag ? Number(tag) : null,
                    title: tag === null ? "All images" : "Untagged" },
    links: [], notes: [], pictures: [],
    [MODE]: res.ok ? await res.json() : [],
  };
  _ctReload = renderTagPage;
  _ctFilter = { sites: [], from: "", to: "" };
  _selectMode = false;
  _selected.clear();
  renderCtPane(null);
}

window.renderTagPage = renderTagPage;

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
  const sidebarReady = loadSidebarCats();
  initPictureDrop();
  // the Shortcut lands here after an upload, so the picture can be tagged
  const editPic = MODE === "pictures" && new URLSearchParams(location.search).get("edit");
  if (editPic) {
    history.replaceState({}, "", location.pathname);
    sidebarReady.then(() => openEditPicture(editPic));
  }
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

/* ── Pictures ────────────────────────────────────────────── */
function pictureCardHtml(p) {
  return `
    <article class="picture-tile" data-id="${p.id}">
      ${_selectMode ? `<label class="link-pick picture-pick">
          <input type="checkbox" class="link-check" value="${p.id}" ${_selected.has(p.id) ? "checked" : ""}>
        </label>` : ""}
      <a class="picture-img" href="${location.pathname}?image=${p.id}" data-image="${p.id}">
        <img src="${p.src}" alt="${escHtml(p.title)}" loading="lazy">
      </a>
      <div class="picture-foot">
        <span class="picture-title" title="${escHtml(p.title)}">${escHtml(p.title)}</span>
        <div class="row-menu-wrap">
          <button class="row-overflow" type="button" title="More"><i data-lucide="ellipsis-vertical"></i></button>
          <div class="row-menu">
            <button type="button" class="row-menu-item" onclick="openAddToProject('picture', ['${p.id}'])">
              <i data-lucide="folder-kanban"></i> Add to project
            </button>
            <button type="button" class="row-menu-item" onclick="openEditPicture('${p.id}')">
              <i data-lucide="square-pen"></i> Edit
            </button>
            <button type="button" class="row-menu-item danger" onclick="deletePicture('${p.id}')">
              <i data-lucide="trash-2"></i> Delete
            </button>
          </div>
        </div>
      </div>
    </article>`;
}

function pickPictures() {
  document.getElementById("picture-input")?.click();
}

// lands in the tag on screen; a pasted screenshot has no name worth keeping
async function uploadPictures(files, pasted = false) {
  const imgs = [...files].filter(f => f.type.startsWith("image/"));
  if (!imgs.length) return;
  const tag = currentTagId();
  if (imgs.length > 1) toast(`Uploading ${plural(imgs.length, "image")}…`);
  let saved = 0;
  for (const f of imgs) {
    const form = new FormData();
    form.append("file", f, f.name || "picture");
    if (tag) form.append("tag_id", tag);
    if (pasted) form.append("title", `Screenshot ${new Date().toLocaleString()}`);
    const res = await fetch("/api/pictures", { method: "POST", headers: { "X-Tether-UUID": UUID_HEADER() }, body: form });
    if (res.ok) saved++;
    else toast((await res.json().catch(() => ({}))).detail || `Couldn't upload ${f.name}`, 4000);
  }
  if (saved) toast(`Saved ${plural(saved, "image")}`);
  await loadSidebarCats();
  renderTagPage();
}

// file picker, paste and drag-and-drop all upload on the Pictures side
function initPictureDrop() {
  const input = document.getElementById("picture-input");
  if (!input || MODE !== "pictures") return;
  input.addEventListener("change", () => { uploadPictures(input.files); input.value = ""; });
  document.addEventListener("paste", ev => {
    if (ev.target.closest?.("input, textarea, [contenteditable]")) return;
    if (!ev.clipboardData?.files.length) return;
    ev.preventDefault();
    uploadPictures(ev.clipboardData.files, true);
  });
  document.addEventListener("dragover", ev => {
    if (ev.dataTransfer?.types.includes("Files")) ev.preventDefault();
  });
  document.addEventListener("drop", ev => {
    if (!ev.dataTransfer?.files.length) return;
    ev.preventDefault();
    uploadPictures(ev.dataTransfer.files);
  });
}

async function openEditPicture(id) {
  let p = ctItems().find(x => x.id === id);
  if (!p) {
    const res = await fetch("/api/pictures", { headers: headers() });
    p = (res.ok ? await res.json() : []).find(x => x.id === id);
  }
  if (!p) return;
  document.getElementById("picture-edit-id").value = p.id;
  document.getElementById("picture-edit-title").value = p.title || "";
  fillCategorySelect(document.getElementById("picture-edit-tag"), p.tag_id, "Untagged");
  document.getElementById("picture-edit-modal").showModal();
  setTimeout(() => document.getElementById("picture-edit-title").select(), 50);
}

async function savePicture(ev) {
  ev.preventDefault();
  const id = document.getElementById("picture-edit-id").value;
  const res = await fetch(`/api/pictures/${id}`, {
    method: "PATCH", headers: headers(),
    body: JSON.stringify({
      title: document.getElementById("picture-edit-title").value,
      tag_id: Number(document.getElementById("picture-edit-tag").value) || 0,
    }),
  });
  if (!res.ok) { toast("Couldn't save that image"); return; }
  document.getElementById("picture-edit-modal").close();
  toast("Image updated");
  renderTagPage();
}

async function deletePicture(id) {
  if (!await showConfirm("Delete this image? This can't be undone.")) return;
  await fetch(`/api/pictures/${id}`, { method: "DELETE", headers: headers() });
  document.getElementById("picture-edit-modal")?.close();
  toast("Image deleted");
  if (openImageId() === id) history.replaceState({}, "", location.pathname);
  await loadSidebarCats();
  renderTagPage();
}

// ?image=<id> on an Images page shows that image in the pane, headed like a note:
// the title edits in place, the pencil opens the rest (tag, delete)
function openImageId() {
  return new URLSearchParams(location.search).get("image");
}

async function renderImagePage(id) {
  const pane = document.getElementById("ct-pane");
  if (!pane) return;
  // ponytail: fetches the whole list to find one; add GET /api/pictures/{id} if that gets slow
  const res = await fetch("/api/pictures", { headers: headers() });
  const p = (res.ok ? await res.json() : []).find(x => x.id === id);
  if (!p) { history.replaceState({}, "", location.pathname); return renderTagPage(); }
  setPageTitle(p.title);
  pane.innerHTML = `
    <div class="ct-head note-head">
      <div class="ct-title">
        <span class="note-title-grow" data-value="${escHtml(p.title)}">
          <input type="text" size="1" class="note-title-input" id="image-title-input"
                 value="${escHtml(p.title)}" placeholder="Image" autocomplete="off">
        </span>
        <button type="button" class="ct-edit" id="image-edit-btn" title="Edit image"><i data-lucide="pencil"></i></button>
      </div>
    </div>
    <div class="note-created">${p.tag ? `${escHtml(p.tag.name)} · ` : ""}Added ${friendlyDate(p.created_at)}</div>
    <a class="image-view" href="${p.src}" target="_blank" rel="noopener" title="Open full size">
      <img src="${p.src}" alt="${escHtml(p.title)}">
    </a>`;
  const input = pane.querySelector("#image-title-input");
  input.addEventListener("input", () => { input.parentElement.dataset.value = input.value || input.placeholder; });
  input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); });
  input.addEventListener("change", async () => {
    const r = await fetch(`/api/pictures/${id}`, {
      method: "PATCH", headers: headers(), body: JSON.stringify({ title: input.value }),
    });
    if (!r.ok) { toast("Couldn't save that image"); return; }
    const saved = await r.json();
    input.value = saved.title;
    input.parentElement.dataset.value = saved.title;
    setPageTitle(saved.title);
  });
  pane.querySelector("#image-edit-btn").addEventListener("click", () => openEditPicture(id));
  lucide.createIcons();
}

/* ── Projects ────────────────────────────────────────────── */
// A project only collects links, notes and pictures saved elsewhere.
let _projects = [];

function renderProjectSidebar(ul) {
  ul.innerHTML = _projects.map(p => `
    <li>
      <a href="/project/${escHtml(p.slug)}" class="sidebar-cat-link ${VIEW.project === p.id ? "active" : ""}">
        ${folderSvg("var(--n-400)")}
        <span class="sidebar-cat-name">${escHtml(p.name)}</span>
        <span class="sidebar-cat-badge">${p.count}</span>
      </a>
    </li>`).join("") || `<li class="sidebar-note sidebar-empty">No projects yet</li>`;
}

async function renderProjectPage() {
  const pane = document.getElementById("ct-pane");
  if (!pane) return;
  if (!VIEW.project) {
    setPageTitle("Projects");
    pane.innerHTML = `<div class="empty-state">Pick a project, or use + to start one.
      Then add links, notes and images to it from their ⋮ menu.</div>`;
    return;
  }
  const res = await fetch(`/api/projects/${VIEW.project}`, { headers: headers() });
  if (!res.ok) { pane.innerHTML = '<div class="empty-state">Not found.</div>'; return; }
  const p = await res.json();
  _ctReload = renderProjectPage;
  setPageTitle(p.name);

  const remove = (kind, id) => `
    <button type="button" class="row-overflow" data-remove="${kind}" data-id="${id}" title="Remove from project">
      <i data-lucide="x"></i>
    </button>`;
  const section = (label, html) => html ? `<h2 class="project-section">${label}</h2>${html}` : "";
  const links = p.links.map(l => `
    <article class="link-row">
      <span class="link-thumb">${l.favicon_url ? `<img src="${escHtml(l.favicon_url)}" alt="" onerror="this.style.display='none'">` : ""}</span>
      <span class="link-main">
        <a class="link-title" href="${escHtml(l.url)}" target="_blank" rel="noopener">${escHtml(l.title || getDomain(l.url))}</a>
        <span class="link-url">${escHtml(getDomain(l.url))}</span>
      </span>
      ${remove("link", l.id)}
    </article>`).join("");
  const notes = p.notes.map(n => `
    <article class="link-row">
      <span class="link-thumb"><i data-lucide="file-text"></i></span>
      <span class="link-main">
        <a class="link-title" href="${escHtml(n.path)}">${escHtml(n.title || "Untitled")}</a>
        <span class="link-url">${escHtml(n.tag?.name || "Untagged")} · edited ${friendlyDate(n.updated_at)}</span>
      </span>
      ${remove("note", n.id)}
    </article>`).join("");
  const pictures = p.pictures.length ? `<div class="picture-grid">${p.pictures.map(pic => `
    <article class="picture-tile">
      <a class="picture-img" href="${pic.src}" target="_blank" rel="noopener"><img src="${pic.src}" alt="${escHtml(pic.title)}" loading="lazy"></a>
      <div class="picture-foot">
        <span class="picture-title" title="${escHtml(pic.title)}">${escHtml(pic.title)}</span>
        ${remove("picture", pic.id)}
      </div>
    </article>`).join("")}</div>` : "";
  const body = section("Links", links) + section("Notes", notes) + section("Images", pictures);

  pane.innerHTML = `
    <div class="ct-head">
      <div class="ct-title">
        <h1>${escHtml(p.name)}</h1>
        <button type="button" class="ct-edit" id="project-edit" title="Edit project"><i data-lucide="pencil"></i></button>
      </div>
    </div>
    ${body || `<div class="empty-state">Nothing in this project yet. Use “Add to project” from any link, note or image's ⋮ menu.</div>`}`;

  pane.querySelector("#project-edit").addEventListener("click", () => openProjectModal(p));
  pane.querySelectorAll("[data-remove]").forEach(btn => btn.addEventListener("click", async () => {
    const qs = new URLSearchParams({ item_kind: btn.dataset.remove, item_id: btn.dataset.id });
    await fetch(`/api/projects/${p.id}/items?${qs}`, { method: "DELETE", headers: headers() });
    toast("Removed from project");
    await loadSidebarCats();
    renderProjectPage();
  }));
  lucide.createIcons();
}

function openProjectModal(project = null) {
  document.getElementById("project-modal-title").textContent = project ? "Edit project" : "New project";
  document.getElementById("project-id").value = project ? project.id : "";
  document.getElementById("project-name").value = project ? project.name : "";
  document.getElementById("project-delete").hidden = !project;
  document.getElementById("project-modal").showModal();
  setTimeout(() => document.getElementById("project-name").focus(), 50);
}

async function saveProject(ev) {
  ev.preventDefault();
  const id = document.getElementById("project-id").value;
  const res = await fetch(id ? `/api/projects/${id}` : "/api/projects", {
    method: id ? "PATCH" : "POST", headers: headers(),
    body: JSON.stringify({ name: document.getElementById("project-name").value }),
  });
  if (!res.ok) { toast("Couldn't save that project"); return; }
  location.href = `/project/${(await res.json()).slug}`;   // a rename changes the path
}

async function deleteProject() {
  const id = document.getElementById("project-id").value;
  if (!await showConfirm("Delete this project? The links, notes and images in it are kept.")) return;
  await fetch(`/api/projects/${id}`, { method: "DELETE", headers: headers() });
  location.href = "/project";
}

let _addToProject = null;   // { kind: "link" | "note" | "picture", ids: [...] }

async function openAddToProject(kind, ids) {
  _addToProject = { kind, ids };
  const res = await fetch("/api/projects", { headers: headers() });
  const projects = res.ok ? await res.json() : [];
  const sel = document.getElementById("add-to-project-select");
  sel.innerHTML = projects.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join("")
    + `<option value="__new__">+ New project…</option>`;
  document.getElementById("add-to-project-new").value = "";
  document.getElementById("add-to-project-title").textContent =
    ids.length > 1 ? `Add ${plural(ids.length, kind)} to project` : "Add to project";
  toggleNewProjectName();
  document.getElementById("add-to-project-modal").showModal();
}

function toggleNewProjectName() {
  const isNew = document.getElementById("add-to-project-select").value === "__new__";
  const input = document.getElementById("add-to-project-new");
  input.style.display = isNew ? "" : "none";
  input.required = isNew;
  if (isNew) setTimeout(() => input.focus(), 50);
}

async function submitAddToProject(ev) {
  ev.preventDefault();
  const sel = document.getElementById("add-to-project-select");
  let id = sel.value;
  let name = sel.selectedOptions[0]?.textContent;
  if (id === "__new__") {
    name = document.getElementById("add-to-project-new").value.trim();
    const res = await fetch("/api/projects", { method: "POST", headers: headers(), body: JSON.stringify({ name }) });
    if (!res.ok) { toast("Couldn't create that project"); return; }
    id = (await res.json()).id;
  }
  const { kind, ids } = _addToProject;
  for (const itemId of ids) {
    await fetch(`/api/projects/${id}/items`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({ item_kind: kind, item_id: itemId }),
    });
  }
  document.getElementById("add-to-project-modal").close();
  toast(`Added to ${name}`);
}
