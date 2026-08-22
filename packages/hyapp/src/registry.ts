import type {
  AnyCommand,
  AnyServerCommand,
  InferCommandInput,
  InferCommandResult,
} from "./command.js";
import type { Query } from "@hyos/hydb";

export type CommandRegistry = Readonly<Record<string, AnyCommand>>;
export type ServerCommandRegistry = Readonly<Record<string, AnyServerCommand>>;
export type GatewayReadRegistry = Readonly<Record<string, Query<any>>>;

export type RegistryCommandName<Registry extends CommandRegistry> = Extract<
  keyof Registry,
  string
>;

export type RegistryCommandInput<
  Registry extends CommandRegistry,
  Name extends RegistryCommandName<Registry>,
> = InferCommandInput<Registry[Name]>;

export type RegistryCommandResult<
  Registry extends CommandRegistry,
  Name extends RegistryCommandName<Registry>,
> = InferCommandResult<Registry[Name]>;

export function commandRegistry<const Commands extends CommandRegistry>(
  commands: Commands,
): Readonly<Commands> {
  return Object.freeze({ ...commands });
}

export function gatewayReadRegistry<const Reads extends GatewayReadRegistry>(
  reads: Reads,
): Readonly<Reads> {
  return Object.freeze({ ...reads });
}
