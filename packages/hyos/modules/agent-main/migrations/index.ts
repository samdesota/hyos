import type { Migration } from "@hyos/hydb/node";

import migration0001 from "./0001-agent-sessions-archived-at.js";
import migration0002 from "./0002-agent-message-token-columns.js";
import migration0003 from "./0003-agent-sessions-plan.js";
import migration0004 from "./0004-agent-sessions-tabs.js";
import migration0005 from "./0005-agent-sessions-status-detail.js";
import migration0006 from "./0006-agent-sessions-order.js";
import migration0007 from "./0007-agent-board-tables.js";
import migration0008 from "./0008-agent-global-tabs.js";
import migration0009 from "./0009-agent-sessions-seen-status-detail.js";
import migration0010 from "./0010-agent-folder-state.js";

/**
 * The agent storage history, oldest first. The order mirrors the deprecated
 * inline migration options exactly (nullable column groups, then table
 * additions, then post-table nullable columns) so existing storages — whose
 * progress markers were written against the grouped step list — resume
 * correctly through the fingerprint-validated marker check.
 */
export const agentMigrations: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
];
