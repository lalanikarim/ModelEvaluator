// One trial: one task × one model × one repeat, in an isolated workdir + SQLite DB.
// Produces a manifest (reproducibility) and a record (metrics + oracle result).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { CodingTools, createReadTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
 * Run one agent pass (a single prompt through a fresh harness conversation) and
 * collect status, final answer text, and transcript metrics.
 * Throws on infra failure; returns status 'timeout' on budget expiry.
 */
async function runAgentPass({ dbPath, workdir, models, resolved, model, profile, prompt, requestId, timeoutSec }) {
  const t0 = Date.now();
  let h = null;
  try {
    h = await Harness.open(
      await openNodeSqliteStorage(dbPath),
      { models, registry: toolRegistry(profile), env: () => new NodeExecutionEnv({ cwd: workdir }) },
      ctx,
    );
    h.resume();
    const root = await h.root(ctx, {
      agent: { model: { provider: resolved.providerId, modelId: resolved.modelId }, thinkingLevel: model.thinking_level },
    });
    const sub = await root.submit({ type: "input", content: prompt, requestId }, ctx);

    let settled;
    try {
      settled = await Promise.race([
        sub.wait(ctx),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeoutSec}s`)), timeoutSec * 1000).unref()),
      ]);
    } catch (err) {
      if (/^timeout/.test(err.message)) return { status: "timeout", answer: "", metrics: null, error: err.message };
      throw err; // infra/model failure — let the caller classify
    }

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
    let answer = "";
    let status = settled?.status === "done" ? "done" : `settled:${settled?.status ?? "unknown"}`;
    if (status === "done") {
      const a = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
      answer = (a?.model ?? []).flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text)).join("\n");
    }
    return { status, answer, metrics: { secs: +((Date.now() - t0) / 1000).toFixed(1), turns, toolCalls, toolErrors, uIn, uOut }, error: null };
  } finally {
    if (h) await h.close(ctx).catch(() => {});
  }
}

/**
 * Run one trial.
 * @param {object} p
 * @param {object} p.task      validated task fixture (with .dir)
 * @param {object} p.model     models.yaml entry
 * @param {{providerId: string, modelId: string, modelName: string}} p.resolved
 * @param {object} p.models    pi-ai Models registry for this model
 * @param {{baseUrl: string, apiKey: string, modelId: string, sameAsCompetitor?: boolean}} [p.judge]
 * @param {string} p.runDir    results/<run_id>
 * @param {number} p.repeat    1-based repeat index
 * @param {boolean} p.warmup   true if this run is discarded from scoring
 * @returns {Promise<object>} trial record (also written to disk)
 */
export async function runTrial({ task, model, resolved, models, judge, runDir, repeat, warmup }) {
  const trialDir = join(runDir, model.id, task.id, `r${repeat}`);
  const workdir = join(trialDir, "work");
  mkdirSync(workdir, { recursive: true });
  // Seed fixture files (e.g. the codebase a planning task must read).
  const fixtureDir = join(task.dir, "fixture");
  if (existsSync(fixtureDir)) cpSync(fixtureDir, workdir, { recursive: true });

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
    judge_model: task.oracle.type === "plan" ? judge?.modelId ?? null : undefined,
    judge_same_as_competitor: task.oracle.type === "plan" ? Boolean(judge?.sameAsCompetitor) : undefined,
    start_ts: new Date().toISOString(),
  };

  const record = { manifest, status: "failed", ok: false, oracle: null, answer: "", metrics: null, error: null };
  try {
    const pass = await runAgentPass({
      dbPath: join(trialDir, "trial.sqlite"),
      workdir, models, resolved, model,
      profile: task.tools,
      prompt: task.prompt,
      requestId: `mev-${task.id}-${model.id}-r${repeat}`,
      timeoutSec: task.budget.timeout_sec,
    });
    record.status = pass.status;
    record.answer = pass.answer;
    record.metrics = pass.metrics;
    record.error = pass.error ?? (pass.status !== "done" ? `run settled with status ${pass.status}` : null);

    // Scoring dispatch: coding track -> hidden tests; planning track -> gates + blind LLM judge.
    if (task.oracle.type === "tests") {
      const { runOracle } = await import("../scorers/oracle.mjs");
      record.oracle = runOracle(task, workdir);
      record.ok = record.status === "done" && record.oracle.pass;
    } else if (task.oracle.type === "plan") {
      const { checkPlanGates } = await import("../scorers/plan-gates.mjs");
      const { judgePlan } = await import("../scorers/judge.mjs");
      record.gates = checkPlanGates(task, record.answer);
      if (record.status === "done") {
        try {
          record.judge = await judgePlan(task, record.answer, judge);
        } catch (err) {
          record.judge = { error: String(err?.message ?? err).slice(0, 300) };
        }
      }
      const threshold = task.oracle.rubric.pass_threshold;
      record.ok = record.status === "done" && record.gates.pass
        && !record.judge?.error && record.judge.weighted_avg >= threshold;

      // Bonus: plan-to-code — feed the plan back to a coding agent in a fresh
      // workdir and verify the result against hidden tests. Reported separately.
      if (task.bonus?.type === "plan-to-code" && record.status === "done") {
        const execDir = join(trialDir, "execution");
        const execWork = join(execDir, "work");
        mkdirSync(execWork, { recursive: true });
        if (existsSync(fixtureDir)) cpSync(fixtureDir, execWork, { recursive: true });
        const bonusBudget = task.bonus.budget ?? task.budget;
        try {
          const execPass = await runAgentPass({
            dbPath: join(execDir, "execution.sqlite"),
            workdir: execWork, models, resolved, model,
            profile: "coding",
            prompt: `You are implementing an approved implementation plan. Implement it now in your working directory. Use your tools to make the changes and verify by running the code where applicable.\n\n<plan>\n${record.answer}\n</plan>`,
            requestId: `mev-${task.id}-${model.id}-r${repeat}-exec`,
            timeoutSec: bonusBudget.timeout_sec,
          });
          const { runOracle } = await import("../scorers/oracle.mjs");
          const bonusOracle = runOracle(task, execWork, task.bonus.hidden_tests);
          record.execution = {
            status: execPass.status,
            metrics: execPass.metrics,
            oracle: bonusOracle,
            ok: execPass.status === "done" && bonusOracle.pass,
          };
        } catch (err) {
          record.execution = { status: "infra_error", error: String(err?.message ?? err).slice(0, 300) };
        }
      }
    } else {
      record.ok = false; // unknown oracle type (should be caught by validation)
    }
  } catch (err) {
    // Distinguish infra failures (endpoint down, harness crash) from model failure.
    record.status = "infra_error";
    record.error = String(err?.message ?? err).slice(0, 500);
  } finally {
    manifest.end_ts = new Date().toISOString();
    writeFileSync(join(trialDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(trialDir, "record.json"), JSON.stringify(record, null, 2));
  }
  return record;
}
