import type { Client } from "./opencode";
import type { components } from "./api";

type ModelInfo = components["schemas"]["Model.Info"];
type ModelRef = components["schemas"]["Model.Ref"];

/**
 * A model costs nothing to call. OpenCode reports `cost` as a list of price
 * entries; a free model has every entry at zero.
 */
/** Accepts the loose shape the bot's model list arrives in. */
export function isFreeModel(model: ModelInfo | { cost?: unknown }): boolean {
  const cost = (model as ModelInfo).cost;
  if (!cost || cost.length === 0) return false;
  return cost.every((entry) =>
    (entry.input ?? 0) === 0 && (entry.output ?? 0) === 0 &&
    (entry.cache?.read ?? 0) === 0 && (entry.cache?.write ?? 0) === 0,
  );
}

/** The bridge needs at least text and image input; attachments are images to the model. */
export function supportsTextAndImage(model: ModelInfo): boolean {
  const input = model.capabilities?.input ?? [];
  return input.includes("text") && input.includes("image");
}

export function isUsable(model: ModelInfo): boolean {
  // status is a closed union in the spec ("alpha" | "beta" | "deprecated" | "active");
  // treat anything that is not active/beta/alpha as unusable, and respect the enabled flag
  return model.enabled !== false && (model.status === "active" || model.status === "beta" || model.status === "alpha");
}

/**
 * Newest free model that can read text and images. Sorting by release date is what makes this
 * rotate: when OpenCode publishes a newer free vision model it wins automatically, and a model
 * that disappears from the catalogue (or is retired) stops being a candidate.
 */
export function pickFreeVisionModel(models: ModelInfo[]): ModelRef | undefined {
  const candidates = models
    .filter((model) => isUsable(model) && isFreeModel(model) && supportsTextAndImage(model))
    .sort((a, b) => (b.time?.released ?? 0) - (a.time?.released ?? 0));
  const best = candidates[0];
  return best ? { id: best.id, providerID: best.providerID } : undefined;
}

export function isModelAvailable(models: ModelInfo[], ref: ModelRef | undefined): boolean {
  if (!ref) return false;
  return models.some((model) => model.id === ref.id && model.providerID === ref.providerID && isUsable(model));
}

export async function listModels(client: Client, directory: string): Promise<ModelInfo[]> {
  const response = await client.GET("/api/model", {
    params: { query: { location: { directory } } },
  });
  if (response.error) throw new Error(`model list failed: ${JSON.stringify(response.error)}`);
  return (response.data as { data?: ModelInfo[] })?.data ?? [];
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/** Caches per directory for a few minutes so we do not refetch on every prompt. */
export class FreeModelSelector {
  private cache = new Map<string, { at: number; models: ModelInfo[] }>();

  /**
   * @param fallbackDirectories directories to try when a location returns no catalogue.
   *   A brand-new project directory can report zero models until OpenCode has registered it,
   *   and returning nothing would silently push the session onto a metered default.
   */
  constructor(
    private client: Client,
    private ttlMs: number = CACHE_TTL_MS,
    private fallbackDirectories: string[] = [],
  ) {}

  private async models(directory: string): Promise<ModelInfo[]> {
    const hit = this.cache.get(directory);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.models;
    let models = await listModels(this.client, directory);
    if (models.length === 0) {
      for (const fallback of this.fallbackDirectories) {
        if (fallback === directory) continue;
        models = await listModels(this.client, fallback);
        if (models.length > 0) break;
      }
    }
    this.cache.set(directory, { at: Date.now(), models });
    return models;
  }

  /** Preferred model for a chat that has no explicit choice. */
  async auto(directory: string): Promise<ModelRef | undefined> {
    return pickFreeVisionModel(await this.models(directory));
  }

  /** False when a previously chosen model has been removed, retired or renamed upstream. */
  async stillAvailable(directory: string, ref: ModelRef | undefined): Promise<boolean> {
    if (!ref) return false;
    return isModelAvailable(await this.models(directory), ref);
  }
}