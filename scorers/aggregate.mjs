// Minimal aggregation (Phase 2 expands this into the leaderboard).
// Warm-up runs are excluded from scoring. infra_error runs are excluded from
// correctness stats but reported separately.

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function aggregate(records) {
  const byModel = {};
  for (const r of records) {
    const id = r.manifest.model_id;
    byModel[id] ??= { model: id, family: r.manifest.model_family, quant: r.manifest.quant, scored: [], infra_errors: 0, timeouts: 0 };
    const b = byModel[id];
    if (r.status === "infra_error") { b.infra_errors++; continue; }
    if (r.status === "timeout") { b.timeouts++; continue; }
    if (r.warmup) continue;
    b.scored.push(r);
  }

  const models = Object.values(byModel).map((b) => ({
    model: b.model,
    family: b.family,
    quant: b.quant,
    scored_trials: b.scored.length,
    pass_rate: b.scored.length ? b.scored.filter((r) => r.ok).length / b.scored.length : null,
    mean_secs: mean(b.scored.map((r) => r.metrics?.secs ?? 0)),
    secs_stddev: stddev(b.scored.map((r) => r.metrics?.secs ?? 0)),
    mean_turns: mean(b.scored.map((r) => r.metrics?.turns ?? 0)),
    mean_tokens_in: mean(b.scored.map((r) => r.metrics?.uIn ?? 0)),
    mean_tokens_out: mean(b.scored.map((r) => r.metrics?.uOut ?? 0)),
    infra_errors: b.infra_errors,
    timeouts: b.timeouts,
  }));

  // Pairwise win rate on common (task, repeat) pairs where both models scored.
  const pairs = [];
  const modelIds = Object.keys(byModel);
  for (let i = 0; i < modelIds.length; i++) {
    for (let j = i + 1; j < modelIds.length; j++) {
      const [A, B] = [modelIds[i], modelIds[j]];
      let aWins = 0, bWins = 0, ties = 0;
      // Unit of comparison: per-task pass count over scored repeats.
      const taskIds = new Set([...byModel[A].scored, ...byModel[B].scored].map((r) => r.manifest.task_id));
      for (const t of taskIds) {
        const ap = byModel[A].scored.filter((r) => r.manifest.task_id === t && r.ok).length;
        const bp = byModel[B].scored.filter((r) => r.manifest.task_id === t && r.ok).length;
        if (ap > bp) aWins++; else if (bp > ap) bWins++; else ties++;
      }
      pairs.push({ model_a: A, model_b: B, a_wins, b_wins, ties });
    }
  }

  return { generated_at: new Date().toISOString(), models, pairwise: pairs };
}
