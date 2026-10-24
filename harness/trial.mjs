// One trial: one task × one model × one repeat, in an isolated workdir + SQLite DB.
// Produces a manifest (reproducibility) and a record (metrics + oracle result).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { CodingTools, createReadTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ctx = BACKGROUND_CONTEXT;
const HARNESS_VERSION = "0.1.0";

function toolRegistry(profile) {
  const registry = createRegistry();
  if (profile === "coding") {
    registry.install(CodingTools);
  } else if (profile === "planning") {
    // Read-only: plans are produced as the final message, not written to disk.
    registry.install(defineExtension({ name: "planning", tools: [createReadTool()] }));
  } else {
    throw new Error(`unknown tool profile: ${profile}`);
  }
  return registry;
}

function gitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim();
  } catch {
    return "no-git";
  }
}

/**
 * Run one trial.
 * @param {object} p
 * @param {object} p.task      validated task fixture (with .dir)
 * @param {object} p.model     models.yaml entry
 * @param {{providerId: string, modelId: string, modelName: string}} p.resolved
 * @param {object} p.models    pi-ai Models registry for this model
 * @param {string} p.runDir    results/<run_id>
 * @param {number} p.repeat    1-based repeat index
 * @param {boolean} p.warmup   true if this run is discarded from scoring
 * @returns {Promise<object>} trial record (also written to disk)
 */
export async function runTrial({ task, model, resolved, models, runDir, repeat, warmup }) {
  const trialDir = join(runDir, model.id, task.id, `r${repeat}`);
  const workdir = join(trialDir, "work");
  mkdirSync(workdir, { recursive: true });

  const manifest = {
    run_id: runDir.split("/").pop(),
    task_id: task.id,
    model_id: model.id,
    model_family: model.family,
    quant: model.quant ?? null,
    endpoint: resolved.baseUrl,
    served_model: resolved.modelName,
    temperature: 0.0, // local inference; harness does not set a non-zero temp
    thinking_level: model.thinking_level,
    git_commit: gitCommit(),
    harness_version: HARNESS_VERSION,
    warmup,
    start_ts: new Date().toISOString(),
  };

  let h = null;
  const t0 = Date.now();
  const record = { manifest, status: "failed", ok: false, oracle: null, answer: "", metrics: null, error: null };
  try {
    h = await Harness.open(
      await openNodeSqliteStorage(join(trialDir, "trial.sqlite")),
      { models, registry: toolRegistry(task.tools), env: () => new NodeExecutionEnv({ cwd: workdir }) },
      ctx,
    );
    h.resume();
    const root = await h.root(ctx, {
      agent: { model: { provider: resolved.providerId, modelId: resolved.modelId }, thinkingLevel: model.thinking_level },
    });
    const sub = await root.submit(
      { type: "input", content: task.prompt, requestId: `mev-${task.id}-${model.id}-r${repeat}` },
      ctx,
    );

    // Enforce the time budget; treat expiry as a distinct status.
    const timeoutMs = task.budget.timeout_sec * 1000;
    let settled;
    try {
      settled = await Promise.race([
        sub.wait(ctx),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${task.budget.timeout_sec}s`)), timeoutMs).unref()),
      ]);
    } catch (err) {
      if (/^timeout/.test(err.message)) {
        record.status = "timeout";
        record.error = err.message;
      } else {
        throw err; // rethrow: infra/model failure, handled by scheduler retry
      }
    }

    // Metrics from the conversation transcript.
    const page = await root.commit((tx) => tx.scanEntries({ conversationId: root.id }, 1000), ctx);
    let turns = 0, toolCalls = 0, toolErrors = 0, uIn = 0, uOut = 0;
    for (const item of page.items) {
      const k = item.kind ?? "unknown";
      if (k === "pi.assistant") {
        turns++;
        for (const m of item.model ?? []) { uIn += m.usage?.input ?? 0; uOut += m.usage?.output ?? 0; }
      }
      if (k === "pi.tool-result") {
        toolCalls++;
        const s = JSON.stringify(item);
        if (s.includes('"error"') || s.includes("interrupted") || s.includes("failed")) toolErrors++;
      }
    }
    record.metrics = { secs: +( (Date.now() - t0) / 1000 ).toFixed(1), turns, toolCalls, toolErrors, uIn, uOut };

    if (settled && settled.status === "done") {
      const a = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
      record.answer = (a?.model ?? []).flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text)).join("\n");
      if (record.status !== "timeout") record.status = "done";
    } else {
      record.error = `run settled with status ${settled?.status ?? "unknown"}`;
    }

    // Oracle scoring (coding track: hidden tests). Planning track is Phase 3.
    if (task.oracle.type === "tests") {
      const { runOracle } = await import("../scorers/oracle.mjs");
      record.oracle = runOracle(task, workdir);
      record.ok = record.status === "done" && record.oracle.pass;
    } else {
      record.ok = false; // scoring not implemented for this oracle type yet
    }
  } catch (err) {
    // Distinguish infra failures (endpoint down, harness crash) from model failure.
    record.status = "infra_error";
    record.error = String(err?.message ?? err).slice(0, 500);
  } finally {
    if (h) await h.close(ctx).catch(() => {});
    manifest.end_ts = new Date().toISOString();
    writeFileSync(join(trialDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(trialDir, "record.json"), JSON.stringify(record, null, 2));
  }
  return record;
}
