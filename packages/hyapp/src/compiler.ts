import generate from "@babel/generator";
import { parse } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";

export type CommandCompilationTarget = "client" | "server";

export type CompiledCommandModule = Readonly<{
  code: string;
  map: object | null;
}>;

function staticPropertyName(
  property: t.ObjectMethod | t.ObjectProperty,
): string | undefined {
  if (property.computed) return undefined;
  if (t.isIdentifier(property.key)) return property.key.name;
  if (t.isStringLiteral(property.key)) return property.key.value;
  return undefined;
}

function isDefineCall(path: NodePath<t.CallExpression>): boolean {
  const callee = path.get("callee");
  return (
    callee.isMemberExpression() &&
    !callee.node.computed &&
    callee.get("property").isIdentifier({ name: "define" })
  );
}

function owningDeclaration(path: NodePath): NodePath | undefined {
  if (path.isImportSpecifier() || path.isImportDefaultSpecifier()) return path;
  if (path.isImportNamespaceSpecifier()) return path;
  if (path.isVariableDeclarator()) return path;
  if (path.isFunctionDeclaration() || path.isClassDeclaration()) return path;
  return undefined;
}

function isInside(path: NodePath, ancestor: NodePath): boolean {
  for (let current: NodePath | null = path; current !== null;) {
    if (current === ancestor) return true;
    current = current.parentPath;
  }
  return false;
}

export function compileCommandModule(
  source: string,
  options: Readonly<{
    target: CommandCompilationTarget;
    filename?: string;
  }>,
): CompiledCommandModule {
  const filename = options.filename ?? "command.ts";
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: filename,
    plugins: [
      "typescript",
      ...(filename.endsWith("x") ? (["jsx"] as const) : []),
    ],
  });
  const directFactories = new Set<string>();
  const factoryObjects = new Set<string>();
  const removalCandidates = new Set<string>();
  let programPath: NodePath<t.Program> | undefined;

  const collectDependencies = (path: NodePath): void => {
    path.traverse({
      ReferencedIdentifier(reference) {
        const binding = reference.scope.getBinding(reference.node.name);
        if (
          binding !== undefined &&
          binding.scope.path.isProgram() &&
          owningDeclaration(binding.path) !== undefined
        ) {
          removalCandidates.add(reference.node.name);
        }
      },
    });
  };

  traverse(ast, {
    Program(path) {
      programPath = path;
    },
    ImportDeclaration(path) {
      if (path.node.source.value !== "@hyos/hyapp") return;
      for (const specifier of path.get("specifiers")) {
        if (specifier.isImportNamespaceSpecifier()) {
          factoryObjects.add(specifier.node.local.name);
          continue;
        }
        if (!specifier.isImportSpecifier()) continue;
        const imported = specifier.node.imported;
        const importedName = t.isIdentifier(imported)
          ? imported.name
          : imported.value;
        if (importedName === "hyapp") {
          factoryObjects.add(specifier.node.local.name);
          continue;
        }
        if (importedName !== "commandFactory") continue;
        directFactories.add(specifier.node.local.name);
        specifier.node.imported = t.identifier(
          options.target === "client"
            ? "createClientCommandFactory"
            : "createServerCommandFactory",
        );
      }
    },
    CallExpression(path) {
      const callee = path.get("callee");
      const isDirectFactory =
        callee.isIdentifier() && directFactories.has(callee.node.name);
      const isObjectFactory =
        callee.isMemberExpression() &&
        !callee.node.computed &&
        callee.get("object").isIdentifier() &&
        factoryObjects.has(
          (callee.get("object") as NodePath<t.Identifier>).node.name,
        ) &&
        callee.get("property").isIdentifier({ name: "commandFactory" });

      if (isDirectFactory || isObjectFactory) {
        if (isObjectFactory) {
          (callee.get("property") as NodePath<t.Identifier>).node.name =
            options.target === "client"
              ? "createClientCommandFactory"
              : "createServerCommandFactory";
        }
        if (options.target === "client") {
          for (const argument of path.get("arguments")) {
            collectDependencies(argument);
          }
          path.node.arguments = [];
        }
        return;
      }

      if (options.target !== "client" || !isDefineCall(path)) return;
      const argument = path.get("arguments.0");
      if (!argument?.isObjectExpression()) {
        throw path.buildCodeFrameError(
          "Client commands must pass an inline object to define()",
        );
      }
      const properties = argument.get("properties");
      const names = new Set(
        properties.flatMap((property) =>
          property.isObjectMethod() || property.isObjectProperty()
            ? [staticPropertyName(property.node)]
            : [],
        ),
      );
      const looksLikeCommand =
        names.has("server") || (names.has("input") && names.has("output"));
      if (!looksLikeCommand) return;
      if (
        properties.some(
          (property) =>
            property.isSpreadElement() ||
            ((property.isObjectMethod() || property.isObjectProperty()) &&
              property.node.computed),
        )
      ) {
        throw path.buildCodeFrameError(
          "Client command definitions cannot use spreads or computed properties",
        );
      }
      const server = properties.find(
        (property) =>
          (property.isObjectMethod() || property.isObjectProperty()) &&
          staticPropertyName(property.node) === "server",
      );
      if (server !== undefined) {
        collectDependencies(server);
        server.remove();
      }
    },
  });

  if (programPath === undefined)
    throw new Error("Command module has no program");

  let removed = true;
  while (removed) {
    removed = false;
    programPath.scope.crawl();
    for (const name of [...removalCandidates]) {
      const binding = programPath.scope.getBinding(name);
      if (binding === undefined) {
        removalCandidates.delete(name);
        continue;
      }
      const declaration = owningDeclaration(binding.path);
      if (declaration === undefined) continue;
      const externallyReferenced = binding.referencePaths.some(
        (reference) => !isInside(reference, declaration),
      );
      if (externallyReferenced) continue;

      collectDependencies(declaration);
      if (
        declaration.isImportSpecifier() ||
        declaration.isImportDefaultSpecifier() ||
        declaration.isImportNamespaceSpecifier()
      ) {
        const importDeclaration = declaration.parentPath;
        declaration.remove();
        if (
          importDeclaration.isImportDeclaration() &&
          importDeclaration.node.specifiers.length === 0
        ) {
          importDeclaration.remove();
        }
      } else if (declaration.isVariableDeclarator()) {
        const variableDeclaration = declaration.parentPath;
        declaration.remove();
        if (
          variableDeclaration.isVariableDeclaration() &&
          variableDeclaration.node.declarations.length === 0
        ) {
          variableDeclaration.remove();
        }
      } else {
        declaration.remove();
      }
      removalCandidates.delete(name);
      removed = true;
    }
  }

  const generated = generate(
    ast,
    {
      sourceMaps: true,
      sourceFileName: filename,
      retainLines: true,
    },
    source,
  );
  return Object.freeze({ code: generated.code, map: generated.map });
}
