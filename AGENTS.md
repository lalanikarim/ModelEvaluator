# AGENTS.md — Working in this repository

## What this is

ModelEvaluator: a harness for pitting language models against each other on planning and coding tasks. See [PLAN.md](PLAN.md) and [README.md](README.md).

## Repo layout

- `tasks/` — task fixtures (YAML). Coding + planning suites. Hidden tests live alongside but are never shown to models.
- `harness/` — runner: scheduler (sequential, warm-up discarded), isolation (per-trial SQLite + workdir), artifact capture, manifest writer.
- `scorers/` — oracle plugin (test runner) + LLM-judge plugin (blind, cross-family).
- `leaderboard/` — static HTML generator from results JSON.
- `results/` — run artifacts (gitignored).
- `models.yaml` — candidate model matrix.
- `run.mjs` — CLI entry point.

## Hard rules (non-negotiable)

- **Never commit on `main`.** Work on feature branches (`feature/…`, `chore/…`, `fix/…`, `refactor/…`) cut from an up-to-date `main`.
- **Sign off all commits**: `git commit -s -m "…"`.
- **Stage only intended files** (explicit paths, never `git add -A`).
- **Never merge PRs** — the human merges via GitHub UI. Agents may create PRs.
- **Never commit secrets.** Endpoints/keys stay in gitignored env files.
- **Oracle is authoritative** on correctness; LLM-judge never overrides a failing test.
- **Hidden tests must not leak** into prompts or committed fixtures visible to models.

## Conventions

- Reproducibility manifests are mandatory for every run.
- Task fixtures and model configs are version-controlled; run artifacts and results are not.
- LLM-judge must be from a different family than competitors (cross-family judging).
- Report all repeats; no best-of-K cherry-picking. Variance is a metric.
- Warm-up runs are discarded from scoring.
- Pin model versions + quantization; record served model id in manifest.

## Tooling

Built on Pi Durable (`@earendil-works/pi-durable`) for durable, isolated, reproducible agent runs. Local inference only (OpenAI-compatible endpoints). Node ≥ 22.19.

## Git workflow

1. `git checkout main && git pull origin main`
2. `git checkout -b feature/short-description`
3. Commit early/often with `-s`.
4. Run tests/lint before pushing.
5. `git push -u origin feature/short-description`
6. Open PR via `gh pr create` (or pr-create skill). Human merges.

## Style

- ESM `.mjs` / TypeScript where Pi Durable requires it.
- Keep scripts standalone-runnable with clear console output (double as acceptance tests).
- Self-contained HTML only for reports (no external CSS/JS/fonts).
