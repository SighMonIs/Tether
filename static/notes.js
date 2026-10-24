import { Editor } from "https://esm.sh/@tiptap/core@2.27.2";
import StarterKit from "https://esm.sh/@tiptap/starter-kit@2.27.2?deps=@tiptap/core@2.27.2";
import Underline from "https://esm.sh/@tiptap/extension-underline@2.27.2?deps=@tiptap/core@2.27.2";
import Link from "https://esm.sh/@tiptap/extension-link@2.27.2?deps=@tiptap/core@2.27.2";
import TaskList from "https://esm.sh/@tiptap/extension-task-list@2.27.2?deps=@tiptap/core@2.27.2";
import TaskItem from "https://esm.sh/@tiptap/extension-task-item@2.27.2?deps=@tiptap/core@2.27.2";
import Placeholder from "https://esm.sh/@tiptap/extension-placeholder@2.27.2?deps=@tiptap/core@2.27.2";
import { Markdown } from "https://esm.sh/tiptap-markdown@0.9.0?deps=@tiptap/core@2.27.2";
import { createSlashCommand } from "/static/slash-commands.js?v=007";

const uuidMeta = document.querySelector('meta[name="tether-uuid"]');
const TETHER_UUID = uuidMeta ? uuidMeta.content : "";

function authHeaders(json = true) {
  const h = { "X-Tether-UUID": TETHER_UUID };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

function escHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const titleInput = document.getElementById("note-title-input");
const editorMount = document.getElementById("note-editor");
const statusEl = document.getElementById("notes-save-status");
const createdEl = document.getElementById("note-created");
const bubbleEl = document.getElementById("bubble-toolbar");
const linkBarEl = document.getElementById("link-toolbar");

const urlParams = new URLSearchParams(location.search);

const ctView = document.getElementById("ct-view");
// shown when nothing is open: the notes themselves live in the sidebar
const notesEmptyView = document.getElementById("notes-empty-view");
const noteView = document.getElementById("note-editor-view");
const linksView = document.getElementById("links-view");

const VIEW = window.TETHER_VIEW || { tag: null, uncategorised: false, type: "all", ct: null, note: null };

let currentView = "links";  // "links" | "notes" | "ct" | "tag" | "editor"
let currentCtId = VIEW.ct ? String(VIEW.ct) : null;

function setView(v, persist = true) {
  currentView = v;
  const editing = v === "editor";
  noteView.style.display = editing ? "" : "none";
  // "tag" is a Notes tag's page, drawn into the same pane as a links bucket
  if (ctView) ctView.style.display = v === "ct" || v === "tag" ? "" : "none";
  notesEmptyView.style.display = v === "notes" ? "" : "none";
  linksView.style.display = v === "links" ? "" : "none";
  if (!editing) { hideBubble(); hideLinkBar(); }
  if (!editing && v !== "ct") window.setSidebarNote?.(null);
  if (v === "ct") window.renderContentTypeView?.(currentCtId);
  if (v === "tag") window.renderTagPage?.();
}

// app.js still calls this after a quick-add save
window.setShowingLinks = on => setView(on ? "links" : "notes");

// swap the content area in place — the sidebar updates the URL itself
window.showContentTypeView = ctId => { currentCtId = ctId; setView("ct"); };
window.showNotesTagView = () => setView("tag");

// read live: the sidebar moves between tags without a page load
const filterTagId = () => VIEW.tag || null;
const filterUncategorised = () => !!VIEW.uncategorised;

let currentNoteId = null;
let saveTimeout = null;
let suppressDirty = false;
let isDirty = false;
let notesCache = [];
let allTags = [];

const COMMANDS = {
  undo: e => e.chain().focus().undo().run(),
  redo: e => e.chain().focus().redo().run(),
  bold: e => e.chain().focus().toggleBold().run(),
  italic: e => e.chain().focus().toggleItalic().run(),
  underline: e => e.chain().focus().toggleUnderline().run(),
  strike: e => e.chain().focus().toggleStrike().run(),
  code: e => e.chain().focus().toggleCode().run(),
  // strips the whole current block back to plain body text, marks included
  paragraph: e => {
    const { $from } = e.state.selection;
    const from = $from.start();
    const to = $from.end();
    return e.chain().focus()
      .setTextSelection({ from, to })
      .clearNodes()
      .unsetAllMarks()
      .setTextSelection(e.state.selection.empty ? to : { from, to })
      .run();
  },
  heading1: e => e.chain().focus().toggleHeading({ level: 1 }).run(),
  heading2: e => e.chain().focus().toggleHeading({ level: 2 }).run(),
  heading3: e => e.chain().focus().toggleHeading({ level: 3 }).run(),
  bulletList: e => e.chain().focus().toggleBulletList().run(),
  orderedList: e => e.chain().focus().toggleOrderedList().run(),
  taskList: e => e.chain().focus().toggleTaskList().run(),
  blockquote: e => e.chain().focus().toggleBlockquote().run(),
  codeBlock: e => e.chain().focus().toggleCodeBlock().run(),
  horizontalRule: e => e.chain().focus().setHorizontalRule().run(),
  link: e => {
    const prev = e.getAttributes("link").href || "";
    const url = window.prompt("Link URL", prev || "https://");
    if (url === null) return;
    if (url === "") { e.chain().focus().extendMarkRange("link").unsetLink().run(); return; }
    e.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  },
};

const editor = new Editor({
  element: editorMount,
  extensions: [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    Underline,
    Link.configure({ openOnClick: false, autolink: true }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder: "Start writing…  ( / for commands )" }),
    Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
    createSlashCommand(COMMANDS),
  ],
  content: "",
  onUpdate: () => scheduleSave(),
  onSelectionUpdate: updateToolbarState,
  onTransaction: updateToolbarState,
});

