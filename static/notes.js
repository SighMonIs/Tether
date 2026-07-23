import { Editor } from "https://esm.sh/@tiptap/core@2.27.2";
import StarterKit from "https://esm.sh/@tiptap/starter-kit@2.27.2?deps=@tiptap/core@2.27.2";
import Underline from "https://esm.sh/@tiptap/extension-underline@2.27.2?deps=@tiptap/core@2.27.2";
import Link from "https://esm.sh/@tiptap/extension-link@2.27.2?deps=@tiptap/core@2.27.2";
import TaskList from "https://esm.sh/@tiptap/extension-task-list@2.27.2?deps=@tiptap/core@2.27.2";
import TaskItem from "https://esm.sh/@tiptap/extension-task-item@2.27.2?deps=@tiptap/core@2.27.2";
import Placeholder from "https://esm.sh/@tiptap/extension-placeholder@2.27.2?deps=@tiptap/core@2.27.2";
import { Markdown } from "https://esm.sh/tiptap-markdown@0.9.0?deps=@tiptap/core@2.27.2";
import { createSlashCommand } from "/static/slash-commands.js";

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

const listEl = document.getElementById("notes-list");
const titleInput = document.getElementById("note-title-input");
const editorMount = document.getElementById("note-editor");
const statusEl = document.getElementById("notes-save-status");
const toolbarEl = document.getElementById("notes-toolbar");
const categoryBtn = document.getElementById("note-category-btn");
const categoryModal = document.getElementById("note-category-modal");
const categorySelect = document.getElementById("note-category-select");
const categoryForm = document.getElementById("note-category-form");

const linksTabBtn = document.getElementById("tab-links-btn");
const notesTabBtn = document.getElementById("tab-notes-btn");
const noteView = document.getElementById("note-editor-view");
const linksToolbar = document.getElementById("links-toolbar");
const linksView = document.getElementById("links-view");

function setShowingLinks(on, persist = true) {
  toolbarEl.style.display = on ? "none" : "";
  noteView.style.display = on ? "none" : "";
  linksToolbar.style.display = on ? "" : "none";
  linksView.style.display = on ? "" : "none";
  linksTabBtn.classList.toggle("active", on);
  notesTabBtn.classList.toggle("active", !on);
  if (persist) localStorage.setItem("activeTab", on ? "links" : "notes");
}

linksTabBtn.addEventListener("click", () => setShowingLinks(true));
notesTabBtn.addEventListener("click", () => setShowingLinks(false));

if (localStorage.getItem("activeTab") === "links") setShowingLinks(true, false);

const urlParams = new URLSearchParams(location.search);
const filterTagId = urlParams.get("tag") ? Number(urlParams.get("tag")) : null;
const filterUncategorised = urlParams.get("uncategorised") === "true";

const sidebarTagsNav = document.getElementById("sidebar-tags-nav");
const sidebarNotesNav = document.getElementById("sidebar-notes-nav");
const categoryTrigger = document.getElementById("sidebar-category-trigger");
const categoryLabel = document.getElementById("sidebar-category-label");
let showingTagsPanel = false;

categoryTrigger.addEventListener("click", () => {
  showingTagsPanel = !showingTagsPanel;
  sidebarTagsNav.style.display = showingTagsPanel ? "" : "none";
  sidebarNotesNav.style.display = showingTagsPanel ? "none" : "";
  categoryTrigger.classList.toggle("open", showingTagsPanel);
});

let currentNoteId = null;
let saveTimeout = null;
let suppressDirty = false;
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
  paragraph: e => e.chain().focus().setParagraph().run(),
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
  toolbarEl.querySelectorAll("[data-cmd]").forEach(btn => {
    const check = ACTIVE_CHECKS[btn.dataset.cmd];
    btn.classList.toggle("active", check ? check(editor) : false);
  });
}

toolbarEl.addEventListener("click", e => {
  const btn = e.target.closest("[data-cmd]");
  if (!btn || !currentNoteId) return;
  COMMANDS[btn.dataset.cmd]?.(editor);
});

titleInput.addEventListener("input", () => scheduleSave());

categoryBtn.addEventListener("click", () => {
  if (!currentNoteId) return;
  const current = notesCache.find(n => n.id === currentNoteId);
  categorySelect.value = current?.tag ? String(current.tag.id) : "0";
  categoryModal.showModal();
});

