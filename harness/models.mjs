// Model matrix resolution: models.yaml -> per-model endpoint config + pi-ai registry.
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/** Parse models.yaml into the candidate list. */
export function loadModelMatrix(file = "models.yaml") {
  const doc = parse(readFileSync(file, "utf8"));
  if (!Array.isArray(doc?.models) || doc.models.length === 0) {
    throw new Error(`no models defined in ${file}`);
  }
  for (const m of doc.models) {
    if (!m.id || !m.family) throw new Error(`model entry missing id/family: ${JSON.stringify(m)}`);
    m.model_id = m.model_id ?? "auto";
    m.thinking_level = m.thinking_level ?? "medium";
  }
  return doc.models;
}

/**
 * Resolve the served model for one matrix entry.
 * Returns { providerId, baseUrl, apiKeyEnv, modelId, modelName }.
 */
export async function resolveModel(entry) {
  const baseUrl = (entry.endpoint ?? process.env.OPENAI_BASE_URL)?.replace(/\/+$/, "");
  const apiKeyEnv = entry.apiKeyEnv ?? "OPENAI_API_KEY";
  if (!baseUrl || !process.env[apiKeyEnv]) {
    throw new Error(`model '${entry.id}': set ${apiKeyEnv} + endpoint (models.yaml or .env)`);
  }
  let modelId, modelName;
  if (entry.model_id !== "auto") {
    modelId = entry.model_id;
    modelName = modelId;
  } else {
    const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${process.env[apiKeyEnv]}` } });
    if (!res.ok) throw new Error(`model '${entry.id}': GET /models failed: ${res.status}`);
    const list = (await res.json())?.data ?? [];
    if (list.length === 0) throw new Error(`model '${entry.id}': endpoint reported no models`);
    const m = list.find((x) => x.loaded) ?? list[0];
    modelId = m.id;
    modelName = m.display_name ?? m.id;
  }
  // Unique provider id per matrix entry so each trial pins exactly one served model.
  const providerId = `mev-${entry.id.replace(/[^a-z0-9-]/gi, "-")}`;
  // pi-ai's openai-completions api reads OPENAI_API_KEY at request time; mirror the
  // entry's key there. Safe because runs are strictly sequential (one model at a time).
  process.env.OPENAI_API_KEY = process.env[apiKeyEnv];
  return { providerId, baseUrl, apiKeyEnv, modelId, modelName };
}

/** pi-ai Models registry with the resolved endpoint registered for one matrix entry. */
export function modelsRegistry(entry, resolved) {
  const models = createModels();
  models.setProvider(
    createProvider({
      id: resolved.providerId,
      name: `modelarena endpoint (${entry.id})`,
      baseUrl: resolved.baseUrl,
      auth: { apiKey: envApiKeyAuth("OpenAI-compatible API key", [resolved.apiKeyEnv]) },
      models: [{
        id: resolved.modelId,
        name: resolved.modelName,
        provider: resolved.providerId,
        baseUrl: resolved.baseUrl,
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // local model — no $ cost
        contextWindow: 200000,
        maxTokens: 32000,
      }],
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
