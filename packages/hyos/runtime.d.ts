export type Disposer = () => void | Promise<void>;

export interface ModuleContext {
  get<Value>(key: string): Value;
  provide<Value>(key: string, value: Value): Value;
  effect(install: () => void | Disposer): void;
}

export interface ModuleDefinition<Config = Record<string, never>> {
  id: string;
  inject: readonly string[];
  provide: readonly string[];
  apply(
    context: ModuleContext,
    config: Config,
  ): void | Disposer | Promise<void | Disposer>;
}

export function defineModule<Config>(
  definition: ModuleDefinition<Config>,
): Readonly<ModuleDefinition<Config>>;
export function registerModule<Config>(
  definition: ModuleDefinition<Config>,
): ModuleDefinition<Config>;
