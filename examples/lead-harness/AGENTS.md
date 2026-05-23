# AGENTS.md — adopting lead-harness for the user's product

> Read order for a forking agent: **this file**, then [`goal.ts`](./goal.ts), then [`README.md`](./README.md). Skip the kernel files unless you're debugging.

## What this harness does

`observe → score → label → eval → improve` loop, with state on blitz. The user gives you a goal (their product / ICP); samples flow in from a local scraper (Reddit, Discord, anywhere you can produce JSON); a classifier scores each sample 0-100 against the goal; humans label the obvious wins and misses in the admin UI; precision / recall / AUC / confusion-matrix are computed server-side; the agent rewrites the classifier prompt + heuristics based on the labeled errors. Two scoring versions stay side-by-side in the DB so you can compare before/after on the same labels.

## Mental model: kernel vs playground vs data

| Layer | File | Touch? | Why |
|---|---|---|---|
| **Kernel** | `teenybase.ts` | Almost never | Schema is `goals / samples / scores / labels`. Adding columns is fine; renaming or splitting tables breaks the loop. |
| **Kernel** | `worker.ts` | Almost never | Routes for ingest / score / label / eval / leads / dashboard. Already wired to subrequest limits and batch sizes. |
| **Kernel** | `scraper_client/push_samples.py` | Replace per source | Pushes JSON dumps to `/ingest`. If you're scraping somewhere new, write a sibling script — same payload shape. |
| **Playground** | `classify.ts` | Rarely | Score weights, thresholds, how heuristic and LLM combine. Mostly leave alone. |
| **Playground** | `goal.ts` | **Edit first** | The user's ICP, the 5 TP constraints, the FP shapes, the regex signals/noise. **Everything you change per-fork lives here.** |
| **Data** | D1 tables | Through the API only | Don't write SQL directly; use `/ingest` `/score` `/label` `/eval` `/leads`. |

If a customization feels like it needs to touch `worker.ts`, stop and reconsider — it usually means goal.ts isn't expressive enough yet. Sharpen `goal.ts` first.

## Two-minute customization for a new goal

1. **Open `goal.ts`.** Rewrite four constants:
   - `GOAL` — one paragraph: what's the product, who's the buyer, what are the strongest signals.
   - `TP_CONSTRAINTS` — the ~5 things that must ALL hold for a sample to be a true positive. Be specific. The LLM uses these verbatim.
   - `FP_SHAPES` — the canonical false-positive shapes. Seed it with the obvious ones now; refine after the first audit.
   - `SIGNALS_*` + `NOISE` + `POSITIVE_GUARDS` — domain-specific regex patterns. Optional at first; the LLM does the heavy lifting.
2. **Bump `GOAL_VERSION`** (e.g. `'jobs-v1'`, `'saas-comp-v1'`). This auto-prefixes `heuristic-${VERSION}` and `llm-${VERSION}` in the scores table so old scores stay intact for comparison.
3. Fork a project: `POST https://blitz.dev/api/v1/new-project/<slug>?template=lead-harness`. Save the agent_link.
4. PUT the four files to `$BASE/files`: `teenybase.ts`, `worker.ts`, `goal.ts`, `classify.ts`. POST `$BASE/commit` to migrate.
5. Set `INGEST_TOKEN` and `OPENROUTER_API_KEY` via `$BASE/secrets`. The token gates write routes; the key enables LLM scoring.
6. Push samples via `scraper_client/push_samples.py` (or write a sibling for a new source).
7. **Look at the first 10-20 leads.** Compare to `TP_CONSTRAINTS` — anything that should NOT be a lead goes into `FP_SHAPES`. Re-deploy `goal.ts`, re-score (`POST /score?llm=1`), iterate.

## The iteration loop in detail

This is the loop that produces measurable quality. Follow it literally on the first 3-5 cycles before improvising.

