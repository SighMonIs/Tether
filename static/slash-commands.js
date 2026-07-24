import { Extension, textblockTypeInputRule, wrappingInputRule, nodeInputRule } from "https://esm.sh/@tiptap/core@2.27.2";
import Suggestion from "https://esm.sh/@tiptap/suggestion@2.27.2?deps=@tiptap/core@2.27.2";

const ITEMS = [
  { id: "heading1", command: "/heading1", keywords: ["h1", "heading1", "title"], icon: "heading-1", rule: { kind: "textblock", type: "heading", attrs: { level: 1 } } },
  { id: "heading2", command: "/heading2", keywords: ["h2", "heading2", "subtitle"], icon: "heading-2", rule: { kind: "textblock", type: "heading", attrs: { level: 2 } } },
  { id: "heading3", command: "/heading3", keywords: ["h3", "heading3"], icon: "heading-3", rule: { kind: "textblock", type: "heading", attrs: { level: 3 } } },
  { id: "bulletList", command: "/bulletlist", keywords: ["bullet", "ul", "list", "unordered"], icon: "list", rule: { kind: "wrapping", type: "bulletList" } },
  { id: "orderedList", command: "/numberedlist", keywords: ["ordered", "ol", "number", "numbered"], icon: "list-ordered", rule: { kind: "wrapping", type: "orderedList" } },
  { id: "taskList", command: "/tasklist", keywords: ["task", "todo", "checklist", "checkbox"], icon: "list-checks", rule: { kind: "wrapping", type: "taskList" } },
  { id: "blockquote", command: "/quote", keywords: ["quote", "blockquote"], icon: "quote", rule: { kind: "wrapping", type: "blockquote" } },
  { id: "codeBlock", command: "/code", keywords: ["code", "codeblock", "pre"], icon: "square-code", rule: { kind: "textblock", type: "codeBlock" } },
  { id: "horizontalRule", command: "/divider", keywords: ["divider", "hr", "rule", "line"], icon: "minus", rule: { kind: "node", type: "horizontalRule" } },
  { id: "bold", command: "/bold", keywords: ["bold", "b", "strong"], icon: "bold" },
  { id: "italic", command: "/italic", keywords: ["italic", "i", "em"], icon: "italic" },
  { id: "underline", command: "/underline", keywords: ["underline", "u"], icon: "underline" },
  { id: "strike", command: "/strikethrough", keywords: ["strike", "strikethrough", "s"], icon: "strikethrough" },
  { id: "code", command: "/inlinecode", keywords: ["code", "inline", "inlinecode"], icon: "code" },
  { id: "link", command: "/link", keywords: ["link", "url", "hyperlink"], icon: "link" },
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

function buildInputRules(commandsMap, editor) {
  return ITEMS.filter(item => item.rule).map(item => {
    const nodeType = editor.schema.nodes[item.rule.type];
    if (!nodeType) return null;
    const find = new RegExp(`^${item.command}\\s$`, "i");
    if (item.rule.kind === "textblock") {
      return textblockTypeInputRule({ find, type: nodeType, getAttributes: () => item.rule.attrs });
    }
    if (item.rule.kind === "wrapping") {
      return wrappingInputRule({ find, type: nodeType });
    }
    if (item.rule.kind === "node") {
      return nodeInputRule({ find, type: nodeType });
    }
    return null;
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
