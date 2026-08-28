import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type TelemetrySource = "frontend" | "backend" | "agent";
export type TelemetryLevel = "debug" | "info" | "warn" | "error";

export interface TelemetryEntry {
  source: TelemetrySource;
  level: TelemetryLevel;
  event: string;
  message: string;
  requestId?: string;
  data?: unknown;
  timestamp?: number;
}

export interface TelemetryStore {
  log(entry: TelemetryEntry): void;
  recent(limit?: number): Array<Record<string, unknown>>;
  close(): void;
}

export interface DevelopmentTelemetryOptions {
  enabled?: boolean;
  databasePath?: string;
}

const disabledStore: TelemetryStore = {
  log() {},
  recent() {
    return [];
  },
  close() {},
};

export function createDevelopmentTelemetry(
  projectRoot: string,
  options: DevelopmentTelemetryOptions = {},
): TelemetryStore {
  if (options.enabled === false || process.env.NODE_ENV === "production") {
    return disabledStore;
  }

  const databasePath =
    options.databasePath ??
    join(projectRoot, ".hy-ui-agent", "development.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      source TEXT NOT NULL,
      level TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT NOT NULL,
      request_id TEXT,
      data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS logs_request_id ON logs(request_id, timestamp);
    CREATE INDEX IF NOT EXISTS logs_timestamp ON logs(timestamp);
  `);
  const insert = database.prepare(`
    INSERT INTO logs (timestamp, source, level, event, message, request_id, data_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRecent = database.prepare(`
    SELECT id, timestamp, source, level, event, message,
      request_id AS requestId, data_json AS dataJson
    FROM logs ORDER BY id DESC LIMIT ?
  `);
  const prune = database.prepare(`
    DELETE FROM logs WHERE id <= (SELECT MAX(id) - 50000 FROM logs)
  `);
  let entriesSincePrune = 0;

  return {
    log(entry) {
      let dataJson: string | null = null;
      if (entry.data !== undefined) {
        try {
          dataJson = JSON.stringify(entry.data);
        } catch {
          dataJson = JSON.stringify({ serializationError: true });
        }
      }
      insert.run(
        entry.timestamp ?? Date.now(),
        entry.source,
        entry.level,
        entry.event,
        entry.message,
        entry.requestId ?? null,
        dataJson,
      );
      entriesSincePrune += 1;
      if (entriesSincePrune >= 500) {
        prune.run();
        entriesSincePrune = 0;
      }
    },
    recent(limit = 200) {
      return selectRecent.all(Math.min(Math.max(limit, 1), 1_000));
    },
    close() {
      database.close();
    },
  };
}
