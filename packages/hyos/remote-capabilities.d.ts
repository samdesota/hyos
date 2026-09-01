import type {
  RemoteCapability,
  RemoteEvent,
  RemoteEvents,
  RemoteMethod,
  RemoteMethods,
} from "./capabilities/contract.js";

type AnyCapability = RemoteCapability<string, RemoteMethods, RemoteEvents>;
type MethodArgs<Method> =
  Method extends RemoteMethod<infer Args, unknown> ? Args : never;
type MethodResult<Method> =
  Method extends RemoteMethod<readonly unknown[], infer Result>
    ? Result
    : never;
type EventPayload<Event> =
  Event extends RemoteEvent<infer Payload> ? Payload : never;

export type RemoteProvider<Capability extends AnyCapability> = {
  [Method in keyof Capability["methods"]]: (
    ...args: MethodArgs<Capability["methods"][Method]>
  ) =>
    | MethodResult<Capability["methods"][Method]>
    | Promise<MethodResult<Capability["methods"][Method]>>;
};

export interface RemoteConsumer<Capability extends AnyCapability> {
  readonly id: Capability["id"];
  readonly version: number;
  call<Method extends keyof Capability["methods"]>(
    method: Method,
    ...args: MethodArgs<Capability["methods"][Method]>
  ): Promise<MethodResult<Capability["methods"][Method]>>;
  subscribe<Event extends keyof Capability["events"]>(
    event: Event,
    listener: (payload: EventPayload<Capability["events"][Event]>) => void,
  ): () => void;
}

export class MainRemoteCapabilities {
  provide<Capability extends AnyCapability>(
    capability: Capability,
    provider: RemoteProvider<Capability>,
  ): () => void;
  publish<
    Capability extends AnyCapability,
    Event extends keyof Capability["events"],
  >(
    capability: Capability,
    event: Event,
    payload: EventPayload<Capability["events"][Event]>,
  ): void;
}

export class RendererRemoteCapabilities {
  consume<Capability extends AnyCapability>(
    capability: Capability,
  ): RemoteConsumer<Capability>;
}

export const remoteChannels: Readonly<{ invoke: string; event: string }>;
