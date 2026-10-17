import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, WORKSPACE_ROOT } from "../config.js";
import { canonicalWorkspace, isWithin } from "./workspace.js";

const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function instruction(dir: string, boundary?: string): { path: string; content: string } | undefined {
  for (const name of CONTEXT_NAMES) {
    try {
      const path = realpathSync(join(dir, name));
      if ((boundary && !isWithin(boundary, path)) || !statSync(path).isFile()) continue;
      return { path, content: readFileSync(path, "utf8") };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return undefined;
}

export async function createResources(cwd: string, extensions: boolean) {
  cwd = canonicalWorkspace(cwd);
  const settingsManager = SettingsManager.create(cwd, AGENT_DIR, { projectTrusted: extensions });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: AGENT_DIR, settingsManager,
    noExtensions: !extensions, noSkills: true, noPromptTemplates: true, noThemes: true,
    noContextFiles: true,
  });
  const files: Array<{ path: string; content: string }> = [];
  for (let dir = cwd;; dir = dirname(dir)) {
    const file = instruction(dir, WORKSPACE_ROOT);
    if (file) files.unshift(file);
    if (dir === WORKSPACE_ROOT) break;
  }
  // Global instructions are administrator-owned configuration, including symlinks.
  const global = instruction(AGENT_DIR);
  if (global && !files.some((file) => file.path === global.path)) files.unshift(global);
  // Normal delegates never reload the package/resource discovery machinery. In
  // particular, reading AGENTS.md must not execute a project's settings or packages.
  if (extensions) await resourceLoader.reload();
  resourceLoader.getAgentsFiles = () => ({ agentsFiles: files });
  return { settingsManager, resourceLoader };
}
