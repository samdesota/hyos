import type { Database, Transaction, WritePolicy } from "@hyos/hydb";
import {
  createWritePolicyEnforcer,
  getDatabaseSchema,
  getWritePolicyPrincipalSchema,
} from "@hyos/hydb";
import {
  z,
  type input as ZodInput,
  type output as ZodOutput,
  type ZodType,
} from "zod";

const commandDefinition = Symbol("hyapp.command");
const contractDefinition = Symbol("hyapp.command-contract");
const commandInput = Symbol("hyapp.command-input");
const commandOutput = Symbol("hyapp.command-output");

export type MutationTransaction = Pick<
  Transaction,
  "insert" | "update" | "delete"
>;

export type CommandContract<
  Input,
  Output,
  ParsedInput = Input,
  ParsedOutput = Output,
> = Readonly<{
  [contractDefinition]: Readonly<{
    input: ZodType<ParsedInput, Input>;
    output: ZodType<ParsedOutput, any>;
  }>;
}>;

type OptimisticHandler<ParsedInput> = (
  context: Readonly<{ transaction: MutationTransaction }>,
  input: ParsedInput,
) => void | PromiseLike<void>;

type ServerHandler<Principal, ParsedInput, Output> = (
  context: Readonly<{
    transaction: Transaction;
    principal: Principal;
    applyOptimistic(): Promise<void>;
  }>,
  input: ParsedInput,
) => Output | PromiseLike<Output>;

type ServerCommandDefinition<
  Principal,
  Input,
  Output,
  ParsedInput,
  ParsedOutput,
> = Readonly<{
  target: "server";
  principalSchema: ZodType<Principal>;
  defaultPolicy: readonly WritePolicy<Principal>[];
  contract: CommandContract<Input, Output, ParsedInput, ParsedOutput>;
  optimistic?: OptimisticHandler<ParsedInput>;
  server?: ServerHandler<Principal, ParsedInput, unknown>;
}>;

type ClientCommandDefinition<Input, Output, ParsedInput, ParsedOutput> =
  Readonly<{
    target: "client";
    contract: CommandContract<Input, Output, ParsedInput, ParsedOutput>;
    optimistic?: OptimisticHandler<ParsedInput>;
  }>;

export type ServerCommand<
  Input,
  Output,
  Principal,
  ParsedInput = Input,
  ParsedOutput = Output,
> = Readonly<{
  [commandInput]: Input;
  [commandOutput]: Output;
  [commandDefinition]: ServerCommandDefinition<
    Principal,
    Input,
    Output,
    ParsedInput,
    ParsedOutput
  >;
}>;

export type ClientCommand<
  Input,
  Output,
  ParsedInput = Input,
  ParsedOutput = Output,
> = Readonly<{
  [commandInput]: Input;
  [commandOutput]: Output;
  [commandDefinition]: ClientCommandDefinition<
    Input,
    Output,
    ParsedInput,
    ParsedOutput
  >;
}>;

export type AnyServerCommand = ServerCommand<any, any, any, any, any>;
export type AnyClientCommand = ClientCommand<any, any, any, any>;
export type AnyCommand = AnyServerCommand | AnyClientCommand;

export type InferCommandInput<CommandValue extends AnyCommand> =
  CommandValue[typeof commandInput];

export type InferCommandResult<CommandValue extends AnyCommand> =
  CommandValue[typeof commandOutput];

export function createCommandContract<InputSchema extends ZodType>(options: {
  input: InputSchema;
  output?: never;
}): CommandContract<ZodInput<InputSchema>, void, ZodOutput<InputSchema>, void>;

export function createCommandContract<
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
>(options: {
  input: InputSchema;
  output: OutputSchema;
}): CommandContract<
  ZodInput<InputSchema>,
  ZodOutput<OutputSchema>,
  ZodOutput<InputSchema>,
  ZodOutput<OutputSchema>
>;

export function createCommandContract<InputSchema extends ZodType>(options: {
  input: InputSchema;
  output?: ZodType;
}): CommandContract<ZodInput<InputSchema>, unknown, ZodOutput<InputSchema>> {
  return Object.freeze({
    [contractDefinition]: Object.freeze({
      input: options.input as ZodType<
        ZodOutput<InputSchema>,
        ZodInput<InputSchema>
      >,
      output: options.output ?? z.void(),
    }),
  });
}

