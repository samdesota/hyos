import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
} from "@codemirror/view";
import { Button, Input } from "@hyos/components";
import { createSignal, onCleanup, onMount } from "solid-js";

import type { NoteDraft } from "./NoteComposer";

type InlineNoteEditorProps = Readonly<{
  title: string | null;
  content: string;
  onSave: (draft: NoteDraft) => void | Promise<void>;
  onCancel: () => void;
}>;

export function InlineNoteEditor(props: InlineNoteEditorProps) {
  let editorHost!: HTMLDivElement;
  let editorView: EditorView | undefined;

  const [title, setTitle] = createSignal(props.title ?? "");
  const [content, setContent] = createSignal(props.content);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const canSave = () => content().trim().length > 0 && !saving();

  onMount(() => {
    editorView = new EditorView({
      parent: editorHost,
      doc: props.content,
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({
          base: markdownLanguage,
          completeHTMLTags: false,
          pasteURLAsLink: false,
        }),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": "Edit note content",
          "aria-multiline": "true",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setContent(update.state.doc.toString());
            setError(undefined);
          }
        }),
      ],
    });

    editorView.focus();
  });

  onCleanup(() => editorView?.destroy());

  async function save() {
    if (!canSave()) return;

    setSaving(true);
    setError(undefined);
    try {
      const trimmedTitle = title().trim();
      await props.onSave({
        title: trimmedTitle || undefined,
        content: content().trim(),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save note");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      class="inline-note-editor"
      role="group"
      aria-label="Edit note"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <Input
        class="inline-note-editor__title"
        aria-label="Edit note title"
        placeholder="Title (optional)"
        value={title()}
        onInput={(event) => setTitle(event.currentTarget.value)}
      />
      <div class="inline-note-editor__content" ref={editorHost} />
      <div class="inline-note-editor__footer">
        <span>Markdown · ⌘↵ to save · Esc to cancel</span>
        <div class="inline-note-editor__actions">
          <Button
            type="button"
            variant="quiet"
            size="sm"
            disabled={saving()}
            onClick={props.onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canSave()}
            onClick={() => void save()}
          >
            {saving() ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {error() && (
        <p class="inline-note-editor__error" role="alert">
          {error()}
        </p>
      )}
    </div>
  );
}
