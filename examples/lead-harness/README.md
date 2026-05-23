# Lead-Harness

Self-improving lead classifier on [teenybase](../../README.md). Local scraper pushes samples; blitz holds the state, scoring, labels, and metrics. Forking agents edit `goal.ts` to retarget the harness at a new product / ICP.

> **Adopting this for a different product?** Read [`AGENTS.md`](./AGENTS.md) first — it's the onboarding doc for a forking agent.

## What it is

The same loop as the [discord-scraper](https://github.com/pythonlearner1025/discord-scraper) lead generator, but the JSONL files are replaced with a teenybase backend:

- **samples** — raw items scraped from Discord, Reddit, or anywhere else
- **scores** — per-version classifier output (heuristic and/or LLM)
- **labels** — human ground truth (`tp`, `fp`, `fn`, `tn`)
- **goals** — the user's ICP definition, fed to the LLM scorer

The scraper stays local (anything that needs auth, proxies, or long-running work). Everything else is on blitz: REST API, admin UI, eval action, public dashboard.

## Files

| File | Purpose |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | **Read first** if you're a forking agent — onboarding + iteration loop. |
| [`goal.ts`](./goal.ts) | **The per-fork edit surface.** ICP, TP constraints, FP shapes, regex signals. |
| [`classify.ts`](./classify.ts) | Loop machinery: `heuristicScore` + `llmScore`. Imports from `goal.ts`. |
| [`teenybase.ts`](./teenybase.ts) | 4-table schema. Writes gated through worker routes; reads public. |
| [`worker.ts`](./worker.ts) | Routes: `POST /ingest`, `POST /score`, `POST /label`, `GET /eval`, `GET /leads`, `GET /`. |
| [`scraper_client/push_samples.py`](./scraper_client/push_samples.py) | Reads Discord / Reddit JSON dumps, batches into `/ingest`, drains `/score`. |

## E2E (fork + run)

```bash
# 1. Fork an anon project (12h TTL until you claim)
curl -X POST "https://blitz.dev/api/v1/new-project/my-leads?template=empty"
# Save agent_link from the response — fetch it for the per-project agent token.

# 2. Set INGEST_TOKEN as a project secret (replace token & project name)
BASE="https://blitz.dev/api/v1/projects/my-leads"
TP="tp_..."   # from agent_link
curl -X PUT "$BASE/secrets/INGEST_TOKEN" \
  -H "Authorization: Bearer $TP" \
  -H "Content-Type: application/json" \
  -d '{"value":"replace-with-a-real-secret"}'

# 3. PUT the three files (teenybase.ts, classify.ts, worker.ts) to $BASE/files
#    then POST $BASE/commit to apply the migration.

# 4. Push samples and score them
export BLITZ_BASE="https://my-leads.app.blitz.dev"
export INGEST_TOKEN="replace-with-a-real-secret"
python3 scraper_client/push_samples.py path/to/discord_export.json path/to/reddit_dump.json
# → inserted=N scored=N

# 5. Watch the dashboard
open "https://my-leads.app.blitz.dev"
```

## Endpoints

Everything except `GET /`, `GET /eval`, `GET /leads`, and the auto-generated `/api/v1/...` reads is gated on `Authorization: Bearer $INGEST_TOKEN`.

| Endpoint | Use |
|---|---|
| `POST /ingest` | `{samples: [...]}` — idempotent on `external_id`. |
| `POST /score?full=1&llm=1` | Re-scores. `full=1` rescores everything; `llm=1` uses `OPENROUTER_API_KEY` if set. |
| `POST /label` | `{external_id|sample_id, label: 'tp'|'fp'|'fn'|'tn', notes?}` |
| `GET /eval` | Confusion matrix + precision / recall / specificity / F1 / AUC. |
| `GET /leads?decision=lead&limit=50` | Scored samples by decision bucket. |
| `GET /api/v1/pocket/` | Admin UI for label review (read-only by default; sign in as editor to label). |

## Tuning loop

1. Push samples.
2. Score (heuristic default; add `OPENROUTER_API_KEY` secret and `?llm=1` for LLM).
3. Label the obvious wins/misses in PocketUI or via `POST /label`.
4. `GET /eval` — look at the errors.
5. Edit `classify.ts` (add a SIGNALS pattern, tighten NOISE, change a weight, sharpen the LLM prompt).
6. Bump `HEURISTIC_VERSION` / `LLM_VERSION` for a clean slate. Re-score. Compare with `GET /eval?version=...` and `GET /leads?version=...`.

The only file that needs editing across iterations is `classify.ts`. Schema, REST, auth, admin UI are kernel — don't touch them.

## Measured on 233 samples (Discord testdata + r/microsaas + r/cursor)

Same 11 ground-truth labels (4 tp, 7 tn), three classifier versions:

| | heuristic-v1 | heuristic-v2 | **llm-v1** |
|---|---|---|---|
| precision | ~14% (audit-est) | 1.00 | **1.00** |
| recall | — | 0.25 | **0.75** |
| F1 | — | 0.40 | **0.857** |
| AUC | — | 0.89 | **1.00** |
| flagged `lead` | 14 (mostly false) | 1 | **3** |

Iteration story: v1 over-recalled because `\?` alone scored as `pain` and `frontend|backend|database` alone scored as `blitz_fit` → almost every r/cursor post triggered. v2 tightened patterns and added NOISE for show-off / tutorial / anecdote / competitor posts — precision went to 1.0 but recall collapsed to 0.25 because the regex couldn't recognize "is there a CLI for auth/storage/REST APIs from my agent" as the textbook Blitz ICP. LLM scoring (DeepSeek via OpenRouter, ~$0.0005/sample) caught everything heuristic-v2 missed and held precision at 1.0.

Cost note: the worker parallelizes LLM calls via `Promise.all` per `/score` batch (15 samples per call, ~30-60s wall clock). For 233 samples that's ~15 worker invocations.
