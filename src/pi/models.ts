import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, IGNORE_SCOPE, STRICT_SCOPE } from "../config.js";
import type { ModelScope } from "../types.js";
import { getRuntime, type PiModel } from "./runtime.js";
import { canonicalWorkspace, workspacePath } from "./workspace.js";

function readJson(path: string, cwd?: string): Record<string, unknown> | undefined {
  if (cwd) {
    try {
      path = workspacePath(path, cwd);
      if (!statSync(path).isFile())
        throw new Error("WORKSPACE_DENIED: project settings must be a regular file");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The delegate may only use models pi itself has scoped, plus anything served by a
 * custom provider from models.json, since those are declared by hand and are the point of
 * having a custom provider at all.
 *
 * Mirrors pi's settings precedence: project `<cwd>/.pi/settings.json` overrides global.
 * An empty or missing enabledModels means no scoping, matching pi's own no-op default.
 */
export function modelScope(cwd?: string): ModelScope | undefined {
  cwd = canonicalWorkspace(cwd);
  if (IGNORE_SCOPE) return undefined;
  const global = readJson(join(AGENT_DIR, "settings.json"))?.enabledModels;
  const local = readJson(join(cwd, ".pi", "settings.json"), cwd)?.enabledModels;
  const enabled = local ?? global;
  if (!Array.isArray(enabled) || enabled.length === 0) return undefined;

  const providers = readJson(join(AGENT_DIR, "models.json"))?.providers;
  const customProviders =
    STRICT_SCOPE || !providers || typeof providers !== "object" ? [] : Object.keys(providers);
  return { enabled: new Set(enabled as string[]), customProviders: new Set(customProviders) };
}

export function inScope(scope: ModelScope | undefined, provider: string, id: string): boolean {
  if (!scope) return true;
  return scope.customProviders.has(provider) || scope.enabled.has(`${provider}/${id}`);
}

export interface ScopedModel {
  provider: string;
  id: string;
  ref: string;
}

/**
 * Models the delegate can actually use: in scope AND backed by a provider that is
 * authenticated. A scoped model with no credentials is not usable, so it is not offered.
 */
export async function scopedModels(cwd?: string): Promise<ScopedModel[]> {
  const scope = modelScope(cwd);
  const rt = await getRuntime();
  const available = await rt.getAvailable();
  return available
    .map((m) => ({ provider: m.provider, id: m.id, ref: `${m.provider}/${m.id}` }))
    .filter((m) => inScope(scope, m.provider, m.id));
}

export interface Health {
  available: number;
  usable: string[];
}

/**
 * Refuse to operate at all when pi is absent or unusable. A delegate server that
 * silently degrades is worse than one that will not start.
 */
export async function preflight(cwd?: string): Promise<Health> {
  if (!existsSync(AGENT_DIR))
    throw new Error(
      `pi is not configured: ${AGENT_DIR} does not exist. Install pi ` +
        `(npm i -g @earendil-works/pi-coding-agent), run \`pi\` once, and \`/login\` a provider.`,
    );

  const rt = await getRuntime();
  const runtimeError = rt.getError();
  if (runtimeError) throw new Error(`pi's model runtime failed to load: ${runtimeError}`);

  const available = await rt.getAvailable();
  if (available.length === 0)
    throw new Error(
      `pi has no authenticated provider. Run \`pi\` and \`/login\`, or put an API key in ` +
        `${join(AGENT_DIR, "auth.json")}. Environment variables are unreliable here because MCP ` +
        `hosts launch servers with a stripped environment.`,
    );

  const usable = await scopedModels(cwd);
  if (usable.length === 0) {
    const scope = modelScope(cwd);
    throw new Error(
      scope
        ? `No usable model. pi's enabledModels scope [${[...scope.enabled].join(", ")}] does not ` +
          `intersect any authenticated provider. Widen it via pi's /scoped-models, log in to the ` +
          `matching provider, or set PI_DELEGATE_IGNORE_SCOPE=1.`
        : "No usable model: pi reports authenticated providers but none carry a usable model.",
    );
  }
  return { available: available.length, usable: usable.map((m) => m.ref) };
}

/**
 * Resolve "provider/modelId" to a model. Splits on the FIRST slash so
 * "openrouter/stealth/ox-alpha" yields provider=openrouter, id=stealth/ox-alpha.
 *
 * Resolve omitted models here too: passing undefined to pi would select a default
 * after our scope check, allowing that default to bypass enabledModels.
 */
export async function resolveModel(spec: string | undefined, cwd?: string): Promise<PiModel> {
  cwd = canonicalWorkspace(cwd);
  const rt = await getRuntime();
  let model: PiModel | undefined;
  if (!spec) {
    const global = readJson(join(AGENT_DIR, "settings.json"));
    const local = readJson(join(cwd, ".pi", "settings.json"), cwd);
    const provider = local?.defaultProvider ?? global?.defaultProvider;
    const id = local?.defaultModel ?? global?.defaultModel;
    if (typeof provider === "string" && provider && typeof id === "string" && id) {
      spec = `${provider}/${id}`;
      model = rt.getModel(provider, id);
    } else {
      // Let Pi apply its provider defaults and available-model ordering. A supplied
      // lazy loader and in-memory settings prevent resource discovery or project
      // execution; no prompt is sent by constructing this selection-only session.
      const settingsManager = SettingsManager.inMemory();
      const { session } = await createAgentSession({
        cwd, agentDir: AGENT_DIR, modelRuntime: rt, settingsManager,
        sessionManager: SessionManager.inMemory(), tools: [],
        resourceLoader: new DefaultResourceLoader({
          cwd, agentDir: AGENT_DIR, settingsManager, noExtensions: true, noContextFiles: true,
        }),
      });
      try {
        model = session.model;
      } finally {
        session.dispose();
      }
      if (!model) throw new Error("No authenticated model is available for the pi default.");
    }
  } else {
    const slash = spec.indexOf("/");
    if (slash > 0) model = rt.getModel(spec.slice(0, slash), spec.slice(slash + 1));
    model ??= rt.getModels().find((m) => m.id === spec);
  }

  if (!model)
    throw new Error(
      `Model not found: ${spec}. Use "provider/modelId", e.g. "openrouter/stealth/ox-alpha". ` +
        `Call the "models" tool to list what is available.`,
    );

  const scope = modelScope(cwd);
  if (!inScope(scope, model.provider, model.id)) {
    const allowed = (await scopedModels(cwd)).map((m) => m.ref);
    throw new Error(
      `Model ${model.provider}/${model.id} is out of scope. Allowed here: ${allowed.join(", ")}. ` +
        `Widen it in pi's own settings (enabledModels, via /scoped-models) or set ` +
        `PI_DELEGATE_IGNORE_SCOPE=1 on this server.`,
    );
  }
  return model;
}
