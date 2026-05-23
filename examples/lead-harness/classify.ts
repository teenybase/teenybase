// classify.ts — the loop machinery. Pure functions: text in, score out.
//
// **Forking agents: usually don't edit this file.** Edit `goal.ts` instead —
// that's where the ICP, constraints, FP shapes, and regex patterns live.
// Touch classify.ts only when you're changing the weights, thresholds, or
// the way the heuristic and LLM combine.
//
// Two versions kept side-by-side in the `scores` table so you can compare:
//   heuristic-v2  — fast regex pass, no LLM call
//   llm-v1        — DeepSeek via OpenRouter; falls back to heuristic on failure

import {
  GOAL,
  TP_CONSTRAINTS,
  FP_SHAPES,
  SIGNALS_INTENT,
  SIGNALS_FIT,
  SIGNALS_AGENT_GAP,
  SIGNALS_PAIN,
  NOISE,
  POSITIVE_GUARDS,
  GOAL_VERSION,
} from './goal.ts'

export const HEURISTIC_VERSION = `heuristic-${GOAL_VERSION}`
export const LLM_VERSION = `llm-${GOAL_VERSION}`
export const classifierVersion = HEURISTIC_VERSION  // default reported version

const THRESHOLD = 55
const REVIEW_THRESHOLD = 35

const SIGNALS: Record<string, RegExp[]> = {
  intent: SIGNALS_INTENT,
  blitz_fit: SIGNALS_FIT,
  agent_gap: SIGNALS_AGENT_GAP,
  pain: SIGNALS_PAIN,
}

const WEIGHTS: Record<string, number> = { intent: 20, blitz_fit: 30, agent_gap: 30, pain: 20 }

function matches(patterns: RegExp[], text: string): string[] {
  const hits: string[] = []
  for (const p of patterns) {
    const m = text.match(p)
    if (m) hits.push(m[0].slice(0, 80))
  }
  return hits
}

export interface ScoreResult {
  version: string
  score: number
  decision: 'lead' | 'review' | 'no'
  reasons: string[]
  rationale: string
  evidence: string[]
  provider: string
  model: string
  cost_usd: number
}

export function heuristicScore(text: string): ScoreResult {
  const noise = matches(NOISE, text)
  const positive = matches(POSITIVE_GUARDS, text)

  if (noise.length && !positive.length) {
    return {
      version: HEURISTIC_VERSION,
      score: 0,
      decision: 'no',
      reasons: ['noise'],
      rationale: `Caught by NOISE: ${noise[0]}`,
      evidence: noise.slice(0, 3),
      provider: 'heuristic',
      model: HEURISTIC_VERSION,
      cost_usd: 0,
    }
  }

  let points = 0
  const reasons: string[] = []
  const evidence: string[] = []
  for (const [group, patterns] of Object.entries(SIGNALS)) {
    const hits = matches(patterns, text)
    if (hits.length) {
      points += WEIGHTS[group] || 0
      reasons.push(group)
      evidence.push(...hits.slice(0, 2))
    }
  }

  // Constraint penalties — required combinations to reach upper score bands.
  if (!reasons.includes('blitz_fit')) points = Math.min(points, 25)
  if (!reasons.includes('intent')) points = Math.min(points, 40)
  if (!reasons.includes('agent_gap') && !reasons.includes('pain')) points = Math.min(points, 50)
  if (points > 70 && !(reasons.includes('blitz_fit') && (reasons.includes('agent_gap') || reasons.includes('pain')))) {
    points = 65
  }

  if (positive.length) {
    points = Math.max(points, THRESHOLD)
    reasons.push('positive_guard')
    evidence.push(...positive.slice(0, 2))
  }

  points = Math.max(0, Math.min(100, points))
  const decision: 'lead' | 'review' | 'no' =
    points >= THRESHOLD ? 'lead' : points >= REVIEW_THRESHOLD ? 'review' : 'no'

  return {
    version: HEURISTIC_VERSION,
    score: points,
    decision,
    reasons,
    rationale: reasons.length
      ? `Matched: ${reasons.join(', ')}. Score: ${points}.`
      : 'No signals matched.',
    evidence: evidence.slice(0, 6),
    provider: 'heuristic',
    model: HEURISTIC_VERSION,
    cost_usd: 0,
  }
}

// llmScore — uses OpenRouter (DeepSeek default). Returns null if no API key.
// The prompt is rendered from goal.ts so a forking agent never has to touch
// this function: just rewrite GOAL / TP_CONSTRAINTS / FP_SHAPES in goal.ts.
export async function llmScore(
  text: string,
  goal: { description: string; positives?: string[]; negatives?: string[] } | null,
  apiKey: string | null,
): Promise<ScoreResult | null> {
  if (!apiKey) return null
  const goalText = goal?.description || GOAL
  const positives = goal?.positives?.length ? goal.positives : TP_CONSTRAINTS
  const negatives = goal?.negatives?.length ? goal.negatives : FP_SHAPES

  const system = `You are a recall-oriented lead classifier. Score one social post against the goal below. Most posts will NOT be leads — be honest. Return strict JSON, no markdown.`

  const constraints = positives.map((c, i) => `${i + 1}. ${c}`).join('\n')
  const fpShapes = negatives.map((s) => `- ${s}`).join('\n')

  const user = `Goal:
${goalText}

A sample is a TRUE POSITIVE only when ALL of these hold:
${constraints}

Common false-positive shapes to reject:
${fpShapes}

Post:
${text.slice(0, 4000)}

Scale:
- 0-19 obvious non-lead / noise
- 20-34 weak adjacent chatter
- 35-54 review-worthy but missing >=1 required constraint
- 55-74 plausible lead with concrete fit
- 75-100 strong lead with clear deploy/backend/agent-native pain

Return JSON:
{
  "score": <int 0-100>,
  "decision": "lead" | "review" | "no",
  "rationale": "<one concise sentence>",
  "evidence": ["<short quoted phrase>", "..."],
  "matched_constraints": ["<keyword>"],
  "missing_constraints": ["..."]
}`

  const body = {
    model: 'deepseek/deepseek-chat',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    max_tokens: 800,
  }

  let payload: any
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://blitz.dev',
        'X-Title': 'lead-harness',
      },
      body: JSON.stringify(body),
    })
    if (!r.ok) return null
    payload = await r.json()
  } catch {
    return null
  }

  const content = payload?.choices?.[0]?.message?.content || '{}'
  let parsed: any
  try { parsed = JSON.parse(content) } catch { return null }

  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)))
  const decision: 'lead' | 'review' | 'no' =
    score >= THRESHOLD ? 'lead' : score >= REVIEW_THRESHOLD ? 'review' : 'no'

  return {
    version: LLM_VERSION,
    score,
    decision,
    reasons: ['llm', ...(Array.isArray(parsed.matched_constraints) ? parsed.matched_constraints.map(String) : [])],
    rationale: String(parsed.rationale || ''),
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 6).map(String) : [],
    provider: 'openrouter',
    model: 'deepseek/deepseek-chat',
    cost_usd: 0,
  }
}
