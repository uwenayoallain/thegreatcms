/** The visual editor — ProseMirror directly, no wrapper. */

import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import {
  DOMParser as PmDOMParser,
  DOMSerializer,
  type MarkType,
  type NodeType,
  Schema,
} from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes, liftListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

/** Basic marks and nodes, plus lists. Deliberately small: this edits web copy. */
const schema = new Schema({
  nodes: addListNodes(basicSchema.spec.nodes, "paragraph block*", "block"),
  marks: basicSchema.spec.marks,
});

const marks = schema.marks as Record<string, MarkType>;
const nodes = schema.nodes as Record<string, NodeType>;

interface Tool {
  label: string;
  /** Lucide line icon paths (ISC), drawn inline so the toolbar needs no font or image. */
  icon: string;
  title: string;
  command: Command;
  /** Decides the pressed state, so the toolbar describes where the cursor is. */
  isActive: (state: EditorState) => boolean;
}

function markActive(type: MarkType) {
  return (state: EditorState): boolean => {
    const { from, $from, to, empty } = state.selection;
    return empty
      ? Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
      : state.doc.rangeHasMark(from, to, type);
  };
}

function blockActive(type: NodeType, attrs: Record<string, unknown> = {}) {
  return (state: EditorState): boolean => {
    const { $from, to, node } = state.selection as never as {
      $from: {
        parent: { hasMarkup: (t: NodeType, a?: Record<string, unknown>) => boolean };
        depth: number;
      };
      to: number;
      node?: { hasMarkup: (t: NodeType, a?: Record<string, unknown>) => boolean };
    };
    if (node) return node.hasMarkup(type, attrs);
    return to <= (state.selection.$from.end() as number) && $from.parent.hasMarkup(type, attrs);
  };
}

