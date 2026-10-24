// Oracle scorer: runs hidden tests against a trial's workdir. Tests are plain
// Python scripts (exit 0 = pass). They live in the task fixture dir and are
// never referenced in prompts, so models cannot see or game them.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Run hidden tests for a task against workdir.
 * @param {string} [testRelPaths] override the test list (e.g. bonus tests)
 * @returns {{ pass: boolean, details: Array<{test: string, ok: boolean, output: string}> }}
 */
export function runOracle(task, workdir, testRelPaths) {
  const details = [];
  let pass = true;
  for (const rel of testRelPaths ?? task.oracle.hidden_tests ?? []) {
    const testPath = join(task.dir, rel);
    let ok = false, output = "";
    try {
      const out = execFileSync("python3", [testPath], { cwd: workdir, timeout: 60000, encoding: "utf8" });
      ok = true;
      output = out.trim().slice(-2000);
    } catch (err) {
      output = ((err.stdout ?? "") + "\n" + (err.stderr ?? "") + "\n" + err.message).trim().slice(-2000);
    }
    details.push({ test: rel, ok, output });
    if (!ok) pass = false;
  }
  return { pass, details };
}
