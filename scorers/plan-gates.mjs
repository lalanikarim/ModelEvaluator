// Structural gates for planning-track plans. Hard pass/fail checks that run
// before (and independent of) the LLM judge. A gate failure zeroes the plan.
/**
 * @param {{gates: {required_terms?: string[], forbidden_terms?: string[], min_words?: number}}} task
 * @param {string} planText
 * @returns {{pass: boolean, failures: string[]}}
 */
export function checkPlanGates(task, planText) {
  const gates = task.oracle?.gates ?? {};
  const failures = [];
  const text = planText.toLowerCase();

  for (const term of gates.required_terms ?? []) {
    if (!text.includes(term.toLowerCase())) failures.push(`missing required term: ${term}`);
  }
  for (const term of gates.forbidden_terms ?? []) {
    if (text.includes(term.toLowerCase())) failures.push(`forbidden term present: ${term}`);
  }
  const words = planText.trim().split(/\s+/).filter(Boolean).length;
  if (gates.min_words && words < gates.min_words) failures.push(`too short: ${words} words < ${gates.min_words}`);

  return { pass: failures.length === 0, failures };
}
