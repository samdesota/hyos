import { renderHostClientScript } from "./host-client-script.js";
import { renderIterationOverlayHtml } from "./overlay-document.js";

export function renderClientScript(): string {
  return renderHostClientScript();
}

export function renderOverlayHtml(): string {
  return renderIterationOverlayHtml();
}
