import type { InferQueryResult, Query } from "@hyos/hydb";

import {
  commandHasOptimistic,
  executeOptimisticCommand,
  isClientCommand,
  parseCommandInput,
  parseCommandResult,
  type AnyClientCommand,
  type MutationTransaction,
} from "./command.js";
import type { GatewaySession } from "./gateway.js";
import type {
  CommandRegistry,
  RegistryCommandInput,
  RegistryCommandName,
  RegistryCommandResult,
  ServerCommandRegistry,
} from "./registry.js";

export type GatewayCommandRequest = Readonly<{
  invocationId: string;
  command: string;
  input: unknown;
}>;

export type GatewayCommandResponse = Readonly<{
  result: unknown;
  watermark?: number;
}>;

export interface GatewayClientTransport {
  fetch(query: Query<any>): Promise<unknown>;

  subscribe(
    query: Query<any>,
    listener: (result: unknown) => void,
    onError?: (error: unknown) => void,
  ): () => void;

  execute(request: GatewayCommandRequest): Promise<GatewayCommandResponse>;
}

export interface OptimisticLayer {
  readonly transaction: MutationTransaction;

  applied(): void | PromiseLike<void>;

  acknowledged(response: GatewayCommandResponse): void | PromiseLike<void>;

  rejected(error: unknown): void | PromiseLike<void>;
}

export interface OptimisticCoordinator {
  begin(
    request: GatewayCommandRequest,
  ): OptimisticLayer | PromiseLike<OptimisticLayer>;
}

export interface GatewayClient<Registry extends CommandRegistry> {
  readonly registry: Registry;

  fetch<QueryValue extends Query<any>>(
    query: QueryValue,
  ): Promise<InferQueryResult<QueryValue>>;

  subscribe<QueryValue extends Query<any>>(
    query: QueryValue,
    listener: (result: InferQueryResult<QueryValue>) => void,
    onError?: (error: unknown) => void,
  ): () => void;

  execute<Name extends RegistryCommandName<Registry>>(
    command: Name,
    input: RegistryCommandInput<Registry, Name>,
  ): Promise<RegistryCommandResult<Registry, Name>>;
}

function defaultInvocationId(): string {
  return globalThis.crypto.randomUUID();
}

async function rejectOptimisticLayer(
  layer: OptimisticLayer | undefined,
  error: unknown,
): Promise<never> {
  if (layer === undefined) throw error;
  try {
    await layer.rejected(error);
  } catch (rejectionError) {
    throw new AggregateError(
      [error, rejectionError],
      "Command failed and its optimistic layer could not be rejected",
    );
  }
  throw error;
}

export function gatewayClient<const Registry extends CommandRegistry>(options: {
  registry: Registry;
  transport: GatewayClientTransport;
  optimistic?: OptimisticCoordinator;
  createInvocationId?: () => string;
}): GatewayClient<Registry> {
  const registry = Object.freeze({ ...options.registry }) as Registry;
  for (const [name, command] of Object.entries(registry)) {
    if (!isClientCommand(command)) {
      throw new TypeError(
        `Gateway client command ${name} was not compiled for the client target`,
      );
    }
  }
  const createInvocationId = options.createInvocationId ?? defaultInvocationId;

  return Object.freeze({
    registry,

    fetch<QueryValue extends Query<any>>(
      query: QueryValue,
    ): Promise<InferQueryResult<QueryValue>> {
      return options.transport.fetch(query) as Promise<
        InferQueryResult<QueryValue>
      >;
    },

    subscribe<QueryValue extends Query<any>>(
      query: QueryValue,
      listener: (result: InferQueryResult<QueryValue>) => void,
      onError?: (error: unknown) => void,
    ): () => void {
      return options.transport.subscribe(
        query,
        listener as (result: unknown) => void,
        onError,
      );
    },

    async execute<Name extends RegistryCommandName<Registry>>(
      name: Name,
      input: RegistryCommandInput<Registry, Name>,
    ): Promise<RegistryCommandResult<Registry, Name>> {
      if (!Object.hasOwn(registry, name)) {
        throw new TypeError(`Unknown gateway command: ${name}`);
      }
      const command = registry[name] as AnyClientCommand;
      const request: GatewayCommandRequest = Object.freeze({
        invocationId: createInvocationId(),
        command: name,
        input,
      });
      let layer: OptimisticLayer | undefined;

      try {
        if (options.optimistic !== undefined && commandHasOptimistic(command)) {
          layer = await options.optimistic.begin(request);
          await executeOptimisticCommand(command, input, layer.transaction);
          await layer.applied();
        } else {
          await parseCommandInput(command, input);
        }
      } catch (error) {
        return rejectOptimisticLayer(layer, error);
      }

      let response: GatewayCommandResponse;
      let result: RegistryCommandResult<Registry, Name>;
      try {
        response = await options.transport.execute(request);
        result = await parseCommandResult(command, response.result);
      } catch (error) {
        return rejectOptimisticLayer(layer, error);
      }

      await layer?.acknowledged(response);
      return result;
    },
  });
}

export function directGatewayTransport<Commands extends ServerCommandRegistry>(
  session: GatewaySession<Commands>,
): GatewayClientTransport {
  return Object.freeze({
    fetch(query: Query<any>) {
      return session.fetch(query);
    },
    subscribe(query: Query<any>, listener: (result: unknown) => void) {
      return session.subscribe(query, listener);
    },
    async execute(request: GatewayCommandRequest) {
      const result = await session.execute(
        request.command as Extract<keyof Commands, string>,
        request.input as never,
      );
      return Object.freeze({ result });
    },
  });
}
