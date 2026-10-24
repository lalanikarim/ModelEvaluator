// Sequential scheduler: models × tasks × repeats. One model at a time per host.
// Warm-up (repeat 1 per model/task) is recorded but excluded from scoring.
// Infra errors are retried up to 2 extra attempts; persistent failure stays infra_error.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveModel, modelsRegistry } from "./models.mjs";
import { runTrial } from "./trial.mjs";

const MAX_INFRA_RETRIES = 2;

export async function runSuite({ tasks, models, runDir, repeatsOverride, onProgress }) {
  mkdirSync(runDir, { recursive: true });
  const records = [];

  for (const model of models) {
    // Resolve once per model: sequential runs mean the endpoint serves exactly this model.
    const resolved = await resolveModel(model);
    const registry = modelsRegistry(model, resolved);
    onProgress?.(`model ${model.id} → served '${resolved.modelName}' @ ${resolved.baseUrl}`);

    for (const task of tasks) {
      const repeats = repeatsOverride ?? task.repeats;
      for (let r = 1; r <= repeats; r++) {
        let record;
        for (let attempt = 0; ; attempt++) {
          record = await runTrial({ task, model, resolved, models: registry, runDir, repeat: r, warmup: r === 1 });
          if (record.status !== "infra_error" || attempt >= MAX_INFRA_RETRIES) break;
          onProgress?.(`retry ${attempt + 1}/${MAX_INFRA_RETRIES} infra error (${task.id}/${model.id}/r${r}): ${record.error}`);
        }
        records.push(record);
        const m = record.metrics ?? {};
        onProgress?.(
          `[${task.id} ${model.id} r${r}${record.warmup ? " warmup" : ""}] ${record.status} ` +
          `ok=${record.ok ?? "-"} ${m.secs ?? "?" }s turns=${m.turns ?? "?"} tools=${m.toolCalls ?? "?"} tok=${m.uIn ?? "?"}/${m.uOut ?? "?"}` +
          (record.error ? ` err=${record.error.slice(0, 120)}` : ""),
        );
      }
    }
  }

  writeFileSync(join(runDir, "results.json"), JSON.stringify({ run_id: runDir.split("/").pop(), records }, null, 2));
  const { aggregate } = await import("../scorers/aggregate.mjs");
  const agg = aggregate(records);
  writeFileSync(join(runDir, "aggregate.json"), JSON.stringify(agg, null, 2));
  return { records, aggregate: agg };
}
