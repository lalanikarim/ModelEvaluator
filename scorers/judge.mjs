// Blind LLM judge for planning-track plans. Talks directly to an OpenAI-compatible
// endpoint (no harness needed). The candidate plan carries no model identity, so
// the judge cannot attribute it. Judge config comes from models.yaml (`judge:`);
// if absent, falls back to a competitor entry with `same_as_competitor: true` flagged.
import { parse } from "yaml";
import { readFileSync } from "node:fs";

function buildJudgePrompt(task, planText) {
  const rubric = task.oracle.rubric;
  return `You are an expert software engineering reviewer. Score the following implementation plan against the rubric. Be strict and concrete.

## Task given to the candidate
${task.prompt}

## Candidate plan (score this text as-is)
<plan>
${planText}
</plan>

## Rubric — score each criterion 1-5 (integer)
${rubric.criteria.map((c) => `- ${c}`).join("\n")}

Anchors: 1 = missing/irrelevant, 3 = adequate but incomplete, 5 = thorough and directly actionable.

Respond with ONLY a JSON object, no markdown fences:
{"scores": {"<criterion>": <int 1-5>, ...}, "rationale": "<2-4 sentences>"}`;
}

function parseJudgeJson(text) {
  // Tolerate accidental code fences or leading prose.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`judge returned no JSON: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

/**
 * Judge one plan.
 * @param {{baseUrl: string, apiKey: string, modelId: string, sameAsCompetitor?: boolean}} judge
 * @returns {Promise<{scores: object, weighted_avg: number, rationale: string}>}
 */
export async function judgePlan(task, planText, judge) {
  const res = await fetch(`${judge.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${judge.apiKey}` },
    body: JSON.stringify({
      model: judge.modelId,
      temperature: 0,
      messages: [{ role: "user", content: buildJudgePrompt(task, planText) }],
    }),
  });
  if (!res.ok) throw new Error(`judge endpoint failed: ${res.status} ${await res.text().catch(() => "")}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const parsed = parseJudgeJson(content);

  const rubric = task.oracle.rubric;
  const scores = {};
  for (const c of rubric.criteria) {
    const v = Number(parsed.scores?.[c]);
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new Error(`judge score out of range for '${c}': ${parsed.scores?.[c]}`);
    scores[c] = v;
  }
  const totalWeight = rubric.criteria.reduce((a, c) => a + (rubric.weights?.[c] ?? 1 / rubric.criteria.length), 0);
  const weighted_avg = rubric.criteria.reduce((a, c) => a + scores[c] * (rubric.weights?.[c] ?? 1 / rubric.criteria.length), 0) / totalWeight;
  return { scores, weighted_avg: +weighted_avg.toFixed(2), rationale: parsed.rationale ?? "" };
}

/**
 * Resolve judge config from models.yaml. Falls back to the first competitor entry.
 */
export function loadJudgeConfig(file = "models.yaml") {
  const doc = parse(readFileSync(file, "utf8"));
  const entry = doc.judge ?? doc.models?.[0];
  if (!entry) throw new Error(`no judge or models defined in ${file}`);
  const sameAsCompetitor = !doc.judge;
  return { ...entry, sameAsCompetitor };
}