const svg = (paths: string) =>
  `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const TOOLS: Tool[] = [
  {
    label: "B",
    icon: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
    title: "Bold",
    command: toggleMark(marks.strong as MarkType),
    isActive: markActive(marks.strong as MarkType),
  },
  {
    label: "I",
    icon: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
    title: "Italic",
    command: toggleMark(marks.em as MarkType),
    isActive: markActive(marks.em as MarkType),
  },
  {
    label: "H2",
    icon: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>',
    title: "Heading level 2",
    command: setBlockType(nodes.heading as NodeType, { level: 2 }),
    isActive: blockActive(nodes.heading as NodeType, { level: 2 }),
  },
  {
    label: "H3",
    icon: '<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/>',
    title: "Heading level 3",
    command: setBlockType(nodes.heading as NodeType, { level: 3 }),
    isActive: blockActive(nodes.heading as NodeType, { level: 3 }),
  },
  {
    label: "¶",
    icon: '<path d="M13 4v16"/><path d="M17 4v16"/><path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
    title: "Paragraph",
    command: setBlockType(nodes.paragraph as NodeType),
    isActive: blockActive(nodes.paragraph as NodeType),
  },
  {
    label: "•",
    icon: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
    title: "Bullet list",
    command: wrapInList(nodes.bullet_list as NodeType),
    isActive: () => false,
  },
  {
    label: "1.",
    icon: '<path d="M11 12h10"/><path d="M11 18h10"/><path d="M11 6h10"/><path d="M4 10h2"/><path d="M4 6h1v4"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
    title: "Numbered list",
    command: wrapInList(nodes.ordered_list as NodeType),
    isActive: () => false,
  },
  {
    label: "❝",
    icon: '<path d="M17 6H3"/><path d="M21 12H8"/><path d="M21 18H8"/><path d="M3 12v6"/>',
    title: "Quote",
    command: wrapIn(nodes.blockquote as NodeType),
    isActive: blockActive(nodes.blockquote as NodeType),
  },
  {
    label: "</>",
    icon: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    title: "Code",
    command: toggleMark(marks.code as MarkType),
    isActive: markActive(marks.code as MarkType),
  },
];

function toHtml(state: EditorState): string {
  const fragment = DOMSerializer.fromSchema(schema).serializeFragment(state.doc.content);
  const holder = document.createElement("div");
  holder.append(fragment);
  const html = holder.innerHTML;
  // An empty document serializes to an empty paragraph; store nothing instead, so "no value".
  return html === "<p></p>" || html === "<p><br></p>" ? "" : html;
}

function parseHtml(value: string) {
  // An inert document: stored HTML loads nothing and runs nothing while it is being read.
  const inert = new DOMParser().parseFromString(value, "text/html");
  return PmDOMParser.fromSchema(schema).parse(inert.body);
}

function enhance(textarea: HTMLTextAreaElement): void {
  const shell = document.createElement("div");
  shell.className = "editor";

  const toolbar = document.createElement("div");
  toolbar.className = "editor-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Text formatting");

  const surface = document.createElement("div");
  surface.className = "editor-surface";

  shell.append(toolbar, surface);
  textarea.insertAdjacentElement("afterend", shell);

  const label = document.querySelector<HTMLLabelElement>(`label[for="${textarea.id}"]`);
  const describedBy = textarea.getAttribute("aria-describedby");

  const view = new EditorView(surface, {
    state: EditorState.create({
      doc: parseHtml(textarea.value),
      plugins: [
        history(),
        keymap({
          "Mod-z": undo,
          "Mod-y": redo,
          "Shift-Mod-z": redo,
          "Mod-b": toggleMark(marks.strong as MarkType),
          "Mod-i": toggleMark(marks.em as MarkType),
          Enter: splitListItem(nodes.list_item as NodeType),
          "Shift-Tab": liftListItem(nodes.list_item as NodeType),
        }),
        keymap(baseKeymap),
      ],
    }),
    attributes: {
      // Without these the editing surface is an unlabelled div to a screen reader, which.
      role: "textbox",
      "aria-multiline": "true",
      "aria-label": label?.textContent?.trim() || "Rich text",
      ...(describedBy ? { "aria-describedby": describedBy } : {}),
    },
    dispatchTransaction(transaction) {
      const next = view.state.apply(transaction);
      view.updateState(next);
      textarea.value = toHtml(next);
      syncToolbar(next);
    },
  });

  // Only hide the textarea once the editor is actually up, so a throw above.
  textarea.hidden = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.tabIndex = -1;

  const buttons = TOOLS.map((tool) => {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = svg(tool.icon);
    button.title = tool.title;
    button.setAttribute("aria-label", tool.title);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      tool.command(view.state, view.dispatch, view);
      view.focus();
    });
    toolbar.append(button);
    return button;
  });

  const linkButton = document.createElement("button");
  linkButton.type = "button";
  linkButton.innerHTML = svg(
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  );
  linkButton.title = "Add or edit a link";
  linkButton.setAttribute("aria-label", "Add or edit a link");
  linkButton.addEventListener("click", (event) => {
    event.preventDefault();
    const linkMark = marks.link as MarkType;
    const { from, to, empty } = view.state.selection;
    if (empty) {
      window.alert("Select the text you want to turn into a link first.");
      return;
    }
    const href = window.prompt("Link URL (leave empty to remove)", "https://");
    if (href === null) return;
    const transaction = view.state.tr;
    transaction.removeMark(from, to, linkMark);
    if (href !== "") transaction.addMark(from, to, linkMark.create({ href }));
    view.dispatch(transaction);
    view.focus();
  });
  toolbar.append(linkButton);

  function syncToolbar(state: EditorState): void {
    buttons.forEach((button, index) => {
      const tool = TOOLS[index];
      if (!tool) return;
      button.setAttribute("aria-pressed", tool.isActive(state) ? "true" : "false");
    });
  }

  syncToolbar(view.state);
}

function start(): void {
  for (const textarea of document.querySelectorAll<HTMLTextAreaElement>(
    "textarea[data-richtext]",
  )) {
    try {
      enhance(textarea);
    } catch (error) {
      textarea.hidden = false;
      textarea.removeAttribute("aria-hidden");
      textarea.tabIndex = 0;
      console.error("Visual editor failed to start; using the plain textarea.", error);
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
