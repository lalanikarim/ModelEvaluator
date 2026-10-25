#!/usr/bin/env node
// ModelEvaluator CLI.
//
//   node run.mjs --list                        list tasks + model matrix (no endpoint needed)
//   node run.mjs --track coding                run the coding suite
//   node run.mjs --track coding --models qwen-27b-q4 --tasks fib-basic --repeats 3
import { parseArgs } from "node:util";
import { join } from "node:path";
import { loadDotEnv } from "./harness/env.mjs";
import { loadModelMatrix } from "./harness/models.mjs";
import { loadTasks } from "./harness/tasks.mjs";
import { runSuite } from "./harness/scheduler.mjs";

loadDotEnv();

const { values } = parseArgs({
  options: {
    list: { type: "boolean" },
    track: { type: "string" },
    models: { type: "string" },
    tasks: { type: "string" },
    repeats: { type: "string" },
    "include-held-out": { type: "boolean" },
    "run-id": { type: "string" },
  },
});

const comma = (s) => s?.split(",").map((x) => x.trim()).filter(Boolean);

if (values.list) {
  const tasks = loadTasks();
  console.log("tasks:");
  for (const t of tasks) console.log(`  ${t.id} (${t.track}, tools=${t.tools}, repeats=${t.repeats}) — ${t.title}`);
  let models = [];
  try { models = loadModelMatrix(); } catch (e) { console.log(`models: (unavailable: ${e.message})`); }
  console.log("models:");
  for (const m of models) console.log(`  ${m.id} (family=${m.family}, quant=${m.quant ?? "?"}, thinking=${m.thinking_level})`);
  process.exit(0);
}

let tasks = loadTasks("tasks", values.track);
// Held-out tasks are excluded from normal runs (final leaderboard only).
if (!values["include-held-out"]) tasks = tasks.filter((t) => !t.held_out);
if (tasks.length === 0) {
  console.error(`no tasks found for track '${values.track ?? "(all)"}' in tasks/`);
  process.exit(1);
}
let models = loadModelMatrix();
if (values.models) {
  const wanted = comma(values.models);
  models = models.filter((m) => wanted.includes(m.id));
  if (models.length === 0) { console.error(`none of --models ${wanted.join(",")} in models.yaml`); process.exit(1); }
}
if (values.tasks) {
  const wanted = comma(values.tasks);
  const filtered = tasks.filter((t) => wanted.includes(t.id));
  if (filtered.length === 0) { console.error(`none of --tasks ${wanted.join(",")} in tasks/`); process.exit(1); }
  tasks = filtered;
}

const runId = values["run-id"] ?? new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join("results", runId);
console.log(`run ${runId}: ${tasks.length} task(s) × ${models.length} model(s), sequential`);

const { aggregate } = await runSuite({ tasks, models, runDir, repeatsOverride: values.repeats ? Number(values.repeats) : undefined, onProgress: (msg) => console.log(msg) });
console.log("\n--- summary ---");
for (const m of aggregate.models) {
  console.log(`${m.model}: pass=${m.pass_rate ?? "-"} (${m.scored_trials} scored) mean=${m.mean_secs?.toFixed(1)}s tok=${Math.round(m.mean_tokens_in ?? 0)}/${Math.round(m.mean_tokens_out ?? 0)} infra_err=${m.infra_errors} timeouts=${m.timeouts}`);
}
console.log(`results: ${runDir}/ (results.json, aggregate.json)`);
