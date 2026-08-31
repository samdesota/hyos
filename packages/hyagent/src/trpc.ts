import { initTRPC } from "@trpc/server";
import { z } from "zod";

import type { LiterateAgent } from "./agent.js";
import {
  DEFAULT_AGENT,
  availableAgents,
  type AgentOption,
} from "./agent-options.js";
import type { FolderPicker } from "./folder-picker.js";
import type { ProjectTools } from "./project-tools.js";
import type { HyagentStore } from "./store.js";

const t = initTRPC.create();

export function createHyagentRouter(options: {
  store: HyagentStore;
  agent: LiterateAgent;
  project: ProjectTools;
  folderPicker?: FolderPicker;
  agentConfigured?: boolean;
  agents?: readonly AgentOption[];
  defaultAgent?: string;
}) {
  const activeRuns = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  const defaultAgent = options.defaultAgent ?? DEFAULT_AGENT;
  const agents = options.agents ?? availableAgents(defaultAgent);
  const agentIds = new Set(agents.map((agent) => agent.id));
  const agentInput = z
    .string()
    .trim()
    .refine((agent) => agentIds.has(agent), "Unknown agent")
    .default(defaultAgent);
  function launchAgent(sessionId: string, prompt: string, agent: string) {
    const controller = new AbortController();
    const run = options.agent
      .run(sessionId, prompt, agent, controller.signal)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => activeRuns.delete(sessionId));
    activeRuns.set(sessionId, { controller, promise: run });
  }
  async function sessionWorkspace(id: string) {
    const [session, repositories] = await Promise.all([
      options.store.getSession(id),
      options.store.getWorkspace(id),
    ]);
    return { session, repositories };
  }

  async function activateSession(id: string) {
    const opened = await sessionWorkspace(id);
    if (opened.repositories.length === 0) {
      throw new Error("Select a repository folder before starting the agent");
    }
    await options.project.configureRepositories(opened.repositories);
    return opened.session;
  }

  let initialSession: Promise<string> | undefined;
  function bootstrap(): Promise<string> {
    initialSession ??= (async () => {
      const session =
        (await options.store.latestUnfinishedSession()) ??
        (await options.store.createSession("New agent task"));
      const workspace = await options.store.getWorkspace(session.id);
      if (workspace.length > 0) {
        await options.project.configureRepositories(workspace);
      } else if (options.project.repositorySpecs().length > 0) {
        await options.store.saveWorkspace(
          session.id,
          options.project.repositorySpecs(),
        );
      }
      if (session.status === "running") {
        await options.store.setStatus(session.id, "failed");
      }
      return session.id;
    })();
    return initialSession;
  }

  return t.router({
    health: t.procedure.query(() => ({
      status: "ok" as const,
      agentConfigured: options.agentConfigured ?? true,
      agents,
      defaultAgent,
    })),
    workspace: t.router({
      recent: t.procedure.query(() => options.store.recentRepositories()),
      canBaseOnLatestRemoteMain: t.procedure
        .input(
          z.object({
            repositories: z
              .array(
                z.object({
                  name: z.string().trim().min(1).max(100),
                  root: z.string().trim().min(1).max(4_000),
                }),
              )
              .min(1)
              .max(20),
          }),
        )
        .query(({ input }) =>
          options.project.canBaseOnLatestRemoteMain(input.repositories),
        ),
      current: t.procedure.query(async () => {
        await bootstrap();
        return options.project.repositorySpecs();
      }),
      chooseFolder: t.procedure.mutation(async () => {
        if (!options.folderPicker) {
          throw new Error("The native folder picker is not configured");
        }
        return options.folderPicker.choose();
      }),
      configure: t.procedure
        .input(
          z.object({
            id: z.string().min(1).optional(),
            repositories: z
              .array(
                z.object({
                  name: z.string().trim().min(1).max(100),
                  root: z.string().trim().min(1).max(4_000),
                }),
              )
              .min(1)
              .max(20),
          }),
        )
        .mutation(async ({ input }) => {
          if (activeRuns.size > 0) {
            throw new Error(
              "Wait for the running agent before changing workspaces",
            );
          }
          const session = await options.store.getSession(
            input.id ?? (await bootstrap()),
          );
          const savedWorkspace = await options.store.getWorkspace(session.id);
          if (session.revision && savedWorkspace.length > 0) {
            throw new Error("This task already has a literate diff");
          }
          await options.project.configureRepositories(input.repositories);
          await options.store.saveWorkspace(
            session.id,
            options.project.repositorySpecs(),
          );
          await options.store.saveSourceRepositories(
            session.id,
            input.repositories,
          );
          await options.store.appendMessage(
            session.id,
            "system",
            `Workspace ready: ${options.project.repositoryNames().join(", ")}`,
          );
          return {
            repositories: options.project.repositorySpecs(),
            session: await options.store.getSession(session.id),
          };
        }),
    }),
    session: t.router({
      list: t.procedure.query(() => options.store.listSessions()),
      watchList: t.procedure.subscription(({ signal }) =>
        options.store.subscribeSessions(signal),
      ),
      bootstrap: t.procedure.query(async () =>
        options.store.getSession(await bootstrap()),
      ),
      initial: t.procedure.query(async () => {
        const sessions = await options.store.listSessions();
        const initial =
          sessions.find((session) => session.status !== "committed") ??
          sessions[0];
        return initial ? options.store.getSession(initial.id) : null;
      }),
      start: t.procedure
        .input(
          z.object({
            repositories: z
              .array(
                z.object({
                  name: z.string().trim().min(1).max(100),
                  root: z.string().trim().min(1).max(4_000),
                }),
              )
              .min(1)
              .max(20),
            mode: z.enum(["checkout", "worktree"]),
            baseOnLatestRemoteMain: z.boolean().default(false),
            prompt: z.string().trim().min(1).max(20_000),
            agent: agentInput,
          }),
        )
        .mutation(async ({ input }) => {
          if (activeRuns.size > 0) {
            throw new Error("The agent is already working on another task");
          }
          const repositories = await options.project.prepareRepositories(
            input.repositories,
            {
              mode: input.mode,
              baseOnLatestRemoteMain: input.baseOnLatestRemoteMain,
            },
          );
          const session = await options.store.createSession(
            input.prompt.split("\n")[0]!.slice(0, 100),
          );
          await options.store.saveWorkspace(session.id, repositories);
          await options.store.saveSourceRepositories(
            session.id,
            input.repositories,
          );
          await options.store.appendMessage(
            session.id,
            "system",
            `${input.mode === "worktree" ? "Worktree" : "Workspace"} ready: ${repositories.map((repository) => repository.name).join(", ")}`,
          );
          launchAgent(session.id, input.prompt, input.agent);
          return {
            repositories,
            session: await options.store.getSession(session.id),
          };
        }),
      archive: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .mutation(async ({ input }) => {
          if (activeRuns.has(input.id)) {
            throw new Error(
              "Wait for this agent run to finish before archiving",
            );
          }
          await options.store.archiveSession(input.id);
          return options.store.listSessions();
        }),
      open: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .query(({ input }) => sessionWorkspace(input.id)),
      get: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .query(({ input }) => options.store.getSession(input.id)),
      watch: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .subscription(({ input, signal }) =>
          options.store.subscribeSession(input.id, signal),
        ),
      feedback: t.procedure
        .input(
          z.object({
            id: z.string().min(1),
            feedback: z.string().trim().min(1).max(20_000),
            agent: agentInput,
          }),
        )
        .mutation(async ({ input }) => {
          if (activeRuns.size > 0) {
            throw new Error("The agent is already working on another task");
          }
          const session = await activateSession(input.id);
          if (session.status === "committed") {
            throw new Error("This literate diff is already committed");
          }
          if (session.status === "running") {
            throw new Error("The agent is already working on this task");
          }
          if (session.title === "New agent task") {
            await options.store.setTitle(
              input.id,
              input.feedback.split("\n")[0]!.slice(0, 100),
            );
          }
          launchAgent(input.id, input.feedback, input.agent);
          return { accepted: true as const };
        }),
      stop: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .mutation(async ({ input }) => {
          const active = activeRuns.get(input.id);
          if (!active) return options.store.getSession(input.id);
          active.controller.abort();
          await active.promise;
          return options.store.getSession(input.id);
        }),
      commit: t.procedure
        .input(z.object({ id: z.string().min(1) }))
        .mutation(async ({ input }) => {
          if (activeRuns.size > 0) {
            throw new Error("Wait for the running agent before committing");
          }
          const session = await activateSession(input.id);
          if (!session.revision)
            throw new Error("There is no literate diff to commit");
          if (session.status === "committed") return session;
          const finalPatchId = [...session.revision.blocks]
            .reverse()
            .find((block) => block.kind === "apply_patch")?.id;
          if ((finalPatchId ?? null) !== session.appliedThrough) {
            throw new Error(
              `Replay every patch step before accepting changes. Currently applied through ${session.appliedThrough ?? "the beginning"}; final step is ${finalPatchId ?? "none"}.`,
            );
          }
          const warnings = await options.project.checkConsistency(
            session.revision.generatedIgnores,
          );
          if (warnings.length > 0) {
            throw new Error(
              `The worktree contains changes outside the literate diff:\n${warnings.map((warning) => `- ${warning.message}`).join("\n")}`,
            );
          }
          const document = {
            summary: session.revision.summary,
            blocks: session.revision.blocks,
            generatedIgnores: session.revision.generatedIgnores,
          };
          const messages = await options.agent.writeCommitMessages(document);
          const commits = await options.project.commit(document, messages);
          await options.store.setStatus(input.id, "committed");
          await options.store.appendMessage(
            input.id,
            "system",
            `Committed revision ${session.revision.number}: ${commits
              .map(
                (commit) =>
                  `${commit.repository}@${commit.hash.slice(0, 7)} ${commit.message.split("\n")[0]}`,
              )
              .join(", ")}`,
          );
          return options.store.getSession(input.id);
        }),
    }),
  });
}

export type HyagentRouter = ReturnType<typeof createHyagentRouter>;
