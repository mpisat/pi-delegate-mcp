import { realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { WORKSPACE_ROOT } from "../config.js";

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Resolve before checking: a symlink inside the tree must not grant access outside it. */
export function workspacePath(path: string, cwd: string = WORKSPACE_ROOT): string {
  const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path.replace(/^@/, "");
  const absolute = realpathSync(resolve(cwd, expanded));
  if (!isWithin(WORKSPACE_ROOT, absolute))
    throw new Error("WORKSPACE_DENIED: path is outside the server workspace");
  return absolute;
}

export function canonicalWorkspace(cwd?: string): string {
  const path = workspacePath(cwd || ".");
  if (!statSync(path).isDirectory()) throw new Error("WORKSPACE_DENIED: cwd must be a directory");
  return path;
}

/** Keep Pi's tool behavior, checking its actual execution path rather than its prompt. */
export function workspaceTools(cwd: string): ToolDefinition[] {
  const tools: ToolDefinition[] = [defineTool(createReadToolDefinition(cwd)), defineTool(createGrepToolDefinition(cwd)),
    defineTool(createFindToolDefinition(cwd)), defineTool(createLsToolDefinition(cwd))];
  return tools.map((tool) => ({
    ...tool,
    async execute(id, args, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const input = args as Record<string, unknown>;
      const path = workspacePath(typeof input.path === "string" ? input.path : ".", cwd);
      const stat = statSync(path);
      if (tool.name === "read" ? !stat.isFile() : !stat.isFile() && !stat.isDirectory())
        throw new Error("WORKSPACE_DENIED: only regular files and directories are supported");
      // fd and rg do not follow descendant symlinks by default. An explicitly named
      // symlink is canonicalized above, including when it is an intermediate component.
      // This is a tool policy, not isolation from concurrent host filesystem mutation.
      // Pi normalizes Unicode spaces before decoding file URLs. Encode the checked
      // canonical target so that a second normalization cannot select another file.
      return tool.execute(id, { ...input, path: pathToFileURL(path).href }, signal, onUpdate, { ...ctx, cwd });
    },
  }));
}
