import { gatewayClient, type GatewayClient } from "@hyos/hyapp";
import { httpGatewayTransport } from "@hyos/hyapp/http";
import {
  createContext,
  createMemo,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";

import { commandRegistry, readRegistry } from "./data.js";

export type AppGatewayClient = GatewayClient<typeof commandRegistry>;

const GatewayContext = createContext<Accessor<AppGatewayClient>>();

export function GatewayProvider(props: {
  userId: Accessor<string>;
  children: JSX.Element;
}) {
  const client = createMemo(() => {
    const userId = props.userId();
    return gatewayClient({
      registry: commandRegistry,
      transport: httpGatewayTransport({
        reads: readRegistry,
        baseUrl: "/api",
        headers: () => ({ "x-demo-user-id": userId }),
      }),
    });
  });

  return (
    <GatewayContext.Provider value={client}>
      {props.children}
    </GatewayContext.Provider>
  );
}

export function useGateway(): Accessor<AppGatewayClient> {
  const client = useContext(GatewayContext);
  if (client === undefined) throw new Error("GatewayProvider is missing");
  return client;
}
