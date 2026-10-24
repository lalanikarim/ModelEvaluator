#!/usr/bin/env node
// Static, self-contained HTML leaderboard generator (no external CSS/JS/fonts).
//   node leaderboard/generate.mjs <results/run-dir>
//   node leaderboard/generate.mjs --latest
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

function loadRun(runDir) {
  const results = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8"));
  const aggregate = JSON.parse(readFileSync(join(runDir, "aggregate.json"), "utf8"));
  return { runId: results.run_id, records: results.records, aggregate };
}

function latestRun() {
  const runs = readdirSync("results").filter((d) => existsSync(join("results", d, "results.json")));
  if (runs.length === 0) throw new Error("no completed runs found in results/");
  return join("results", runs.sort().at(-1));
}

// Elo over per-task pass counts: for each task where two models both have scored
// trials, the one with more passes gets a K=32 update. Ties leave ratings unchanged.
function computeElo(records) {
  const byModelTask = {}; // model -> task -> {passes, n}
  for (const r of records) {
    if (r.warmup || r.status === "infra_error" || r.status === "timeout") continue;
    const key = `${r.manifest.model_id}|${r.manifest.task_id}`;
    byModelTask[key] ??= { passes: 0, n: 0 };
    byModelTask[key].n++;
    if (r.ok) byModelTask[key].passes++;
  }
  const models = [...new Set(records.map((r) => r.manifest.model_id))];
  const tasks = [...new Set(records.map((r) => r.manifest.task_id))];
  const rating = Object.fromEntries(models.map((m) => [m, 1500]));
  const K = 32;
  for (const task of tasks) {
    for (let i = 0; i < models.length; i++) {
      for (let j = i + 1; j < models.length; j++) {
        const a = byModelTask[`${models[i]}|${task}`];
        const b = byModelTask[`${models[j]}|${task}`];
        if (!a || !b) continue;
        const sa = a.passes > b.passes ? 1 : a.passes === b.passes ? 0.5 : 0;
        const ea = 1 / (1 + 10 ** ((rating[models[j]] - rating[models[i]]) / 400));
        rating[models[i]] += K * (sa - ea);
        rating[models[j]] += K * ((1 - sa) - (1 - ea));
      }
    }
  }
  return Object.entries(rating).map(([model, elo]) => ({ model, elo: Math.round(elo) })).sort((x, y) => y.elo - x.elo);
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pct = (x) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);