const ACTIVE_CHECKS = {
  bold: e => e.isActive("bold"),
  italic: e => e.isActive("italic"),
  underline: e => e.isActive("underline"),
  strike: e => e.isActive("strike"),
  code: e => e.isActive("code"),
  heading1: e => e.isActive("heading", { level: 1 }),
  heading2: e => e.isActive("heading", { level: 2 }),
  heading3: e => e.isActive("heading", { level: 3 }),
  bulletList: e => e.isActive("bulletList"),
  orderedList: e => e.isActive("orderedList"),
  taskList: e => e.isActive("taskList"),
  blockquote: e => e.isActive("blockquote"),
  codeBlock: e => e.isActive("codeBlock"),
  link: e => e.isActive("link"),
};

function updateToolbarState() {
  const bars = [bubbleEl].filter(Boolean);
  for (const bar of bars) {
    bar.querySelectorAll("[data-cmd]").forEach(btn => {
      const check = ACTIVE_CHECKS[btn.dataset.cmd];
      btn.classList.toggle("active", check ? check(editor) : false);
    });
  }
  positionBubble();
  positionLinkBar();
}

/* ── Selection bubble ────────────────────────────────────── */
function hideBubble() {
  if (bubbleEl) bubbleEl.classList.remove("open");
}

function positionBubble() {
  if (!bubbleEl) return;
  const { from, to, empty } = editor.state.selection;
  if (empty || from === to || !editor.isFocused) return hideBubble();

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return hideBubble();
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return hideBubble();

  bubbleEl.classList.add("open");
  const w = bubbleEl.offsetWidth;
  const h = bubbleEl.offsetHeight;
  const top = rect.top - h - 8 < 8 ? rect.bottom + 8 : rect.top - h - 8;
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - w / 2),
    window.innerWidth - w - 8
  );
  bubbleEl.style.top = `${top}px`;
  bubbleEl.style.left = `${left}px`;
}

/* ── Link bar ────────────────────────────────────────────── */
function hideLinkBar() {
  if (linkBarEl) linkBarEl.classList.remove("open");
}

