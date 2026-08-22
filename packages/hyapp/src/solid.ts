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

export type GatewayExecutorOptions = Readonly<{
  setPending(pending: boolean): void;
}>;

export type GatewayExecutor<Registry extends CommandRegistry> = <
  Name extends RegistryCommandName<Registry>,
>(
  command: Name,
  input: RegistryCommandInput<Registry, Name>,
) => Promise<RegistryCommandResult<Registry, Name>>;

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

export function createGatewayExecutor<Registry extends CommandRegistry>(
  client: GatewaySource<GatewayClient<Registry>>,
  options: GatewayExecutorOptions,
): GatewayExecutor<Registry> {
  let inFlight = 0;

  return async (command, input) => {
    inFlight += 1;
    try {
      if (inFlight === 1) options.setPending(true);
      return await sourceValue(client).execute(command, input);
    } finally {
      inFlight -= 1;
      if (inFlight === 0) options.setPending(false);
    }
  };
}
