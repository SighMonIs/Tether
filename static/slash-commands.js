import { Extension, InputRule } from "https://esm.sh/@tiptap/core@2.27.2";
import Suggestion from "https://esm.sh/@tiptap/suggestion@2.27.2?deps=@tiptap/core@2.27.2";

// Inline formatting (bold, italic, link, …) lives in the selection bubble instead —
// a slash command can't act on a selection, so these only belong in one place.
const ITEMS = [
  { id: "paragraph", command: "/text", keywords: ["text", "paragraph", "normal", "plain", "body", "reset"], icon: "type" },
  { id: "heading1", command: "/heading1", keywords: ["h1", "heading1", "title"], icon: "heading-1" },
  { id: "heading2", command: "/heading2", keywords: ["h2", "heading2", "subtitle"], icon: "heading-2" },
  { id: "heading3", command: "/heading3", keywords: ["h3", "heading3"], icon: "heading-3" },
  { id: "bulletList", command: "/bulletlist", keywords: ["bullet", "ul", "list", "unordered"], icon: "list" },
  { id: "orderedList", command: "/numberedlist", keywords: ["ordered", "ol", "number", "numbered"], icon: "list-ordered" },
  { id: "taskList", command: "/tasklist", keywords: ["task", "todo", "checklist", "checkbox"], icon: "list-checks" },
  { id: "blockquote", command: "/quote", keywords: ["quote", "blockquote"], icon: "quote" },
  { id: "codeBlock", command: "/code", keywords: ["code", "codeblock", "pre"], icon: "square-code" },
  { id: "horizontalRule", command: "/divider", keywords: ["divider", "hr", "rule", "line"], icon: "minus" },
];

class SlashMenu {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "slash-menu";
    document.body.appendChild(this.el);
    this.items = [];
    this.index = 0;
    this.onSelect = null;
  }

  setItems(items, onSelect) {
    this.items = items;
    this.onSelect = onSelect;
    this.index = 0;
    this.draw();
  }

  draw() {
    if (!this.items.length) {
      this.el.innerHTML = `<div class="slash-menu-empty">No matches</div>`;
      return;
    }
    this.el.innerHTML = this.items.map((item, i) => `
      <button type="button" class="slash-menu-item${i === this.index ? " active" : ""}" data-index="${i}">
        <i data-lucide="${item.icon}"></i>
        <span>${item.command}</span>
      </button>
    `).join("");
    this.el.querySelectorAll(".slash-menu-item").forEach(btn => {
      btn.addEventListener("mousedown", e => {
        e.preventDefault();
        this.onSelect?.(this.items[Number(btn.dataset.index)]);
      });
    });
    if (window.lucide) window.lucide.createIcons();
  }

  move(delta) {
    if (!this.items.length) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.draw();
  }

  enter() {
    if (this.items.length) this.onSelect?.(this.items[this.index]);
  }

  reposition(rect) {
    if (!rect) return;
    this.el.style.top = `${rect.bottom + 6}px`;
    this.el.style.left = `${rect.left}px`;
  }

  show() { this.el.style.display = "block"; }
  hide() { this.el.style.display = "none"; }
  destroy() { this.el.remove(); }
}

// Typing "/name " runs exactly the same function the menu item runs, so both paths
// behave identically. The trigger text is removed first; the command is deferred to a
// microtask so it applies on the state that already has the trigger deleted.
function buildInputRules(commandsMap, editor) {
  return ITEMS.map(item => {
    const run = commandsMap[item.id];
    if (!run) return null;
    return new InputRule({
      find: new RegExp(`${item.command} $`, "i"),
      handler: ({ state, range }) => {
        state.tr.delete(range.from, range.to);
        queueMicrotask(() => run(editor));
      },
    });
  }).filter(Boolean);
}

export function createSlashCommand(commandsMap) {
  return Extension.create({
    name: "slashCommand",
    addInputRules() {
      return buildInputRules(commandsMap, this.editor);
    },
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: "/",
          startOfLine: false,
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run();
            commandsMap[props.id]?.(editor);
          },
          items: ({ query }) => {
            const q = query.toLowerCase();
            if (!q) return ITEMS;
            return ITEMS.filter(item =>
              item.command.slice(1).toLowerCase().includes(q) ||
              item.keywords.some(k => k.includes(q))
            );
          },
          render: () => {
            let menu;
            return {
              onStart: props => {
                menu = new SlashMenu();
                menu.setItems(props.items, item => props.command(item));
                menu.reposition(props.clientRect?.());
                menu.show();
              },
              onUpdate: props => {
                menu.setItems(props.items, item => props.command(item));
                menu.reposition(props.clientRect?.());
              },
              onKeyDown: props => {
                if (props.event.key === "Escape") {
                  menu.hide();
                  return true;
                }
                if (props.event.key === "ArrowDown") {
                  menu.move(1);
                  return true;
                }
                if (props.event.key === "ArrowUp") {
                  menu.move(-1);
                  return true;
                }
                if (props.event.key === "Enter") {
                  menu.enter();
                  return true;
                }
                return false;
              },
              onExit: () => {
                menu.destroy();
              },
            };
          },
        }),
      ];
    },
  });
}