// place a bar against `rect`, above it when there is room, else below
function placeBar(el, rect) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const top = rect.top - h - 8 < 8 ? rect.bottom + 8 : rect.top - h - 8;
  el.style.top = `${top}px`;
  el.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - w - 8)}px`;
}

function positionLinkBar() {
  if (!linkBarEl) return;
  // only for a plain caret inside a link — a real selection gets the format bubble
  if (!editor.state.selection.empty || !editor.isFocused || !editor.isActive("link")) {
    return hideLinkBar();
  }
  const href = editor.getAttributes("link").href || "";
  if (!href) return hideLinkBar();

  const urlEl = document.getElementById("link-bar-url");
  urlEl.textContent = href;
  urlEl.title = href;
  linkBarEl.dataset.href = href;
  linkBarEl.classList.add("open");

  const sel = window.getSelection();
  const node = sel && sel.anchorNode;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const anchor = el && el.closest ? el.closest("a") : null;
  const rect = anchor ? anchor.getBoundingClientRect()
             : (sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null);
  if (!rect) return hideLinkBar();
  placeBar(linkBarEl, rect);
}

function initLinkBar() {
  if (!linkBarEl) return;
  linkBarEl.addEventListener("mousedown", e => e.preventDefault());
  // COMMANDS.link prompts with the current href and re-applies it over the whole mark.
  // prompt() blurs the editor, so refocus past the blur guard before repositioning.
  document.getElementById("link-bar-edit").addEventListener("click", () => {
    COMMANDS.link(editor);
    setTimeout(() => {
      // setLink leaves the whole mark selected; collapse back inside it so the
      // link bar (not the format bubble) is what comes back
      const { from, to } = editor.state.selection;
      editor.chain().focus().setTextSelection(Math.min(from + 1, to)).run();
      positionLinkBar();
    }, 200);
  });
  document.getElementById("link-bar-open").addEventListener("click", () => {
    const href = linkBarEl.dataset.href;
    if (href) window.open(href, "_blank", "noopener");
  });
  document.getElementById("link-bar-remove").addEventListener("click", () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    hideLinkBar();
  });
  editor.on("blur", () => setTimeout(() => { if (!editor.isFocused) hideLinkBar(); }, 120));
  document.addEventListener("scroll", () => hideLinkBar(), true);
  window.addEventListener("resize", hideLinkBar);
}

function initBubbleToolbar() {
  if (!bubbleEl) return;
  // mousedown would clear the selection before the command runs
  bubbleEl.addEventListener("mousedown", e => e.preventDefault());
  bubbleEl.addEventListener("click", e => {
    const btn = e.target.closest("[data-cmd]");
    if (!btn || !currentNoteId) return;
    COMMANDS[btn.dataset.cmd]?.(editor);
    updateToolbarState();
  });
  editor.on("blur", () => setTimeout(() => { if (!editor.isFocused) hideBubble(); }, 120));
  document.addEventListener("scroll", () => hideBubble(), true);
  window.addEventListener("resize", hideBubble);
}

initBubbleToolbar();
initLinkBar();

// the input sizes to its text (via the wrapper's hidden copy) so the pencil sits beside it
const titleGrow = document.getElementById("note-title-grow");
function setTitle(v) {
  titleInput.value = v;
  titleGrow.dataset.value = v || titleInput.placeholder;
}
titleInput.addEventListener("input", () => {
  titleGrow.dataset.value = titleInput.value || titleInput.placeholder;
  scheduleSave();
});

/* ── Parent note picker ──────────────────────────────────── */
// one level deep like tags: only a tag's top-level notes can be parents.
// Fills `sel` for the tag picked in `tagSel`; returns that tag's notes.
async function fillParentSelect(sel, tagSel, selectedId = null, selfId = null) {
  const tagId = Number(tagSel.value) || null;
  const qs = tagId ? `tag=${tagId}` : "uncategorised=true";
  const res = await fetch(`/api/notes?${qs}`, { headers: authHeaders(false) });
  const notes = res.ok ? await res.json() : [];
  sel.innerHTML = `<option value="">None (top level)</option>` + notes
    .filter(n => !n.parent_id && n.id !== selfId)
    .map(n => `<option value="${n.id}" ${n.id === selectedId ? "selected" : ""}>${escHtml(n.title || "Untitled")}</option>`)
    .join("");
  return notes;
}

/* ── Edit note (tag, parent, delete) ─────────────────────── */
const noteEditModal = document.getElementById("note-edit-modal");
const noteEditTag = document.getElementById("note-edit-tag");
const noteEditParent = document.getElementById("note-edit-parent");
let currentNote = null;   // the open note as the server last sent it

async function fillEditParent() {
  const notes = await fillParentSelect(noteEditParent, noteEditTag, currentNote?.parent_id, currentNoteId);
  // a note with sub-notes of its own can't become one
  const hasKids = notes.some(n => n.parent_id === currentNoteId);
  noteEditParent.disabled = hasKids;
  noteEditParent.title = hasKids ? "This note has sub-notes of its own" : "";
}

noteEditTag.addEventListener("change", fillEditParent);

document.getElementById("note-edit-btn").addEventListener("click", async () => {
  if (!currentNoteId) return;
  noteEditTag.innerHTML = newNoteTag.innerHTML;     // the same Notes tags
  noteEditTag.value = String(currentNote?.tag_id || 0);
  await fillEditParent();
  noteEditModal.showModal();
});

document.getElementById("note-edit-form").addEventListener("submit", async ev => {
  ev.preventDefault();
  const id = currentNoteId;
  const tagId = Number(noteEditTag.value) || null;
  const parentId = noteEditParent.disabled ? (currentNote?.parent_id || null) : (noteEditParent.value || null);
  noteEditModal.close();
  if (!id) return;
  const body = {};
  if (tagId !== (currentNote?.tag_id || null)) body.tag_id = tagId || 0;
  if (parentId !== (currentNote?.parent_id || null)) body.parent_id = parentId;
  if (!Object.keys(body).length) return;
  clearTimeout(saveTimeout);
  await saveCurrentNote();
  const res = await fetch(`/api/notes/${id}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) return;
  const note = await res.json();
  currentNote = note;
  // follow the note into its new tag: sidebar, page title and path
  await window.showNoteTag?.(note.tag_id);
  window.setSidebarNote?.(note.id, note.slug);
});

