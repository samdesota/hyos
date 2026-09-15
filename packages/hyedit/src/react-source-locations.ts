import { relative, resolve, sep } from "node:path";

import { parse } from "@babel/parser";
import MagicString from "magic-string";
import type { Plugin } from "vite";

interface AstNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  name?: unknown;
  attributes?: unknown[];
  [key: string]: unknown;
}

interface JsxIdentifier extends AstNode {
  type: "JSXIdentifier";
  name: string;
}

export interface ReactSourceLocationsOptions {
  /** Directory to annotate, relative to the consuming Vite app root. */
  sourceDir?: string;
  /** Attribute added to intrinsic DOM elements. */
  attribute?: string;
}

function isInside(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function isIntrinsicName(value: unknown): value is JsxIdentifier {
  return (
    isNode(value) &&
    value.type === "JSXIdentifier" &&
    typeof value.name === "string" &&
    value.name[0] === value.name[0]?.toLowerCase()
  );
}

function hasAttribute(node: AstNode, attribute: string): boolean {
  return (node.attributes ?? []).some((candidate) => {
    if (!isNode(candidate) || candidate.type !== "JSXAttribute") return false;
    const name = candidate.name;
    return (
      isNode(name) && name.type === "JSXIdentifier" && name.name === attribute
    );
  });
}

function visit(value: unknown, visitor: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visit(item, visitor));
    return;
  }
  if (!isNode(value)) return;

  visitor(value);
  for (const [key, child] of Object.entries(value)) {
    if (["loc", "start", "end", "extra", "comments", "tokens"].includes(key))
      continue;
    visit(child, visitor);
  }
}

export function reactSourceLocations(
  options: ReactSourceLocationsOptions = {},
): Plugin {
  const sourceDir = options.sourceDir ?? "src";
  const attribute = options.attribute ?? "data-source-loc";
  let projectRoot = process.cwd();
  let allowedDirectory = resolve(projectRoot, sourceDir);

  return {
    name: "hyos-react-source-locations",
    apply: "serve",
    enforce: "pre",
    configResolved(config) {
      projectRoot = config.root;
      const configuredDirectory = resolve(projectRoot, sourceDir);
      if (!isInside(projectRoot, configuredDirectory)) {
        throw new Error(
          "reactSourceLocations sourceDir must be inside the Vite app root",
        );
      }
      allowedDirectory = configuredDirectory;
    },
    transform(code, rawId) {
      const id = rawId.split("?", 1)[0];
      if (
        !/\.[jt]sx$/.test(id) ||
        id.includes(`${sep}node_modules${sep}`) ||
        !isInside(allowedDirectory, id)
      )
        return null;

      const ast = parse(code, {
        sourceType: "unambiguous",
        plugins: [
          "jsx",
          ...(id.endsWith(".tsx") ? (["typescript"] as const) : []),
        ],
      });
      const output = new MagicString(code);
      let changed = false;

      visit(ast, (node) => {
        if (node.type !== "JSXOpeningElement" || !isIntrinsicName(node.name))
          return;
        if (hasAttribute(node, attribute) || node.name.end == null || !node.loc)
          return;

        const file = relative(projectRoot, id).split(sep).join("/");
        const location = `${file}:${node.loc.start.line}:${node.loc.start.column + 1}`;
        output.appendLeft(
          node.name.end,
          ` ${attribute}=${JSON.stringify(location)}`,
        );
        changed = true;
      });

      if (!changed) return null;
      return {
        code: output.toString(),
        map: output.generateMap({
          hires: true,
          source: id,
          includeContent: true,
        }),
      };
    },
  };
}
