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
  placeholder,
} from "@codemirror/view";
import { Button, IconButton, Input } from "@hyos/components";
import { createSignal, onCleanup, onMount } from "solid-js";

export type NoteDraft = Readonly<{
  title?: string;
  content: string;
}>;

type NoteComposerProps = Readonly<{
  onSubmit: (draft: NoteDraft) => void | Promise<void>;
}>;

type InlineFormat = Readonly<{
  label: string;
  title: string;
  before: string;
  after: string;
  placeholder: string;
}>;

const inlineFormats: readonly InlineFormat[] = [
  {
    label: "B",
    title: "Bold",
    before: "**",
    after: "**",
    placeholder: "bold text",
  },
  {
    label: "I",
    title: "Italic",
    before: "_",
    after: "_",
    placeholder: "italic text",
  },
  {
    label: "<>",
    title: "Inline code",
    before: "`",
    after: "`",
    placeholder: "code",
  },
  {
    label: "↗",
    title: "Link",
    before: "[",
    after: "](https://)",
    placeholder: "link text",
  },
];

export function NoteComposer(props: NoteComposerProps) {
  let editorHost!: HTMLDivElement;
  let editorView: EditorView | undefined;

  const [title, setTitle] = createSignal("");
  const [content, setContent] = createSignal("");
  const [focused, setFocused] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const canSubmit = () => content().trim().length > 0 && !submitting();

  onMount(() => {
    const handleComposerShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void submit();
      }
    };

    editorHost.addEventListener("keydown", handleComposerShortcut, true);

    editorView = new EditorView({
      parent: editorHost,
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
        placeholder("Write in Markdown…"),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": "Note content",
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

    onCleanup(() => {
      editorHost.removeEventListener("keydown", handleComposerShortcut, true);
    });
  });

  onCleanup(() => editorView?.destroy());

  function applyInlineFormat(format: InlineFormat) {
    const view = editorView;
    if (!view) return;

    const selection = view.state.selection.main;
    const selected = view.state.sliceDoc(selection.from, selection.to);
    const value = selected || format.placeholder;
    const replacement = `${format.before}${value}${format.after}`;
    const anchor = selection.from + format.before.length;

    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: replacement },
      selection: {
        anchor,
        head: anchor + value.length,
      },
      scrollIntoView: true,
    });
    view.focus();
  }

  function prefixSelectedLines(prefix: string) {
    const view = editorView;
    if (!view) return;

    const selection = view.state.selection.main;
    const firstLine = view.state.doc.lineAt(selection.from);
    const lastLine = view.state.doc.lineAt(selection.to);
    const changes = [];

    for (
      let number = firstLine.number;
      number <= lastLine.number;
      number += 1
    ) {
      changes.push({ from: view.state.doc.line(number).from, insert: prefix });
    }

    view.dispatch({ changes, scrollIntoView: true });
    view.focus();
  }

  async function submit() {
    if (!canSubmit()) return;

    setSubmitting(true);
    setError(undefined);

    try {
      const trimmedTitle = title().trim();
      await props.onSubmit({
        title: trimmedTitle || undefined,
        content: content().trim(),
      });

      setTitle("");
      editorView?.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: "" },
      });
      editorView?.focus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save note");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      class="note-composer"
      classList={{ "note-composer--focused": focused() }}
      aria-label="New note"
      onFocusIn={() => setFocused(true)}
      onFocusOut={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
        }
      }}
    >
      <Input
        class="note-composer__title"
        aria-label="Note title"
        placeholder="Title (optional)"
        value={title()}
        onInput={(event) => setTitle(event.currentTarget.value)}
      />

      <div class="note-composer__editor" ref={editorHost} />

      <div class="note-composer__footer">
        <div class="note-composer__tools" aria-label="Markdown formatting">
          {inlineFormats.map((format) => (
            <IconButton
              type="button"
              class="format-button"
              classList={{ "format-button--italic": format.title === "Italic" }}
              aria-label={format.title}
              title={format.title}
              onClick={() => applyInlineFormat(format)}
            >
              {format.label}
            </IconButton>
          ))}
          <span class="format-divider" aria-hidden="true" />
          <IconButton
            type="button"
            class="format-button format-button--wide"
            aria-label="Bulleted list"
            title="Bulleted list"
            onClick={() => prefixSelectedLines("- ")}
          >
            • list
          </IconButton>
          <IconButton
            type="button"
            class="format-button"
            aria-label="Quote"
            title="Quote"
            onClick={() => prefixSelectedLines("> ")}
          >
            “
          </IconButton>
        </div>

        <Button
          type="button"
          variant="primary"
          size="sm"
          class="capture-button"
          disabled={!canSubmit()}
          onClick={() => void submit()}
        >
          {submitting() ? "Saving…" : "Capture note"}
          <span aria-hidden="true">↑</span>
        </Button>
      </div>

      {error() && (
        <p class="note-composer__error" role="alert">
          {error()}
        </p>
      )}
    </section>
  );
}