type UnifiedCommandDefinition<
  Principal,
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
> = Readonly<{
  input: InputSchema;
  output: OutputSchema;
  optimistic?: OptimisticHandler<ZodOutput<InputSchema>>;
  server: ServerHandler<
    Principal,
    ZodOutput<InputSchema>,
    | ZodInput<OutputSchema>
    | (undefined extends ZodInput<OutputSchema> ? void : never)
  >;
}>;

type VoidCommandDefinition<Principal, InputSchema extends ZodType> = Readonly<
  {
    input: InputSchema;
    output?: never;
  } & (
    | {
        optimistic: OptimisticHandler<ZodOutput<InputSchema>>;
        server?: ServerHandler<Principal, ZodOutput<InputSchema>, void>;
      }
    | {
        optimistic?: OptimisticHandler<ZodOutput<InputSchema>>;
        server: ServerHandler<Principal, ZodOutput<InputSchema>, void>;
      }
  )
>;

export interface ServerCommandFactory<Principal> {
  define<InputSchema extends ZodType>(
    definition: VoidCommandDefinition<Principal, InputSchema>,
  ): ServerCommand<
    ZodInput<InputSchema>,
    void,
    Principal,
    ZodOutput<InputSchema>,
    void
  >;

  define<InputSchema extends ZodType, OutputSchema extends ZodType>(
    definition: UnifiedCommandDefinition<Principal, InputSchema, OutputSchema>,
  ): ServerCommand<
    ZodInput<InputSchema>,
    ZodOutput<OutputSchema>,
    Principal,
    ZodOutput<InputSchema>,
    ZodOutput<OutputSchema>
  >;
}

export function createServerCommandFactory<
  PrincipalSchema extends ZodType,
>(options: {
  principal: PrincipalSchema;
  defaultPolicy: readonly WritePolicy<ZodOutput<PrincipalSchema>>[];
}): ServerCommandFactory<ZodOutput<PrincipalSchema>> {
  type Principal = ZodOutput<PrincipalSchema>;
  const defaultPolicy = Object.freeze([...options.defaultPolicy]);
  for (const policy of defaultPolicy) {
    if (getWritePolicyPrincipalSchema(policy) !== options.principal) {
      throw new TypeError(
        "Command factory policies must use the factory's principal schema",
      );
    }
  }
  return Object.freeze({
    define<InputSchema extends ZodType>(
      definition: Readonly<{
        input: InputSchema;
        output?: ZodType;
        optimistic?: OptimisticHandler<ZodOutput<InputSchema>>;
        server?: ServerHandler<Principal, ZodOutput<InputSchema>, unknown>;
      }>,
    ) {
      const contract = createCommandContract({
        input: definition.input,
        output: definition.output ?? z.void(),
      });
      return Object.freeze({
        [commandInput]: undefined as unknown as ZodInput<InputSchema>,
        [commandOutput]: undefined as unknown,
        [commandDefinition]: Object.freeze({
          target: "server" as const,
          principalSchema: options.principal as ZodType<Principal>,
          defaultPolicy,
          contract,
          optimistic: definition.optimistic,
          server: definition.server,
        }),
      });
    },
  }) as unknown as ServerCommandFactory<Principal>;
}

export const commandFactory = createServerCommandFactory;

export interface ClientCommandFactory {
  define<Input, Output, ParsedInput, ParsedOutput>(definition: {
    contract: CommandContract<Input, Output, ParsedInput, ParsedOutput>;
    optimistic?: OptimisticHandler<ParsedInput>;
  }): ClientCommand<Input, Output, ParsedInput, ParsedOutput>;

  define<
    InputSchema extends ZodType,
    OutputSchema extends ZodType,
  >(definition: {
    input: InputSchema;
    output: OutputSchema;
    optimistic?: OptimisticHandler<ZodOutput<InputSchema>>;
  }): ClientCommand<
    ZodInput<InputSchema>,
    ZodOutput<OutputSchema>,
    ZodOutput<InputSchema>,
    ZodOutput<OutputSchema>
  >;

  define<InputSchema extends ZodType>(definition: {
    input: InputSchema;
    output?: never;
    optimistic?: OptimisticHandler<ZodOutput<InputSchema>>;
  }): ClientCommand<ZodInput<InputSchema>, void, ZodOutput<InputSchema>, void>;
}

