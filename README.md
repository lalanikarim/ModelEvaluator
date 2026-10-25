# Model Arena

A harness that pits language models against each other on **planning** and **coding** tasks, producing a reproducible, auditable leaderboard.

**Status:** Phases 1–4 complete (coding, planning + judge, plan→code, static leaderboard); Phase 5 partial — injection probe, held-out filtering, and disputed-case flagging are in; multi-judge agreement awaits a second judge endpoint. See [PLAN.md](PLAN.md).

## Concept

Each task runs against every candidate model under identical conditions (same tool surface, prompt, temperature, seed) in isolated workspaces. Results are scored by an independent oracle (hidden tests for coding; structural gates + rubric LLM-judge for planning) and published as a self-contained HTML leaderboard.

## Design principles

- **Local-first**: models run on local inference hosts; one model at a time per host for fairness.
- **Oracle is king**: deterministic tests override LLM-judge on correctness.
- **Reproducible**: every run records a manifest (model id, quantization, commit, seed, temperature).
- **Independent review**: judge selected from a different model family than competitors.
- **Human owns the merge**: agents never merge (per SoftwareFactory).

## Layout (planned)

```
tasks/          Task fixtures (YAML) — coding + planning suites
harness/        Runner: scheduler, isolation, artifact capture, manifest
scorers/        Oracle plugin (test runner) + LLM-judge plugin
leaderboard/    Static HTML generator from results JSON
results/        Run artifacts (gitignored)
models.yaml     Candidate model matrix
run.mjs         CLI entry point
```

## Quickstart (planned)

```bash
npm install
# configure models.yaml + poc/.env-style endpoint
node run.mjs --track coding
node leaderboard/generate.mjs results/<run>/aggregate.json
```

## License

MIT — see [LICENSE](LICENSE).
