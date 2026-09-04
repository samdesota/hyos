import type { ThreadItem } from "@openai/codex-sdk";

import type {
  AgentActivity,
  AgentMessageStatus,
  AgentToolCategory,
} from "../../../capabilities/agent.js";
import type { AgentProvider, AgentRunSink } from "./types.js";
import { createPatchActivity, promptWithPatchContract } from "./patches.js";

function commandCategory(command: string): AgentToolCategory {
  const executable = command.trim().split(/\s+/, 1)[0]?.split("/").pop();
  if (
    executable &&
    ["cat", "find", "git", "head", "ls", "pwd", "rg", "sed", "tail"].includes(
      executable,
    )
  ) {
    return "read";
  }
  return "command";
}

function toolActivity(
  item: Exclude<
    ThreadItem,
    { type: "agent_message" | "reasoning" | "file_change" }
  >,
): AgentActivity {
  switch (item.type) {
    case "command_execution": {
      const category = commandCategory(item.command);
      return {
        type: "tool",
        category,
        label: category === "read" ? "Read files" : "Ran a command",
        detail: [item.command, item.aggregated_output]
          .filter(Boolean)
          .join("\n\n"),
      };
    }
    case "web_search":
      return {
        type: "tool",
        category: "search",
        label: "Searched the web",
        detail: item.query,
      };
    case "todo_list":
      return {
        type: "tool",
        category: "plan",
        label: "Updated the plan",
        detail: item.items
          .map((entry) => `${entry.completed ? "✓" : "○"} ${entry.text}`)
          .join("\n"),
      };
    case "mcp_tool_call":
      return {
        type: "tool",
        category: "tool",
        label: `Used ${item.tool}`,
        detail: JSON.stringify(item.arguments, null, 2),
      };
    case "error":
      return {
        type: "tool",
        category: "tool",
        label: "Tool error",
        detail: item.message,
      };
  }
}

function itemStatus(
  eventType: "item.started" | "item.updated" | "item.completed",
  item: ThreadItem,
): AgentMessageStatus {
  if (item.type === "command_execution" || item.type === "mcp_tool_call") {
    return item.status === "failed"
      ? "failed"
      : item.status === "completed"
        ? "complete"
        : "streaming";
  }
  if (item.type === "file_change") {
    return item.status === "failed" ? "failed" : "complete";
  }
  return eventType === "item.completed" ? "complete" : "streaming";
}

export function createCodexProvider(): AgentProvider {
  return {
    summary: {
      id: "codex",
      label: "Codex",
      models: [
        { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
        { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
        { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      ],
    },
    async run(input, sink: AgentRunSink, signal) {
      const { Codex } = await import("@openai/codex-sdk");
      const codex = new Codex();
      const options = {
        model: input.modelId,
        workingDirectory: input.folder,
        skipGitRepoCheck: true,
        sandboxMode: "workspace-write" as const,
        approvalPolicy: "never" as const,
      };
      const thread = input.providerSessionId
        ? codex.resumeThread(input.providerSessionId, options)
        : codex.startThread(options);
      const streamed = await thread.runStreamed(
        promptWithPatchContract(input.prompt),
        { signal },
      );
      let providerSessionId = input.providerSessionId;
      let pendingMessage: { id: string; text: string } | null = null;
      const patchExplanations = new Map<string, string>();

      const commitCommentary = async (): Promise<void> => {
        if (!pendingMessage?.text.trim()) return;
        await sink.activity(
          `commentary:${pendingMessage.id}`,
          { type: "commentary", text: pendingMessage.text },
          "complete",
        );
        pendingMessage = null;
      };

      for await (const event of streamed.events) {
        if (event.type === "thread.started") {
          providerSessionId = event.thread_id;
          await sink.session(event.thread_id);
          continue;
        }
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "turn.completed") {
          if (pendingMessage?.text) await sink.response(pendingMessage.text);
          pendingMessage = null;
          continue;
        }
        if (
          event.type !== "item.started" &&
          event.type !== "item.updated" &&
          event.type !== "item.completed"
        )
          continue;

        const { item } = event;
        if (item.type === "agent_message") {
          if (pendingMessage && pendingMessage.id !== item.id)
            await commitCommentary();
          if (event.type === "item.completed")
            pendingMessage = { id: item.id, text: item.text };
          continue;
        }

        const pendingExplanation = pendingMessage?.text ?? "";
        await commitCommentary();
        if (item.type === "reasoning") {
          await sink.activity(
            `reasoning:${item.id}`,
            { type: "commentary", text: item.text },
            event.type === "item.completed" ? "complete" : "streaming",
          );
          continue;
        }
        if (item.type === "file_change") {
          if (!patchExplanations.has(item.id)) {
            patchExplanations.set(item.id, pendingExplanation);
          }
          const changes = item.changes.map(({ path, kind }) => ({
            path,
            kind,
          }));
          const activity = await createPatchActivity({
            folder: input.folder,
            explanation: patchExplanations.get(item.id) ?? "",
            changes,
            fallbackDiff: changes
              .map(({ kind, path }) => `${kind}: ${path}`)
              .join("\n"),
          });
          await sink.activity(
            `patch:${item.id}`,
            activity,
            itemStatus(event.type, item),
          );
          continue;
        }
        await sink.activity(
          `tool:${item.id}`,
          toolActivity(item),
          itemStatus(event.type, item),
        );
      }

      if (pendingMessage?.text) await sink.response(pendingMessage.text);
      return { providerSessionId: providerSessionId ?? thread.id };
    },
  };
}
