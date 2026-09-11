/**
 * Styles for the whiteboard surface. The renderer module injects them into
 * the document head once at startup — whiteboard styling travels with the
 * module, not with the app shell's stylesheet.
 */
export const whiteboardStyles = String.raw`
  .whiteboard-page { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: #1d1e1b; }
  .whiteboard-canvas { position: relative; width: 100%; height: 100%; overflow: hidden; cursor: grab; touch-action: none; }
  .whiteboard-canvas.panning { cursor: grabbing; }
  .whiteboard-world { position: absolute; top: 0; left: 0; width: 0; height: 0; transform-origin: 0 0; will-change: transform; }
  .whiteboard-card {
    position: absolute; width: 240px; padding: 10px 12px;
    border: 1px solid #343630; border-radius: 12px; background: #20211e;
    box-shadow: 0 2px 10px #00000055; cursor: grab;
  }
  .whiteboard-card.dragging { cursor: grabbing; }
  .whiteboard-card.editing { border-color: #b2cb8c; cursor: text; }
  .whiteboard-card-body { color: #f2f0ea; font-size: 13px; line-height: 1.5; word-wrap: break-word; }
  .whiteboard-card-body > :first-child { margin-top: 0; }
  .whiteboard-card-body > :last-child { margin-bottom: 0; }
  .whiteboard-card-body code { padding: 1px 4px; border-radius: 4px; background: #171816; font-size: 12px; }
  .whiteboard-card-body pre { padding: 8px; border-radius: 8px; background: #171816; overflow-x: auto; }
  .whiteboard-card-image { display: block; max-width: 100%; border-radius: 6px; user-select: none; }
  .whiteboard-card-editor {
    display: block; width: 100%; min-height: 64px; resize: none; border: 0; outline: 0;
    color: #f2f0ea; background: transparent; font: inherit; line-height: 1.5;
  }
  .whiteboard-hint {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    margin: 0; color: #6f716a; font-size: 13px; user-select: none; pointer-events: none;
  }
  .whiteboard-zoom {
    position: absolute; right: 12px; bottom: 12px; padding: 3px 9px;
    border: 1px solid #343630; border-radius: 999px; background: #20211ecc;
    color: #8e9087; font-size: 11px; line-height: 16px; user-select: none;
  }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    border: 0; clip: rect(0 0 0 0); clip-path: inset(50%); overflow: hidden; white-space: nowrap;
  }
`;