export function createClientCommandFactory(): ClientCommandFactory {
  return Object.freeze({
    define<Input, Output, ParsedInput, ParsedOutput>(definition: {
      contract?: CommandContract<Input, Output, ParsedInput, ParsedOutput>;
      input?: ZodType<ParsedInput, Input>;
      output?: ZodType<ParsedOutput, any>;
      optimistic?: OptimisticHandler<ParsedInput>;
    }) {
      const contract =
        definition.contract ??
        (definition.input !== undefined
          ? Object.freeze({
              [contractDefinition]: Object.freeze({
                input: definition.input,
                output: definition.output ?? z.void(),
              }),
            })
          : undefined);
      if (contract === undefined) {
        throw new TypeError(
          "Client commands require a contract or an input schema",
        );
      }
      return Object.freeze({
        [commandInput]: undefined as unknown as Input,
        [commandOutput]: undefined as unknown as Output,
        [commandDefinition]: Object.freeze({
          target: "client" as const,
          contract,
          optimistic: definition.optimistic,
        }),
      });
    },
  }) as ClientCommandFactory;
}

export async function executeServerCommand<
  Input,
  Output,
  Principal,
  ParsedInput,
  ParsedOutput,
>(
  database: Database,
  command: ServerCommand<Input, Output, Principal, ParsedInput, ParsedOutput>,
  input: Input,
  principal: Principal,
): Promise<Output> {
  const definition = command[commandDefinition];
  const parsedPrincipal =
    await definition.principalSchema.parseAsync(principal);
  const contract = definition.contract[contractDefinition];
  const parsedInput = await contract.input.parseAsync(input);

  return database.transact(
    {
      principalSchema: definition.principalSchema,
      principal: parsedPrincipal,
      defaultPolicy: definition.defaultPolicy,
    },
    async (transaction) => {
      let optimisticApplied = false;
      const applyOptimistic = async () => {
        if (optimisticApplied) {
          throw new TypeError(
            "A command's optimistic implementation may only be applied once",
          );
        }
        if (definition.optimistic === undefined) {
          throw new TypeError("Command has no optimistic implementation");
        }
        optimisticApplied = true;
        await definition.optimistic({ transaction }, parsedInput);
      };
      const result =
        definition.server === undefined
          ? await applyOptimistic()
          : await definition.server(
              {
                transaction,
                principal: parsedPrincipal,
                applyOptimistic,
              },
              parsedInput,
            );
      return contract.output.parseAsync(result);
    },
  ) as Promise<Output>;
}

export async function executeOptimisticCommand<
  Input,
  Output,
  ParsedInput,
  ParsedOutput,
>(
  command: ClientCommand<Input, Output, ParsedInput, ParsedOutput>,
  input: Input,
  transaction: MutationTransaction,
): Promise<void> {
  const definition = command[commandDefinition];
  if (definition.optimistic === undefined) return;
  const parsedInput = await parseCommandInput(command, input);
  await definition.optimistic({ transaction }, parsedInput);
}

export async function parseCommandInput<
  Input,
  Output,
  ParsedInput,
  ParsedOutput,
>(
  command: ClientCommand<Input, Output, ParsedInput, ParsedOutput>,
  input: Input,
): Promise<ParsedInput> {
  return command[commandDefinition].contract[
    contractDefinition
  ].input.parseAsync(input);
}

export async function parseCommandResult<CommandValue extends AnyCommand>(
  command: CommandValue,
  result: unknown,
): Promise<InferCommandResult<CommandValue>> {
  return command[commandDefinition].contract[
    contractDefinition
  ].output.parseAsync(result) as Promise<InferCommandResult<CommandValue>>;
}

export function isClientCommand(
  command: AnyCommand,
): command is AnyClientCommand {
  return command[commandDefinition].target === "client";
}

export function commandHasOptimistic(command: AnyClientCommand): boolean {
  return command[commandDefinition].optimistic !== undefined;
}

export function getCommandPrincipalSchema(command: AnyServerCommand): ZodType {
  return command[commandDefinition].principalSchema;
}

export function validateServerCommand(
  database: Database,
  command: AnyServerCommand,
): void {
  const definition = command[commandDefinition];
  createWritePolicyEnforcer(
    getDatabaseSchema(database),
    definition.principalSchema,
    definition.defaultPolicy,
  );
}
