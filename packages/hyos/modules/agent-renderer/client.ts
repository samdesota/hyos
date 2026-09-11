import {
  agentCapability,
  type AgentCommand,
  type AgentCommandResult,
  type AgentFeedChange,
  type AgentFileContent,
  type AgentGlobalTabRow,
  type AgentMessageChange,
  type AgentMessageCursor,
  type AgentMessagePage,
  type AgentProviderSummary,
  type AgentSessionsState,
  type AgentSessionTabs,
  type AgentSessionTabsChange,
} from "../../capabilities/agent.js";
import {
  keybindingCapability,
  type KeybindingAccelerator,
  type KeybindingAction,
} from "../../capabilities/keybinding.js";
import type {
  RemoteConsumer,
  RendererRemoteCapabilities,
} from "../../remote-capabilities.js";

export type AgentMessageFeed = Readonly<{
  initial: AgentMessagePage;
  subscribe(listener: (change: AgentMessageChange) => void): () => void;
  close(): void;
}>;

/** Renderer handle over the `keybinding` capability: app-level accelerators. */
export interface KeybindingClient {
  register(binding: {
    action: KeybindingAction;
    accelerator: KeybindingAccelerator;
  }): Promise<void>;
  unregister(action: KeybindingAction): Promise<void>;
  onTriggered(
    listener: (event: { action: KeybindingAction }) => void,
  ): () => void;
  dispose(): void;
}

export function createKeybindingClient(
  remote: RendererRemoteCapabilities,
): KeybindingClient {
  const keybinding: RemoteConsumer<typeof keybindingCapability> =
    remote.consume(keybindingCapability);
  let listener: ((event: { action: KeybindingAction }) => void) | null = null;
  const unsubscribe = keybinding.subscribe("triggered", (payload) =>
    listener?.(payload),
  );
  return {
    register: (binding) => keybinding.call("register", binding),
    unregister: (action) => keybinding.call("unregister", action),
    onTriggered(next) {
      listener = next;
      return () => {
        if (listener === next) listener = null;
      };
    },
    dispose() {
      unsubscribe();
      listener = null;
    },
  };
}

export interface AgentClient {
  execute(command: AgentCommand): Promise<AgentCommandResult>;
  providers(): Promise<readonly AgentProviderSummary[]>;
  sessions(): Promise<AgentSessionsState>;
  subscribeSessions(listener: (state: AgentSessionsState) => void): () => void;
  /** Fires whenever a session's persisted tab strip changes in the database. */
  subscribeSessionTabs(
    listener: (change: AgentSessionTabsChange) => void,
  ): () => void;
  /** Fires whenever the persisted global tab strip changes in the database. */
  subscribeGlobalTabs(listener: () => void): () => void;
  openFeed(sessionId: string, newestCount?: number): Promise<AgentMessageFeed>;
  loadOlder(
    sessionId: string,
    before: AgentMessageCursor,
    count?: number,
  ): Promise<AgentMessagePage>;
  readFile(sessionId: string, path: string): Promise<AgentFileContent>;
  sessionTabs(sessionId: string): Promise<AgentSessionTabs | null>;
  saveSessionTabs(
    sessionId: string,
    tabs: AgentSessionTabs | null,
  ): Promise<void>;
  globalTabs(): Promise<readonly AgentGlobalTabRow[]>;
  replaceGlobalTabs(tabs: readonly AgentGlobalTabRow[]): Promise<void>;
  dispose(): void;
}

type LocalFeed = {
  sequence: number;
  listeners: Set<(change: AgentMessageChange) => void>;
  pending: AgentMessageChange[];
};

export function createAgentClient(
  remote: RendererRemoteCapabilities,
): AgentClient {
  const agent: RemoteConsumer<typeof agentCapability> =
    remote.consume(agentCapability);
  const feeds = new Map<string, LocalFeed>();
  const orphaned = new Map<string, AgentMessageChange[]>();

  const receiveFeedChange = ({ feedId, change }: AgentFeedChange): void => {
    const feed = feeds.get(feedId);
    if (!feed) {
      const pending = orphaned.get(feedId) ?? [];
      pending.push(change);
      orphaned.set(feedId, pending);
      return;
    }
    if (change.sequence <= feed.sequence) return;
    feed.sequence = change.sequence;
    if (feed.listeners.size === 0) feed.pending.push(change);
    else for (const listener of feed.listeners) listener(change);
  };

  const unsubscribeFeedEvents = agent.subscribe(
    "messageChange",
    receiveFeedChange,
  );

  return {
    execute: (command) => agent.call("execute", command),
    providers: () => agent.call("providers"),
    sessions: () => agent.call("sessions"),
    subscribeSessions: (listener) => agent.subscribe("sessions", listener),
    subscribeSessionTabs: (listener) =>
      agent.subscribe("sessionTabs", listener),
    subscribeGlobalTabs: (listener) => agent.subscribe("globalTabs", listener),
    async openFeed(sessionId, newestCount = 200) {
      const opened = await agent.call("openFeed", sessionId, newestCount);
      const feed: LocalFeed = {
        sequence: opened.sequence,
        listeners: new Set(),
        pending: [],
      };
      feeds.set(opened.feedId, feed);
      for (const change of orphaned.get(opened.feedId) ?? []) {
        receiveFeedChange({ feedId: opened.feedId, change });
      }
      orphaned.delete(opened.feedId);
      let closed = false;
      return {
        initial: opened.page,
        subscribe(listener) {
          if (closed) throw new Error("Message feed is closed");
          feed.listeners.add(listener);
          for (const change of feed.pending.splice(0)) listener(change);
          return () => feed.listeners.delete(listener);
        },
        close() {
          if (closed) return;
          closed = true;
          feeds.delete(opened.feedId);
          orphaned.delete(opened.feedId);
          void agent.call("closeFeed", opened.feedId);
        },
      };
    },
    loadOlder: (sessionId, before, count = 200) =>
      agent.call("loadOlder", sessionId, before, count),
    readFile: (sessionId, path) => agent.call("readFile", sessionId, path),
    sessionTabs: (sessionId) => agent.call("sessionTabs", sessionId),
    saveSessionTabs: (sessionId, tabs) =>
      agent.call("saveSessionTabs", sessionId, tabs),
    globalTabs: () => agent.call("globalTabs"),
    replaceGlobalTabs: (tabs) => agent.call("replaceGlobalTabs", tabs),
    dispose() {
      unsubscribeFeedEvents();
      feeds.clear();
      orphaned.clear();
    },
  };
}