document.getElementById("note-edit-delete").addEventListener("click", async () => {
  const id = currentNoteId;
  noteEditModal.close();
  if (!id || !await window.showConfirm("Delete this note? This cannot be undone.")) return;
  clearTimeout(saveTimeout);
  isDirty = false;
  await fetch(`/api/notes/${id}`, { method: "DELETE", headers: authHeaders(false) });
  notesCache = notesCache.filter(n => n.id !== id);
  currentNoteId = null;
  currentNote = null;
  suppressDirty = true;
  setTitle("");
  editor.commands.setContent("");
  setTimeout(() => { suppressDirty = false; }, 0);
  // back to the tag it was in
  await window.reloadSidebarNotes?.();
  const tag = VIEW.uncategorised ? "" : String(VIEW.tag || "");
  window.showNotesTag?.(tag, window.categoryPath?.(tag));
});

window.createNoteInCategory = () => createNote();

// a tag made from any picker joins the New note list, which the Edit note picker copies
document.addEventListener("tether:tag-created", ({ detail: tag }) => {
  if (tag.kind !== "notes" || allTags.some(t => t.id === tag.id)) return;
  allTags.push(tag);
  if (newNoteTag.querySelector(`option[value="${tag.id}"]`)) return;
  newNoteTag.querySelector('option[value="__newtag__"]')
    ?.insertAdjacentHTML("beforebegin", `<option value="${tag.id}">${escHtml(tag.name)}</option>`);
});

async function loadTags() {
  const res = await fetch("/api/tags?kind=notes", { headers: authHeaders(false) });
  allTags = res.ok ? await res.json() : [];
  newNoteTag.innerHTML = `<option value="0">No tag</option>` + window.tagOptions(allTags) + window.newTagOption();

  if (filterTagId()) {
    const tag = allTags.find(t => t.id === filterTagId());
    if (tag) window.setPageTitle?.(tag.name);
  } else if (filterUncategorised()) {
    window.setPageTitle?.("Untagged");
  }
}

function showCreated(iso) {
  if (!createdEl) return;
  if (!iso) { createdEl.textContent = ""; return; }
  const d = new Date(iso.replace(" ", "T") + "Z");
  const pad = n => String(n).padStart(2, "0");
  createdEl.textContent = `Created on: ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function scheduleSave() {
  if (suppressDirty || !currentNoteId) return;
  isDirty = true;
  statusEl.textContent = "Saving…";
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveCurrentNote, 600);
}

async function saveCurrentNote() {
  if (!currentNoteId || !isDirty) return;
  const noteId = currentNoteId;
  const markdown = editor.storage.markdown.getMarkdown();
  const title = titleInput.value.trim() || "Untitled";
  try {
    const res = await fetch(`/api/notes/${noteId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ title, content: markdown }),
    });
    if (res.ok) {
      isDirty = false;
      const note = await res.json();
      if (note.id === currentNoteId) currentNote = note;
      const idx = notesCache.findIndex(n => n.id === note.id);
      if (idx !== -1) notesCache[idx] = note;
      window.reloadSidebarNotes?.();
      statusEl.textContent = "Saved";
    } else {
      statusEl.textContent = "Save failed";
    }
  } catch {
    statusEl.textContent = "Save failed";
  }
}

