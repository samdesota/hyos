export type ModulePlacement = Readonly<{
  id: string;
  file: `./${string}.${"ts" | "tsx"}`;
  host: "main" | "renderer";
  reload: "hot" | "restart";
  config?: Readonly<Record<string, unknown>>;
}>;

export type ApplicationManifest = Readonly<{
  version: number;
  modules: readonly ModulePlacement[];
}>;

export function defineApplicationManifest<
  const Manifest extends ApplicationManifest,
>(manifest: Manifest): Manifest {
  return Object.freeze(manifest);
}
