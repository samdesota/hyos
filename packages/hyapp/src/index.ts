import {
  commandFactory,
  createClientCommandFactory,
  createServerCommandFactory,
} from "./command.js";
import { gateway } from "./gateway.js";
import { gatewayClient } from "./gateway-client.js";
import { commandRegistry } from "./registry.js";

export {
  commandFactory,
  createClientCommandFactory,
  createCommandContract,
  createServerCommandFactory,
  executeOptimisticCommand,
  executeServerCommand,
  parseCommandInput,
  parseCommandResult,
  type AnyClientCommand,
  type AnyCommand,
  type AnyServerCommand,
  type ClientCommand,
  type ClientCommandFactory,
  type CommandContract,
  type InferCommandInput,
  type InferCommandResult,
  type MutationTransaction,
  type ServerCommand,
  type ServerCommandFactory,
} from "./command.js";

export {
  directGatewayTransport,
  gatewayClient,
  type GatewayClient,
  type GatewayClientTransport,
  type GatewayCommandRequest,
  type GatewayCommandResponse,
  type OptimisticCoordinator,
  type OptimisticLayer,
} from "./gateway-client.js";

export {
  gateway,
  type Gateway,
  type GatewayCommands,
  type GatewaySession,
  type InferGatewayCommands,
} from "./gateway.js";

export {
  commandRegistry,
  type CommandRegistry,
  type RegistryCommandInput,
  type RegistryCommandName,
  type RegistryCommandResult,
  type ServerCommandRegistry,
} from "./registry.js";

export const hyapp = Object.freeze({
  commandFactory,
  createClientCommandFactory,
  createServerCommandFactory,
  commandRegistry,
  gateway,
  gatewayClient,
});
