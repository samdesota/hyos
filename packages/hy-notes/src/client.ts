import { gatewayClient } from "@hyos/hyapp";
import { httpGatewayTransport } from "@hyos/hyapp/http";

import { commandRegistry, readRegistry } from "./application.js";

export const client = gatewayClient({
  registry: commandRegistry,
  transport: httpGatewayTransport({
    reads: readRegistry,
    baseUrl: "/api/hyapp",
    onSubscriptionError(error) {
      console.error("Note timeline subscription failed", error);
    },
  }),
});
