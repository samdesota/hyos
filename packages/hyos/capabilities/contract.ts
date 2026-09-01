export type RemoteMethod<Args extends readonly unknown[], Result> = Readonly<{
  kind: "method";
  __args?: Args;
  __result?: Result;
}>;

export type RemoteEvent<Payload> = Readonly<{
  kind: "event";
  __payload?: Payload;
}>;

export type RemoteMethods = Record<
  string,
  RemoteMethod<readonly unknown[], unknown>
>;
export type RemoteEvents = Record<string, RemoteEvent<unknown>>;

export type RemoteCapability<
  Id extends string,
  Methods extends RemoteMethods,
  Events extends RemoteEvents,
> = Readonly<{
  id: Id;
  version: number;
  methods: Methods;
  events: Events;
}>;

export function remoteMethod<
  Args extends readonly unknown[],
  Result,
>(): RemoteMethod<Args, Result> {
  return { kind: "method" };
}

export function remoteEvent<Payload>(): RemoteEvent<Payload> {
  return { kind: "event" };
}

export function defineRemoteCapability<
  const Id extends string,
  const Methods extends RemoteMethods,
  const Events extends RemoteEvents,
>(definition: RemoteCapability<Id, Methods, Events>) {
  return Object.freeze(definition);
}
