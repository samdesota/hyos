import { X } from "lucide-solid";
import type { JSX } from "solid-js";

export function Dialog(props: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: JSX.Element;
}) {
  return (
    <div
      class="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) =>
        event.target === event.currentTarget && props.onClose()
      }
    >
      <section
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
      >
        <header>
          <div>
            <h2>{props.title}</h2>
            <p>{props.subtitle}</p>
          </div>
          <button
            class="icon-button"
            aria-label="Close dialog"
            onClick={props.onClose}
          >
            <X size={18} />
          </button>
        </header>
        {props.children}
      </section>
    </div>
  );
}
