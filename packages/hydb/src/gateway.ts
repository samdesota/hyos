import type { input as ZodInput, output as ZodOutput, ZodType } from "zod";

import type {
  Command,
  InferCommandInput,
  InferCommandResult,
} from "./command.js";
import { getDatabaseSchema, type Database } from "./database.js";
import type { InferQueryResult, Query } from "./query.js";
import { createReadPolicyEnforcer, type ReadPolicy } from "./read-policy.js";

type AnyCommand = Command<any, any, any>;
export type GatewayCommands = Readonly<Record<string, AnyCommand>>;

export type InferGatewayCommands<GatewayValue> =
  GatewayValue extends Gateway<any, infer Commands> ? Commands : never;

export interface GatewaySession<Commands extends GatewayCommands> {
  fetch<QueryValue extends Query<any>>(
    query: QueryValue,
  ): Promise<InferQueryResult<QueryValue>>;

  subscribe<QueryValue extends Query<any>>(
    query: QueryValue,
    listener: (result: InferQueryResult<QueryValue>) => void,
  ): () => void;

  execute<Name extends Extract<keyof Commands, string>>(
    command: Name,
    input: InferCommandInput<Commands[Name]>,
  ): Promise<InferCommandResult<Commands[Name]>>;
}

export interface Gateway<PrincipalInput, Commands extends GatewayCommands> {
  readonly commands: Commands;

  forPrincipal(principal: PrincipalInput): GatewaySession<Commands>;
}

class PrincipalGatewaySession<
  Principal,
  Commands extends GatewayCommands,
> implements GatewaySession<Commands> {
  constructor(
    private readonly principal: Principal,
    private readonly database: Database,
    private readonly commands: Commands,
    private readonly authorizeRead: <QueryValue extends Query<any>>(
      query: QueryValue,
      principal: Principal,
    ) => QueryValue,
  ) {}

  fetch<QueryValue extends Query<any>>(
    query: QueryValue,
  ): Promise<InferQueryResult<QueryValue>> {
    return this.database.fetch(this.authorizeRead(query, this.principal));
  }

  subscribe<QueryValue extends Query<any>>(
    query: QueryValue,
    listener: (result: InferQueryResult<QueryValue>) => void,
  ): () => void {
    return this.database.subscribe(
      this.authorizeRead(query, this.principal),
      listener,
    );
  }

  execute<Name extends Extract<keyof Commands, string>>(
    command: Name,
    input: InferCommandInput<Commands[Name]>,
  ): Promise<InferCommandResult<Commands[Name]>> {
    if (!Object.hasOwn(this.commands, command)) {
      return Promise.reject(
        new TypeError(`Unknown gateway command: ${command}`),
      );
    }
    return this.database.execute(this.commands[command], input) as Promise<
      InferCommandResult<Commands[Name]>
    >;
  }
}

export function gateway<
  PrincipalSchema extends ZodType,
  const Commands extends GatewayCommands,
>(options: {
  database: Database;
  principal: PrincipalSchema;
  commands: Commands;
  readPolicies: readonly ReadPolicy<ZodOutput<PrincipalSchema>>[];
}): Gateway<ZodInput<PrincipalSchema>, Commands> {
  const commands = Object.freeze({ ...options.commands }) as Commands;
  const readPolicies = createReadPolicyEnforcer(
    getDatabaseSchema(options.database),
    options.principal,
    options.readPolicies,
  );
  return Object.freeze({
    commands,
    forPrincipal(principal: ZodInput<PrincipalSchema>) {
      const parsed = options.principal.parse(principal);
      return Object.freeze(
        new PrincipalGatewaySession(
          parsed,
          options.database,
          commands,
          readPolicies.authorize,
        ),
      );
    },
  });
}
