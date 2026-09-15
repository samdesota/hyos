import type { AgentMessageStatus } from "../../capabilities/agent.js";
import type { AgentStore } from "./store.js";

/** Providers send cumulative snapshots; persist only their new suffix, in batches. */
export function createCommentaryWriter(
  store: Pick<AgentStore, "appendCommentary">,
  sessionId: string,
) {
  type Entry = {
    id: string | null;
    index: number;
    text: string;
    persisted: string;
    status: AgentMessageStatus;
    savedStatus?: AgentMessageStatus;
  };
  const entries = new Map<string, Entry>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    writes = writes.then(async () => {
      for (const entry of entries.values()) {
        const text = entry.text;
        const status = entry.status;
        if (text === entry.persisted && status === entry.savedStatus) continue;
        const replace = !text.startsWith(entry.persisted);
        entry.id = await store.appendCommentary(
          sessionId,
          entry.id,
          entry.index,
          replace ? text : text.slice(entry.persisted.length),
          status,
          replace,
        );
        entry.persisted = text;
        entry.savedStatus = status;
        entry.index++;
      }
    });
    return writes;
  };
  return {
    async update(key: string, text: string, status: AgentMessageStatus) {
      let entry = entries.get(key);
      if (!entry) {
        entry = { id: null, index: 0, text, persisted: "", status };
        entries.set(key, entry);
      } else {
        entry.text = text;
        entry.status = status;
      }
      if (
        status !== "streaming" ||
        entry.text.length - entry.persisted.length >= 2048
      )
        return flush();
      if (!timer)
        timer = setTimeout(() => {
          void flush().catch(() => {});
        }, 80);
    },
    flush,
    async close(status: AgentMessageStatus = "complete") {
      for (const entry of entries.values())
        if (entry.status === "streaming") entry.status = status;
      await flush();
    },
  };
}