categoryForm.addEventListener("submit", async e => {
  e.preventDefault();
  if (!currentNoteId) return;
  const res = await fetch(`/api/notes/${currentNoteId}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ tag_id: Number(categorySelect.value) }),
  });
  if (res.ok) {
    const note = await res.json();
    const idx = notesCache.findIndex(n => n.id === note.id);
    if (idx !== -1) notesCache[idx] = note;
    renderList();
  }
  categoryModal.close();
});

async function loadTags() {
  const res = await fetch("/api/tags", { headers: authHeaders(false) });
  allTags = res.ok ? await res.json() : [];
  categorySelect.innerHTML = `<option value="0">No category</option>` + allTags.map(t =>
    `<option value="${t.id}">${escHtml(t.name)}</option>`
  ).join("");

  if (filterTagId) {
    const tag = allTags.find(t => t.id === filterTagId);
    if (tag) {
      window.setPageTitle?.(tag.name);
      categoryLabel.innerHTML = `<span class="sidebar-cat-dot" style="background:${escHtml(tag.color)}"></span>${escHtml(tag.name)}`;
    }
  } else if (filterUncategorised) {
    window.setPageTitle?.("Untagged");
    categoryLabel.textContent = "Untagged";
  }
}

function scheduleSave() {
  if (suppressDirty || !currentNoteId) return;
  statusEl.textContent = "Saving…";
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveCurrentNote, 600);
}

async function saveCurrentNote() {
  if (!currentNoteId) return;
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
      const note = await res.json();
      const idx = notesCache.findIndex(n => n.id === note.id);
      if (idx !== -1) notesCache[idx] = note;
      renderList();
      statusEl.textContent = "Saved";
    }
  } catch {
    statusEl.textContent = "Save failed";
  }
}

function renderList() {
  listEl.innerHTML = "";
  const sorted = [...notesCache].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  for (const note of sorted) {
    const item = document.createElement("div");
    item.className = "notes-list-item" + (note.id === currentNoteId ? " active" : "");
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.innerHTML = `
      <span class="notes-list-title">${escHtml(note.title || "Untitled")}</span>
      <button class="notes-list-delete" title="Delete note" type="button">
        <i data-lucide="trash-2"></i>
      </button>
    `;
    item.addEventListener("click", () => openNote(note.id));
    item.addEventListener("keydown", ev => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openNote(note.id);
      }
    });
    item.querySelector(".notes-list-delete").addEventListener("click", ev => {
      ev.stopPropagation();
      deleteNote(note.id);
    });
    listEl.appendChild(item);
  }
  if (window.lucide) lucide.createIcons();
}

async function openNote(id, switchTab = true) {
  if (switchTab && linksTabBtn.classList.contains("active")) setShowingLinks(false);
  if (id === currentNoteId) return;
  clearTimeout(saveTimeout);
  await saveCurrentNote();

  currentNoteId = id;
  const res = await fetch(`/api/notes/${id}`, { headers: authHeaders(false) });
  if (!res.ok) return;
  const note = await res.json();

  suppressDirty = true;
  titleInput.value = note.title === "Untitled" ? "" : note.title;
  editor.commands.setContent(note.content || "");
  setTimeout(() => { suppressDirty = false; }, 0);

  statusEl.textContent = "";
  renderList();
  updateToolbarState();
}

async function createNote() {
  const res = await fetch("/api/notes", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ title: "Untitled", tag_id: filterTagId }),
  });
  if (!res.ok) return;
  const note = await res.json();
  notesCache.unshift(note);
  currentNoteId = null;
  await openNote(note.id);
  titleInput.focus();
}

window.createNoteFromLink = async function(title, url) {
  const res = await fetch("/api/notes", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ title, tag_id: filterTagId }),
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
};

async function deleteNote(id) {
  const ok = await window.showConfirm("Delete this note? This cannot be undone.");
  if (!ok) return;
  await fetch(`/api/notes/${id}`, { method: "DELETE", headers: authHeaders(false) });
  notesCache = notesCache.filter(n => n.id !== id);
  if (id === currentNoteId) {
    currentNoteId = null;
    if (notesCache.length) {
      await openNote(notesCache[0].id);
    } else {
      suppressDirty = true;
      titleInput.value = "";
      editor.commands.setContent("");
      setTimeout(() => { suppressDirty = false; }, 0);
      renderList();
    }
  } else {
    renderList();
  }
}

async function loadNotes() {
  const qs = new URLSearchParams();
  if (filterTagId) qs.set("tag", filterTagId);
  if (filterUncategorised) qs.set("uncategorised", "true");
  const res = await fetch(`/api/notes${qs.toString() ? "?" + qs : ""}`, { headers: authHeaders(false) });
  notesCache = res.ok ? await res.json() : [];
  if (!notesCache.length) {
    await createNote();
    return;
  }
  renderList();
  await openNote(notesCache[0].id, false);
}

(async () => {
  await loadTags();
  await loadNotes();
})();
