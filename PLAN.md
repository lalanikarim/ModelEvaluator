# PLAN — Model Arena

## Goal

Build a harness that pits language models against each other on planning and coding tasks, producing a reproducible, auditable leaderboard. Local inference only. No cloud dependencies.

## Decisions (from discussion)

1. **Local vs local**: models run on local inference hosts. One model at a time per host for fairness (no resource contention). At most 2 concurrent models if on separate hosts. Official leaderboard runs are sequential; a 2-host "fast lane" is allowed for iteration.
2. **Judge**: hybrid. Rule-based oracle is primary and authoritative on correctness. LLM-judge is secondary for subjective dimensions. Human review reserved for ties/edge cases and leaderboard calibration.
3. **Planning scoring**: structural checks as hard gates + rubric-based LLM-judge for quality + downstream plan-to-code success track.
4. **Deliverable**: CLI harness producing results JSON + a static, self-contained HTML leaderboard (consistent with SoftwareFactory's offline HTML report convention).

## Architecture

```
modelarena/
├── tasks/          Task fixtures (YAML) — coding + planning suites
├── harness/        Runner: scheduler, isolation, artifact capture, manifest
├── scorers/        Oracle plugin (test runner) + LLM-judge plugin
├── leaderboard/    Static HTML generator from results JSON
├── results/        Run artifacts (gitignored)
├── models.yaml     Candidate model matrix (id, endpoint, quant, family)
└── run.mjs         CLI entry point
```

### Task fixture schema (YAML)

```yaml
id: coding-fib-01
track: coding            # coding | planning
title: "Fibonacci module"
prompt: |
  Create a file fib.py ...
tools: coding            # coding | planning (maps to tool profile)
oracle:
  type: tests            # tests | rubric | plan-to-code
  hidden_tests: tests/test_fib.py
  forbidden_paths: [".env", "secrets/"]
rubric:                  # for planning track
  criteria: [completeness, feasibility, risk_awareness, scope_discipline]
  weights: { completeness: 0.3, feasibility: 0.3, risk_awareness: 0.2, scope_discipline: 0.2 }
budget:
  max_turns: 20
  max_tokens: 50000
  timeout_sec: 300
repeats: 5
```

### Tool profiles

- **coding**: `read`, `write`, `edit`, `bash` (matches PiDurable worker role). Scoped to a per-trial workdir.
- **planning**: read-only (`read`, `kb_search`, `web_fetch`). No shell, no writes (matches PiDurable researcher role). Output is a markdown plan.

### Model matrix (`models.yaml`)

```yaml
models:
  - id: qwen-27b-q4
    family: qwen
    endpoint: http://localhost:8000/v1
    model_id: auto        # auto-discovered via /v1/models
    quant: Q4_K_M
    thinking_level: medium
  - id: ...
```

Each entry records `family` so the LLM-judge can be selected from a different family (cross-family judging to reduce self-preference bias).

### Isolation per trial

- Fresh SQLite storage DB per trial (`results/<run>/<model>/<task>/<repeat>.sqlite`).
- Fresh workdir per trial (`results/<run>/<model>/<task>/<repeat>/work/`).
- No shared state between trials. PiDurable `Harness.open` + `resume()` pattern.

### Scheduler

- Outer loop: tasks × models × repeats.
- Warm-up: first run per (model, task) is discarded from scoring (GPU warm-up / cache).
- Sequential execution on one host. Optional 2-host parallelism via `--hosts` flag.
- Retry on transient infra failure (endpoint down) up to 2×; mark trial as `infra_error` if still failing (not counted as model failure).

### Reproducibility manifest (per trial, JSON)

```json
{
  "run_id": "2026-10-24T...",
  "task_id": "coding-fib-01",
  "model_id": "qwen-27b-q4",
  "model_family": "qwen",
  "quant": "Q4_K_M",
  "endpoint": "http://localhost:8000/v1",
  "served_model": "Qwen2.5-27B-Instruct-Q4_K_M",
  "temperature": 0.0,
  "seed": 42,
  "thinking_level": "medium",
  "git_commit": "abc1234",
  "harness_version": "0.1.0",
  "start_ts": "...",
  "end_ts": "...",
  "status": "done | failed | infra_error | timeout"
}
```

## Metrics

### Coding track
- **Correctness**: hidden tests pass/fail; test delta (new failures introduced).
- **Efficiency**: wall time, turns, tool calls, tokens in/out.
- **Robustness**: tool errors, crash recovery success.
- **Safety**: injection probe outcome (did the model follow injected instructions?).

### Planning track
- **Structural gates** (hard pass/fail): mentions test strategy, avoids forbidden paths, stays within scope, produces parseable plan.
- **Quality** (LLM-judge rubric): completeness, feasibility, risk awareness, scope discipline (0–5 each, weighted).
- **Plan-to-code success** (bonus track): feed plan to a coding agent; measure whether it produces passing code. Reported separately.

### Aggregate
- Per-model win rate vs each other (pairwise).
- Elo rating (K=32) updated per task.
- Per-task and per-track breakdowns.
- Variance across repeats (stddev of correctness) as a reliability signal.

## Scoring rules

1. Oracle (tests) is authoritative on correctness. LLM-judge never overrides a failing test.
2. LLM-judge is blind: model identity stripped from candidate output. Judge selected from a different family than competitors.
3. Judge rubric uses explicit criteria with anchors (1/3/5 examples). Multiple judges (≥2) with agreement reported (Cohen's kappa). Disagreement → human review.
4. Planning: structural gate failure → score 0 regardless of rubric.

## Anti-gaming

- Hidden tests not included in prompt; stored separately, never shown to models.
- Held-out task set never used during development; only for final leaderboard.
- Time and token budgets enforced; exceeding → task marked failed.
- Report all repeats; no best-of-K selection. Variance reported.
- Pin model versions + quantization; manifest records served model id.
- Snapshot workdirs + transcripts for audit.
- Prompt-injection probe run as part of safety metric (PiDurable 10-bench pattern).

## LLM-judge design

- Input: task prompt + candidate output (plan or diff + summary). Model identity removed.
- Output: JSON `{scores: {criterion: int}, rationale: string}`.
- Judge model: a strong model from a family distinct from all competitors (e.g., if competitors are Qwen/Llama, judge could be a Claude-class or GPT-class model via a separate endpoint; for fully-local runs, use the largest available model not in the competitor set).
- Run judge ≥2× per candidate with different seeds; require agreement ≥0.6 (Cohen's kappa) or flag for human review.

## Leaderboard (static HTML)

- Self-contained single HTML file (no external CSS/JS/fonts), consistent with SoftwareFactory convention.
- Sections: overall Elo + win-rate matrix, per-track breakdown, per-task breakdown, per-metric breakdown, trial drill-down (transcript + diff + manifest), model metadata.
- Generated from `results/<run>/aggregate.json` by `leaderboard/generate.mjs`.
- Start read-only/static; add interactivity only after data model stabilizes.

## Phases

### Phase 1 — Scaffold + coding track (MVP)
- Create repo layout, task loader, model matrix loader.
- Implement scheduler + isolation + manifest writer (reuse PiDurable harness pattern).
- Port PiDurable 10-bench battery as first coding tasks with hidden tests.
- Oracle scorer (test runner).
- Deliverable: `run.mjs --track coding` produces results JSON.

### Phase 2 — Leaderboard
- Aggregate script (win rates, Elo, variance).
- Static HTML generator.
- Deliverable: openable leaderboard from a run.

### Phase 3 — Planning track
- Planning tool profile + plan output capture.
- Structural gate checker.
- LLM-judge plugin (blind, cross-family).
- Deliverable: `--track planning` end-to-end.

### Phase 4 — Plan-to-code bonus track
- Feed plan to coding agent; measure pass rate.
- Report plan-to-code success separately.

### Phase 5 — Calibration & hardening
- Human review workflow for disputed cases.
- Judge agreement analysis.
- Held-out task set finalization.
- Injection probe integration into safety metric.

## Risks

- **Confounding**: quantization, warm-up, prompt drift. Mitigate with manifests + warm-up discard + pinned versions.
- **LLM-judge bias**: mitigated by blind judging, cross-family judge, rubrics, multiple judges, human tiebreak.
- **Throughput**: sequential runs; large matrices take days. Use fast lane for iteration.
- **Local model quality**: long-horizon coding may fail on smaller models; that's itself a valid data point — report failure rates, don't hide them.

## Non-goals (v1)

- No cloud model APIs (local only).
- No live/interactive leaderboard UI (static generated only).
- No automated model downloading or endpoint provisioning.
- No merging PRs (human owns merge).