async function openNote(id, switchTab = true) {
  if (switchTab) setView("editor");
  if (id === currentNoteId) {
    // already loaded, but the path may have moved on since
    window.setSidebarNote?.(id, notesCache.find(n => n.id === id)?.slug);
    return true;
  }
  const res = await fetch(`/api/notes/${id}`, { headers: authHeaders(false) });
  if (!res.ok) return false;
  const note = await res.json();

  clearTimeout(saveTimeout);
  await saveCurrentNote();
  currentNoteId = id;
  currentNote = note;

  suppressDirty = true;
  setTitle(note.title === "Untitled" ? "" : note.title);
  editor.commands.setContent(note.content || "");
  setTimeout(() => { suppressDirty = false; }, 0);

  statusEl.textContent = "";
  showCreated(note.created_at);
  window.setSidebarNote?.(id, notesCache.find(n => n.id === id)?.slug);
  updateToolbarState();
  return true;
}

// New note asks which tag it belongs in, defaulting to the one you're in
const newNoteModal = document.getElementById("new-note-modal");
const newNoteTag = document.getElementById("new-note-tag");
const newNoteParent = document.getElementById("new-note-parent");

newNoteTag.addEventListener("change", () => fillParentSelect(newNoteParent, newNoteTag));

async function createNote() {
  newNoteTag.value = String(filterTagId() || 0);
  await fillParentSelect(newNoteParent, newNoteTag);
  newNoteModal.showModal();
  setTimeout(() => newNoteTag.focus(), 50);
}

document.getElementById("new-note-form").addEventListener("submit", async ev => {
  ev.preventDefault();
  const tagId = Number(newNoteTag.value) || null;
  const res = await fetch("/api/notes", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ title: "Untitled", tag_id: tagId, parent_id: newNoteParent.value || null }),
  });
  newNoteModal.close();
  if (!res.ok) return;
  const note = await res.json();
  notesCache.unshift(note);
  currentNoteId = null;
  await window.showNoteTag?.(tagId);
  await openNote(note.id);
  titleInput.focus();
});

window.createNoteFromLink = async function(title, url, linkId) {
  const res = await fetch("/api/notes", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ title, tag_id: filterTagId(), link_id: linkId }),
  });
  if (!res.ok) return;
  const note = await res.json();
  await fetch(`/api/notes/${note.id}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ content: `${url}\n\n` }),
  });
  notesCache.unshift(note);
  currentNoteId = null;
  await openNote(note.id);
  window.reloadSidebarNotes?.();
  if (linkId) window.loadLinks?.();
};

window.openNoteById = id => openNote(id);

async function loadNotes() {
  const qs = new URLSearchParams();
  if (filterTagId()) qs.set("tag", filterTagId());
  if (filterUncategorised()) qs.set("uncategorised", "true");
  const res = await fetch(`/api/notes${qs.toString() ? "?" + qs : ""}`, { headers: authHeaders(false) });
  notesCache = res.ok ? await res.json() : [];
  currentNoteId = null;
  suppressDirty = true;
  setTitle("");
  editor.commands.setContent("");
  setTimeout(() => { suppressDirty = false; }, 0);
  statusEl.textContent = "";
  if (VIEW.note) { openNote(VIEW.note); return; }
}

// runs last, once the consts above are declared
// the server already worked out which view the path means
// a Notes path naming a tag lands on that tag's page
const tagged = VIEW.tag || VIEW.uncategorised;
// Pictures and Projects pages are drawn into the same pane as a tag's page
const ownPane = ["pictures", "projects"].includes(VIEW.type);
setView(ownPane || (VIEW.type === "notes" && tagged) ? "tag" : ["links", "notes", "ct"].includes(VIEW.type) ? VIEW.type : "links");

(async () => {
  await loadTags();
  await loadNotes();
})();
