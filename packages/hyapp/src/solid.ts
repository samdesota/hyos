import type { InferQueryResult, Query } from "@hyos/hydb";
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

import type { GatewayClient } from "./gateway-client.js";
import type {
  CommandRegistry,
  RegistryCommandInput,
  RegistryCommandName,
  RegistryCommandResult,
} from "./registry.js";

export type GatewaySource<Value> = Value | Accessor<Value>;

export type GatewayQueryState<Result> = Readonly<{
  data: Accessor<Result | undefined>;
  loading: Accessor<boolean>;
  error: Accessor<unknown>;
  refetch(): void;
}>;

export type CommandDispatcher<Registry extends CommandRegistry> = (<
  Name extends RegistryCommandName<Registry>,
>(
  command: Name,
  input: RegistryCommandInput<Registry, Name>,
) => Promise<RegistryCommandResult<Registry, Name>>) &
  Readonly<{
    isPending(command: RegistryCommandName<Registry>): boolean;
  }>;

function sourceValue<Value>(source: GatewaySource<Value>): Value {
  return typeof source === "function" ? (source as Accessor<Value>)() : source;
}

export function createGatewayQuery<
  Registry extends CommandRegistry,
  QueryValue extends Query<any>,
>(
  client: GatewaySource<GatewayClient<Registry>>,
  query: GatewaySource<QueryValue>,
): GatewayQueryState<InferQueryResult<QueryValue>> {
  type Result = InferQueryResult<QueryValue>;
  const [data, setData] = createSignal<Result>();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<unknown>();
  const [revision, setRevision] = createSignal(0);
  let generation = 0;

  createEffect(() => {
    revision();
    const activeClient = sourceValue(client);
    const activeQuery = sourceValue(query);
    const activeGeneration = ++generation;
    let subscriptionDelivered = false;
    setLoading(true);
    setError(undefined);

    const unsubscribe = activeClient.subscribe(
      activeQuery,
      (value) => {
        if (activeGeneration !== generation) return;
        subscriptionDelivered = true;
        setData(() => value);
        setError(undefined);
        setLoading(false);
      },
      (cause) => {
        if (activeGeneration !== generation) return;
        setError(() => cause);
        setLoading(false);
      },
    );

    void activeClient.fetch(activeQuery).then(
      (value) => {
        if (activeGeneration !== generation || subscriptionDelivered) {
          return;
        }
        setData(() => value);
        setLoading(false);
      },
      (cause: unknown) => {
        if (activeGeneration !== generation || subscriptionDelivered) {
          return;
        }
        setError(() => cause);
        setLoading(false);
      },
    );

    onCleanup(() => {
      generation += 1;
      unsubscribe();
    });
  });

  return Object.freeze({
    data,
    loading,
    error,
    refetch() {
      setRevision((value) => value + 1);
    },
  });
}

export function createCommandDispatcher<Registry extends CommandRegistry>(
  client: GatewaySource<GatewayClient<Registry>>,
): CommandDispatcher<Registry> {
  type CommandName = RegistryCommandName<Registry>;
  const inFlight = new Map<CommandName, number>();
  const [pendingCommands, setPendingCommands] = createSignal<
    ReadonlySet<CommandName>
  >(new Set());

  function adjustPending(command: CommandName, change: 1 | -1) {
    const previous = inFlight.get(command) ?? 0;
    const count = previous + change;
    if (count === 0) inFlight.delete(command);
    else inFlight.set(command, count);

    if (previous === 0 && count === 1) {
      setPendingCommands((current) => new Set(current).add(command));
    } else if (previous === 1 && count === 0) {
      setPendingCommands((current) => {
        const next = new Set(current);
        next.delete(command);
        return next;
      });
    }
  }

  const dispatch = async <Name extends CommandName>(
    command: Name,
    input: RegistryCommandInput<Registry, Name>,
  ): Promise<RegistryCommandResult<Registry, Name>> => {
    adjustPending(command, 1);
    try {
      return await sourceValue(client).dispatch(command, input);
    } finally {
      adjustPending(command, -1);
    }
  };

  return Object.assign(dispatch, {
    isPending(command: CommandName) {
      return pendingCommands().has(command);
    },
  });
}
