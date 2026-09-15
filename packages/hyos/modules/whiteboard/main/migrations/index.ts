import type { Migration } from "@hyos/hydb/node";

import migration0001 from "./0001-board-title.js";

/** The whiteboard storage history, oldest first. */
export const whiteboardMigrations: readonly Migration[] = [migration0001];