1. **Push samples.** Heuristic auto-scores them inline (`/score` with no flags).
2. **Look at the top-10 `decision=lead`** with `GET /leads?decision=lead&limit=10`. Read the *actual text*, not just the score.
3. **For each one, check it against `TP_CONSTRAINTS`.** Be ruthless. If even one constraint fails, label it `tn` (or `fp`) via `POST /label`. Don't just label the most extreme outliers.
4. **Look at the top-10 `decision=no`** that mention any of the strongest signals from `GOAL`. Anything that *should* have been a lead → label `fn`.
5. **`GET /eval?version=<your-version>`** — get precision / recall / AUC. The `errors` array is your homework list.
6. **Diagnose the errors.** FPs cluster into shapes (show-off / tutorial / anecdote / competitor / meta-question). Add the shape to `FP_SHAPES` or `NOISE`. FNs reveal missing positive signals — sharpen `GOAL` or add a `POSITIVE_GUARDS` pattern.
7. **Re-deploy `goal.ts`** (no version bump unless the change is structural). Re-score with `POST /score?llm=1`. Repeat from step 2.
8. **Bump `GOAL_VERSION`** when you make a change you want to A/B against the previous version. Both sets of scores stay in the table; compare via `/eval?version=...` on either.

## What "good" looks like

Measured on 233 r/cursor + r/microsaas + synthetic samples with 11 labels (4 tp, 7 tn). Same labels across three classifier versions:

| | v1 heuristic | v2 heuristic | **llm-v1** |
|---|---|---|---|
| precision | ~14% (audit-est) | 1.00 | **1.00** |
| recall | — | 0.25 | **0.75** |
| F1 | — | 0.40 | **0.857** |
| AUC | — | 0.89 | **1.00** |

v1 was a naive heuristic. v2 was the same heuristic with FP_SHAPES tightening from the audit. llm-v1 added DeepSeek with the goal + constraints + FP shapes in the prompt. **Most of the precision came from FP_SHAPES; most of the recall came from the LLM understanding implicit intent the regex couldn't see.** Plan for both.

## When the loop is "done"

Honest answer: never. The harness is meant to keep running. Stop iterating when:
- Precision is where the user wants it (cost of a wrong outreach × FP rate is acceptable).
- Recall is where the user wants it (cost of a missed lead × FN rate is acceptable).
- The marginal label is no longer changing the metrics. (You've reached the goal definition's own ceiling — sharpen `GOAL` itself if you want to push further.)

At that point: tell the user, and shift to the next stage (outreach / chase / measure-replies).

## Common pitfalls

- **Don't label without auditing.** Labeling samples you haven't read produces wrong ground truth, which produces wrong improvements. The author of v1 of this harness labeled the top-1 "lead" as `tp` without reading it; it was actually a tool-comparison post. Two re-labels later, the metrics matched reality.
- **Don't bump `GOAL_VERSION` on every save.** Bump only when you want a clean A/B. Otherwise the labels float between versions and your eval gets confusing.
- **Don't write to the DB directly.** Use the API. The schema may evolve.
- **Watch Workers' 50-subrequest cap.** The score route caps at 15 per call when LLM is on, 45 otherwise. Drain via a loop in your scraper client, not by raising the cap.
- **LLM falling back to heuristic is silent.** If `OPENROUTER_API_KEY` is missing or wrong, `llmScore` returns null and the worker writes a heuristic-versioned score instead. Check `/eval?version=llm-...` returns a positive `labeled` count; if 0, the LLM never ran.

## Going to production

The free-tier anon project is a 12h demo. To keep state past that:

1. The user opens `https://blitz.dev/claim/<slug>` and signs in.
2. The project's secrets and data persist; the URL stays the same.
3. For 24/7 unattended runs, scoring still needs to be triggered. Today that's an external cron (GitHub Actions, cron-job.org, a Cloudflare Worker Cron Trigger on a separate account). A native blitz scheduled-action surface is on the roadmap; until then, the recipe in [`docs/recipes.md#scheduled-cleanup-via-external-cron`](../../docs/recipes.md#scheduled-cleanup-via-external-cron) is the supported pattern.
4. Heavier work (long-running scrapers, headless-browser outreach, queue processing) doesn't fit inside Workers — run that on a tiny VPS or a Cloudflare Container and have it POST to the same `/ingest` endpoint.

## Files

| Path | Purpose |
|---|---|
| `AGENTS.md` (this file) | Onboarding for a forking agent |
| `goal.ts` | **Edit first.** ICP, constraints, FP shapes, regex patterns |
| `classify.ts` | Loop machinery (heuristic + LLM); imports from goal.ts |
| `teenybase.ts` | Schema kernel |
| `worker.ts` | Routes kernel |
| `README.md` | User-facing quickstart and measured results |
| `scraper_client/push_samples.py` | Reads JSON dumps, batches to `/ingest`, drains `/score` |
