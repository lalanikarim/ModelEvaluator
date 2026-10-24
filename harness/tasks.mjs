// Task fixture loading + validation. Fixtures are YAML files at tasks/<track>/<id>/task.yaml.
import { parse } from "yaml";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REQUIRED = ["id", "track", "title", "prompt", "tools", "oracle", "budget"];
const TRACKS = new Set(["coding", "planning"]);
const TOOL_PROFILES = new Set(["coding", "planning"]);

function validate(task, relPath) {
  for (const k of REQUIRED) {
    if (task[k] === undefined || task[k] === null) throw new Error(`${relPath}: missing field '${k}'`);
  }
  if (!TRACKS.has(task.track)) throw new Error(`${relPath}: unknown track '${task.track}'`);
  if (!TOOL_PROFILES.has(task.tools)) throw new Error(`${relPath}: unknown tools profile '${task.tools}'`);
  const dirName = relPath.split("/")[1];
  if (task.id !== dirName) throw new Error(`${relPath}: task.id '${task.id}' must match directory name '${dirName}'`);
  if (!task.oracle?.type) throw new Error(`${relPath}: oracle.type required`);
  if (task.oracle.type === "tests") {
    for (const t of task.oracle.hidden_tests ?? []) {
      if (!existsSync(join(task.dir, t))) throw new Error(`${relPath}: hidden test not found: ${t}`);
    }
  } else if (task.oracle.type === "plan") {
    const rubric = task.oracle.rubric;
    if (!Array.isArray(rubric?.criteria) || rubric.criteria.length === 0) throw new Error(`${relPath}: plan oracle requires rubric.criteria`);
    if (rubric.pass_threshold == null || rubric.pass_threshold < 1 || rubric.pass_threshold > 5) {
      throw new Error(`${relPath}: rubric.pass_threshold must be in 1..5`);
    }
    const wsum = rubric.criteria.reduce((a, c) => a + (rubric.weights?.[c] ?? 0), 0);
    if (Math.abs(wsum - 1) > 0.01) throw new Error(`${relPath}: rubric weights must sum to 1 (got ${wsum})`);
  } else {
    throw new Error(`${relPath}: unknown oracle.type '${task.oracle.type}'`);
  }
  const b = task.budget;
  for (const k of ["max_turns", "max_tokens", "timeout_sec"]) {
    if (typeof b[k] !== "number" || b[k] <= 0) throw new Error(`${relPath}: budget.${k} must be a positive number`);
  }
  if (task.bonus) {
    if (task.bonus.type !== "plan-to-code") throw new Error(`${relPath}: unknown bonus.type '${task.bonus.type}'`);
    for (const t of task.bonus.hidden_tests ?? []) {
      if (!existsSync(join(task.dir, t))) throw new Error(`${relPath}: bonus test not found: ${t}`);
    }
  }
  task.repeats = task.repeats ?? 5;
  if (!Number.isInteger(task.repeats) || task.repeats < 1) throw new Error(`${relPath}: repeats must be a positive integer`);
  return task;
}

/** Load all fixtures for a track (or all tracks). Returns [{id, track, ...fixture, dir}]. */
export function loadTasks(root = "tasks", track = null) {
  const out = [];
  const tracks = track ? [track] : readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const t of tracks) {
    if (!existsSync(join(root, t))) continue;
    const taskDirs = readdirSync(join(root, t), { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of taskDirs) {
      const rel = join(t, d.name, "task.yaml");
      if (!existsSync(join(root, rel))) continue;
      const taskDir = resolve(join(root, t, d.name));
      const task = { ...parse(readFileSync(join(root, rel), "utf8")), dir: taskDir };
      validate(task, rel);
      out.push(task);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
