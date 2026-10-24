# PLAN — ModelEvaluator

## Goal

Build a harness that pits language models against each other on planning and coding tasks, producing a reproducible, auditable leaderboard. Local inference only.

## Decisions (from discussion)

1. **Local vs local**: models run on local hosts; one model at a time per host for fairness; at most 2 concurrent models if separate hosts. Sequential official runs; 2-host fast lane for iteration.
2. **Judge**: hybrid — rule-based oracle primary (tests), LLM-judge secondary for subjective dims, human review for ties/edge cases.
3. **Planning scoring**: structural checks (hard gates) + rubric LLM-judge + downstream plan-to-code success track.
4. **Deliverable**: harness (CLI) + static self-contained HTML leaderboard.

## Architecture

- `tasks/` — task fixtures (YAML/JSON): coding + planning suites, each with prompt, tool profile, oracle, hidden tests, rubric.
- `harness/` — runner: scheduler (sequential, warm-up discard), isolation (per-trial SQLite + workdir), artifact capture (diffs, transcripts, logs), manifest writer.
- `scorers/` — oracle plugin (test runner) + LLM-judge plugin (blind, different-family judge).
- `leaderboard/` — static HTML generator from results JSON.
- `results/` — run artifacts (gitignored).

## Metrics

Correctness (pass/fail, hidden tests), efficiency (tokens, turns, wall time), robustness (crash recovery, tool errors), safety (injection probe), reproducibility (variance across K repeats).

## Anti-gaming

Hidden tests not in prompt; held-out task set; time/token budgets; report all repeats (no best-of-K cherry-picking); pin model versions/quantization; reproducibility manifest per run.

## Phases

1. Scaffold repo + task fixtures (coding track first, reusing PiDurable 10-bench battery extended to multi-model + hidden tests).
2. Multi-model runner with manifest + artifact capture.
3. Oracle scorer + static HTML leaderboard.
4. Planning track + LLM-judge + plan-to-code track.
5. Calibration: human review of disputed cases, judge agreement analysis.

## Risks

- Confounding from quantization/warm-up/prompt drift — mitigate with manifests and warm-up discard.
- LLM-judge bias — mitigate with blind judging, cross-family judge, rubrics, multiple judges.
- Throughput — sequential runs; schedule carefully.