function render({ runId, records, aggregate, elo }) {
  const models = aggregate.models;
  const byModel = Object.fromEntries(models.map((m) => [m.model, m]));
  const ranked = elo.map((e) => ({ ...e, meta: byModel[e.model] }));

  // Win-rate matrix from pairwise per-task results.
  let matrix = "";
  if (models.length > 1) {
    const ids = models.map((m) => m.model);
    matrix = `<table><tr><th></th>${ids.map((i) => `<th>${esc(i)}</th>`).join("")}</tr>` +
      ids.map((a) => {
        const cells = ids.map((b) => {
          if (a === b) return `<td class="self">—</td>`;
          const p = aggregate.pairwise.find((x) => x.model_a === a && x.model_b === b)
            ?? aggregate.pairwise.find((x) => x.model_a === b && x.model_b === a);
          if (!p) return `<td>?</td>`;
          const aWins = p.model_a === a ? p.a_wins : p.b_wins;
          const tot = p.a_wins + p.b_wins + p.ties || 1;
          return `<td>${((aWins / tot) * 100).toFixed(0)}%</td>`;
        }).join("");
        return `<tr><th>${esc(a)}</th>${cells}</tr>`;
      }).join("") + "</table>";
  }

  const taskIds = [...new Set(records.map((r) => r.manifest.task_id))];
  const perTask = taskIds.map((t) => {
    const rows = models.map((m) => {
      const scored = records.filter((r) => r.manifest.model_id === m.model && r.manifest.task_id === t && !r.warmup);
      const passes = scored.filter((r) => r.ok).length;
      return `<tr><td>${esc(m.model)}</td><td>${passes}/${scored.length}</td></tr>`;
    }).join("");
    return `<h3>${esc(t)}</h3><table><tr><th>model</th><th>pass</th></tr>${rows}</table>`;
  }).join("");

  const metrics = models.map((m) =>
    `<tr><td>${esc(m.model)}</td><td>${pct(m.pass_rate)}</td><td>${m.mean_secs?.toFixed(1) ?? "—"}s (±${m.secs_stddev?.toFixed(1) ?? 0})</td>` +
    `<td>${m.mean_turns?.toFixed(1) ?? "—"}</td><td>${Math.round(m.mean_tokens_in ?? 0)} / ${Math.round(m.mean_tokens_out ?? 0)}</td>` +
    `<td>${m.infra_errors}</td><td>${m.timeouts}</td></tr>`,
  ).join("");

  const drilldown = records.map((r) => {
    const m = r.manifest;
    const badge = r.ok ? "PASS" : r.status === "infra_error" || r.status === "timeout" ? r.status.toUpperCase() : "FAIL";
    const oracleOut = (r.oracle?.details ?? []).map((d) => `<pre>${esc(d.output)}</pre>`).join("");
    return `<details>
      <summary><b>${badge}</b> ${esc(m.model_id)} · ${esc(m.task_id)} · r${records.indexOf(r) + 1}${m.warmup ? " (warmup)" : ""}
        ${r.metrics ? `· ${r.metrics.secs}s · ${r.metrics.turns} turns · tok ${r.metrics.uIn}/${r.metrics.uOut}` : ""}</summary>
      <p><code>served: ${esc(m.served_model)} @ ${esc(m.endpoint)} · quant ${esc(m.quant ?? "?")} · thinking ${esc(m.thinking_level)} · commit ${esc(m.git_commit)}</code></p>
      ${r.error ? `<p class="err">error: ${esc(r.error)}</p>` : ""}
      ${r.gates && !r.gates.pass ? `<p class="err">gates failed: ${esc(r.gates.failures.join("; "))}</p>` : ""}
      ${r.judge?.scores ? `<p>judge: ${Object.entries(r.judge.scores).map(([k, v]) => `${esc(k)}=${v}`).join(", ")} · avg ${r.judge.weighted_avg}</p><pre>${esc(r.judge.rationale)}</pre>` : ""}
      ${r.judge?.error ? `<p class="err">judge error: ${esc(r.judge.error)}</p>` : ""}
      ${r.answer ? `<h4>final answer / plan</h4><pre>${esc(r.answer)}</pre>` : ""}
      ${oracleOut ? `<h4>oracle output</h4>${oracleOut}` : ""}
    </details>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>ModelEvaluator — run ${esc(runId)}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;margin:2rem auto;max-width:960px;color:#1a1a1a;line-height:1.5}
h1{border-bottom:2px solid #333;padding-bottom:.4rem}
table{border-collapse:collapse;margin:1rem 0}
th,td{border:1px solid #ccc;padding:.35rem .7rem;text-align:left;font-size:.92rem}
th{background:#f4f4f4}
td.self{color:#999}
pre{background:#f6f6f6;border:1px solid #ddd;padding:.6rem;overflow-x:auto;font-size:.85rem;white-space:pre-wrap}
details{margin:.5rem 0;border:1px solid #ddd;border-radius:4px;padding:.4rem .7rem}
summary{cursor:pointer}
.err{color:#b00020}
.meta{color:#555;font-size:.9rem}
</style></head><body>
<h1>ModelEvaluator — run ${esc(runId)}</h1>
<p class="meta">generated ${new Date().toISOString()} · ${records.length} trials · self-contained (no external assets)</p>

<h2>Ranking (Elo, K=32, per-task pass counts)</h2>
<table><tr><th>#</th><th>model</th><th>Elo</th><th>family</th><th>quant</th><th>pass rate</th></tr>
${ranked.map((e, i) => `<tr><td>${i + 1}</td><td>${esc(e.model)}</td><td>${e.elo}</td><td>${esc(e.meta?.family ?? "?")}</td><td>${esc(e.meta?.quant ?? "?")}</td><td>${pct(e.meta?.pass_rate)}</td></tr>`).join("")}
</table>

<h2>Pairwise win rate (per-task)</h2>
${matrix || "<p>single-model run — no pairwise data</p>"}

<h2>Per-task results</h2>
${perTask}

<h2>Metrics (scored trials, warm-up excluded)</h2>
<table><tr><th>model</th><th>pass rate</th><th>time</th><th>turns</th><th>tokens in/out</th><th>infra errors</th><th>timeouts</th></tr>
${metrics}
</table>

<h2>Trial drill-down</h2>
${drilldown}
</body></html>`;
}

const arg = process.argv[2];
if (!arg) { console.error("usage: node leaderboard/generate.mjs <results/run-dir> | --latest"); process.exit(1); }
const runDir = resolve(arg === "--latest" ? latestRun() : arg);
const data = loadRun(runDir);
const elo = computeElo(data.records);
const html = render({ ...data, elo });
const out = join(runDir, "leaderboard.html");
writeFileSync(out, html);
console.log(`wrote ${out}`);
