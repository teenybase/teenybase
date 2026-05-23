// Lead-Harness worker — ingest, score, label, eval, leads, live dashboard.
//
// The kernel (auth, REST, RLS, admin UI) is supplied by teenyHono. The only
// project-specific routes are:
//   POST /ingest   — scraper pushes raw samples
//   POST /score    — re-scores unscored samples (or all, with ?full=1)
//   POST /label    — apply tp/fp/fn/tn ground truth
//   GET  /eval     — precision / recall / AUC + confusion matrix
//   GET  /leads    — top-scored samples
//   GET  /         — public live dashboard
//
// Ingest/score/label require `Authorization: Bearer $INGEST_TOKEN` (project secret).
// Eval/leads/dashboard are public so anyone can see the harness working.

import { $Database, teenyHono, OpenApiExtension, PocketUIExtension, Hono, html, raw } from 'teenybase'
import config from 'virtual:teenybase'
import { heuristicScore, llmScore, classifierVersion, HEURISTIC_VERSION, LLM_VERSION } from './classify.ts'

const app = new Hono()

function unauthorized(c: any) {
  return c.json({ error: 'unauthorized — set Authorization: Bearer $INGEST_TOKEN' }, 401)
}

function authed(c: any): boolean {
  const expected = c.env.INGEST_TOKEN
  if (!expected) return false
  const header = c.req.header('authorization') || ''
  const token = header.replace(/^Bearer\s+/i, '').trim()
  return !!token && token === expected
}

function combinedText(s: any): string {
  const parts = [s.title, s.body].filter(Boolean).map((x: string) => String(x).trim())
  return parts.join('\n\n').slice(0, 12000)
}

// ===== Ingest ================================================================

app.post('/ingest', async (c: any) => {
  if (!authed(c)) return unauthorized(c)
  const body = await c.req.json().catch(() => null)
  if (!body || !Array.isArray(body.samples)) {
    return c.json({ error: 'body must be {"samples": [...]}' }, 400)
  }
  const db = c.get('$db' as any) as any
  let inserted = 0
  let skipped = 0
  const errors: any[] = []
  for (const s of body.samples) {
    const externalId = String(s.external_id || s.id || '').trim()
    if (!externalId) { errors.push({ reason: 'missing external_id' }); continue }
    const combined = combinedText(s)
    if (!combined) { errors.push({ external_id: externalId, reason: 'empty text' }); continue }
    try {
      // INSERT OR IGNORE is one subrequest per row; rows changed reports actual insert vs duplicate.
      const r: any = await db.rawSQL({
        q: `INSERT OR IGNORE INTO samples
            (id, external_id, source, channel, author, permalink, title, body, combined, links, meta, source_ts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        v: [
          crypto.randomUUID(),
          externalId,
          String(s.source || 'unknown'),
          String(s.channel || ''),
          String(s.author || ''),
          String(s.permalink || ''),
          String(s.title || ''),
          String(s.body || ''),
          combined,
          JSON.stringify(s.links || []),
          JSON.stringify(s.meta || {}),
          String(s.source_ts || s.timestamp || ''),
        ],
      }).run()
      const changed = Number((r && (r.meta?.changes ?? r.changes ?? r.rowsAffected)) ?? 0)
      if (changed) inserted++
      else skipped++
    } catch (e: any) {
      errors.push({ external_id: externalId, reason: String(e?.message || e) })
    }
  }
  return c.json({ inserted, skipped, errors: errors.slice(0, 20), total_errors: errors.length })
})

// ===== Score =================================================================

app.post('/score', async (c: any) => {
  if (!authed(c)) return unauthorized(c)
  const url = new URL(c.req.url)
  const full = url.searchParams.get('full') === '1'
  // Cap at 45 to stay under Workers' 50 subrequest free-tier limit (1 upsert per sample).
  // LLM mode does an additional fetch per sample → keep that even tighter to leave
  // budget for the OpenRouter round-trip.
  const useLlm = url.searchParams.get('llm') === '1'
  const limit = Math.max(1, Math.min(useLlm ? 20 : 45, parseInt(url.searchParams.get('limit') || (useLlm ? '15' : '40'))))
  const targetVersion = useLlm ? LLM_VERSION : HEURISTIC_VERSION

  const db = c.get('$db' as any) as any
  const goalRows: any[] = await db.rawSQL({ q: `SELECT * FROM goals ORDER BY created ASC LIMIT 1`, v: [] }).run() ?? []
  const goal = goalRows[0] || null
  const apiKey = useLlm ? (c.env.OPENROUTER_API_KEY || null) : null

  const rows: any[] = full
    ? await db.rawSQL({
        q: `SELECT s.* FROM samples s ORDER BY s.created DESC LIMIT ?`,
        v: [limit],
      }).run() ?? []
    : await db.rawSQL({
        q: `SELECT s.* FROM samples s
            WHERE NOT EXISTS (SELECT 1 FROM scores sc WHERE sc.sample_id = s.id AND sc.version = ?)
            ORDER BY s.created DESC LIMIT ?`,
        v: [targetVersion, limit],
      }).run() ?? []

  // Compute results first (parallelize LLM calls when applicable, sequential heuristic),
  // then upsert sequentially to stay under the subrequest limit.
  const goalRef = goal
    ? { description: String(goal.description || ''), positives: safeJson(goal.positives) || [], negatives: safeJson(goal.negatives) || [] }
    : null
  const computed = await Promise.all(rows.map(async (r: any) => {
    let result = heuristicScore(r.combined || '')
    if (useLlm && apiKey) {
      const llm = await llmScore(r.combined || '', goalRef, apiKey)
      if (llm) result = llm
    }
    return { r, result }
  }))

  let scored = 0
  for (const { r, result } of computed) {
    await db.rawSQL({
      q: `INSERT INTO scores (id, sample_id, version, score, decision, reasons, rationale, evidence, provider, model, cost_usd)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(sample_id, version) DO UPDATE SET
            score=excluded.score, decision=excluded.decision, reasons=excluded.reasons,
            rationale=excluded.rationale, evidence=excluded.evidence,
            provider=excluded.provider, model=excluded.model,
            cost_usd=excluded.cost_usd, updated=CURRENT_TIMESTAMP`,
      v: [crypto.randomUUID(), r.id, result.version, result.score, result.decision, JSON.stringify(result.reasons), result.rationale, JSON.stringify(result.evidence), result.provider, result.model, result.cost_usd],
    }).run()
    scored++
  }
  return c.json({ scored, version: targetVersion, llm: useLlm && !!apiKey })
})

// ===== Label =================================================================

app.post('/label', async (c: any) => {
  if (!authed(c)) return unauthorized(c)
  const body = await c.req.json().catch(() => null)
  if (!body) return c.json({ error: 'body required' }, 400)
  const externalId = String(body.external_id || '').trim()
  const sampleId = String(body.sample_id || '').trim()
  const label = String(body.label || '').toLowerCase()
  if (!['tp', 'fp', 'fn', 'tn'].includes(label)) {
    return c.json({ error: 'label must be tp|fp|fn|tn' }, 400)
  }
  const db = c.get('$db' as any) as any
  let target: any = null
  if (sampleId) {
    const r: any[] = await db.rawSQL({ q: `SELECT id FROM samples WHERE id = ? LIMIT 1`, v: [sampleId] }).run() ?? []
    target = r[0]
  } else if (externalId) {
    const r: any[] = await db.rawSQL({ q: `SELECT id FROM samples WHERE external_id = ? LIMIT 1`, v: [externalId] }).run() ?? []
    target = r[0]
  }
  if (!target) return c.json({ error: 'sample not found' }, 404)

  await db.rawSQL({
    q: `INSERT INTO labels (id, sample_id, label, notes, labeler) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(sample_id) DO UPDATE SET
          label = excluded.label, notes = excluded.notes, labeler = excluded.labeler,
          updated = CURRENT_TIMESTAMP`,
    v: [crypto.randomUUID(), target.id, label, String(body.notes || ''), String(body.labeler || 'cli')],
  }).run()
  return c.json({ ok: true, sample_id: target.id, label })
})

// ===== Eval ==================================================================

app.get('/eval', async (c: any) => {
  const url = new URL(c.req.url)
  const version = url.searchParams.get('version') || classifierVersion
  const db = c.get('$db' as any) as any
  const rows: any[] = await db.rawSQL({
    q: `SELECT l.sample_id, l.label, s.score, s.decision, sa.title, sa.permalink, sa.channel, sa.source
        FROM labels l
        JOIN samples sa ON sa.id = l.sample_id
        LEFT JOIN scores s ON s.sample_id = l.sample_id AND s.version = ?
        ORDER BY s.score DESC`,
    v: [version],
  }).run() ?? []

  let tp = 0, fp = 0, fn = 0, tn = 0
  const points: [number, boolean][] = []
  const errors: any[] = []
  for (const r of rows) {
    const actual = r.label === 'tp' || r.label === 'fn'
    const predicted = r.decision === 'lead'
    if (r.score != null) points.push([Number(r.score), actual])
    if (actual && predicted) tp++
    else if (actual && !predicted) fn++
    else if (!actual && predicted) fp++
    else tn++
    if (actual !== predicted) {
      errors.push({
        sample_id: r.sample_id,
        label: r.label,
        score: r.score,
        decision: r.decision,
        channel: r.channel,
        source: r.source,
        title: r.title,
        permalink: r.permalink,
      })
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const recall = tp + fn > 0 ? tp / (tp + fn) : null
  const specificity = tn + fp > 0 ? tn / (tn + fp) : null
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null
  const auc = aucRoc(points)

  return c.json({
    version,
    labeled: rows.length,
    confusion: { tp, fp, fn, tn },
    metrics: { precision, recall, specificity, f1, auc },
    errors: errors.slice(0, 25),
  })
})

// ===== Leads + dashboard =====================================================

app.get('/leads', async (c: any) => {
  const url = new URL(c.req.url)
  const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50')))
  const decision = url.searchParams.get('decision') || 'lead'
  const version = url.searchParams.get('version') || classifierVersion
  const db = c.get('$db' as any) as any
  const rows: any[] = await db.rawSQL({
    q: `SELECT sa.*, s.score, s.decision, s.rationale, s.evidence, s.reasons, l.label
        FROM samples sa
        LEFT JOIN scores s ON s.sample_id = sa.id AND s.version = ?
        LEFT JOIN labels l ON l.sample_id = sa.id
        WHERE s.decision = ?
        ORDER BY s.score DESC LIMIT ?`,
    v: [version, decision, limit],
  }).run() ?? []
  return c.json({
    version,
    decision,
    count: rows.length,
    leads: rows.map((r) => ({
      ...r,
      links: safeJson(r.links),
      meta: safeJson(r.meta),
      reasons: safeJson(r.reasons),
      evidence: safeJson(r.evidence),
    })),
  })
})

app.get('/', async (c: any) => {
  const db = c.get('$db' as any) as any
  const [counts]: any[] = await db.rawSQL({
    q: `SELECT
      (SELECT COUNT(*) FROM samples) AS samples_total,
      (SELECT COUNT(*) FROM scores WHERE version = ?) AS scored_total,
      (SELECT COUNT(*) FROM scores WHERE version = ? AND decision = 'lead') AS leads_total,
      (SELECT COUNT(*) FROM scores WHERE version = ? AND decision = 'review') AS review_total,
      (SELECT COUNT(*) FROM labels) AS labels_total`,
    v: [classifierVersion, classifierVersion, classifierVersion],
  }).run() ?? [{}]
  const recent: any[] = await db.rawSQL({
    q: `SELECT sa.title, sa.channel, sa.permalink, sa.author, s.score, s.decision, s.rationale
        FROM samples sa
        JOIN scores s ON s.sample_id = sa.id AND s.version = ?
        WHERE s.decision = 'lead'
        ORDER BY s.score DESC LIMIT 10`,
    v: [classifierVersion],
  }).run() ?? []

  const goalRows: any[] = await db.rawSQL({ q: `SELECT name, description FROM goals ORDER BY created ASC LIMIT 1`, v: [] }).run() ?? []
  const goal = goalRows[0]

  return c.html(html`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Lead-Harness — live dashboard</title>
<style>
:root { --bg:#09090b; --card:#121214; --border:#27272a; --fg:#fafafa; --muted:#a1a1aa; --accent:#c084fc; --good:#22c55e; }
* { box-sizing:border-box }
body { margin:0; background:var(--bg); color:var(--fg); font-family:ui-sans-serif,system-ui,sans-serif; line-height:1.5 }
.wrap { max-width:980px; margin:0 auto; padding:48px 24px }
h1 { font-size:34px; letter-spacing:-.02em; margin:0 0 8px }
.sub { color:var(--muted); margin:0 0 32px }
.grid { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-bottom:32px }
.stat { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px }
.stat .n { font-size:28px; font-weight:600; letter-spacing:-.02em }
.stat .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; margin-top:4px }
.goal { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:24px }
.goal h3 { margin:0 0 6px; font-size:14px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em }
.goal p { margin:0; white-space:pre-wrap; font-size:14px }
table { width:100%; border-collapse:collapse; background:var(--card); border:1px solid var(--border); border-radius:8px; overflow:hidden }
th, td { padding:12px 14px; text-align:left; border-bottom:1px solid var(--border); font-size:14px; vertical-align:top }
th { background:#1a1a1d; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; font-weight:600 }
tr:last-child td { border-bottom:none }
.score { font-variant-numeric:tabular-nums; font-weight:600; color:var(--accent) }
a { color:var(--fg) }
a:hover { color:var(--accent) }
.muted { color:var(--muted) }
.footer { margin-top:32px; color:var(--muted); font-size:13px }
.footer code { background:#1a1a1d; padding:2px 6px; border-radius:4px; font-size:12px }
</style>
</head><body>
<div class="wrap">
  <h1>Lead-Harness</h1>
  <p class="sub">Self-improving lead classifier running on blitz. State, scoring, and labels live in this project's database; the loop improves as labels accumulate.</p>

  <div class="grid">
    <div class="stat"><div class="n">${counts?.samples_total ?? 0}</div><div class="l">samples</div></div>
    <div class="stat"><div class="n">${counts?.scored_total ?? 0}</div><div class="l">scored</div></div>
    <div class="stat"><div class="n" style="color:var(--good)">${counts?.leads_total ?? 0}</div><div class="l">leads</div></div>
    <div class="stat"><div class="n">${counts?.review_total ?? 0}</div><div class="l">review</div></div>
    <div class="stat"><div class="n">${counts?.labels_total ?? 0}</div><div class="l">labels</div></div>
  </div>

  ${goal ? html`<div class="goal">
    <h3>Goal · ${goal.name}</h3>
    <p>${goal.description}</p>
  </div>` : null}

  <h2 style="font-size:18px; margin:0 0 12px">Top leads</h2>
  ${recent.length === 0 ? html`<div class="muted">No leads yet. Push samples via POST /ingest, then POST /score.</div>` : html`<table>
    <thead><tr><th>Score</th><th>Channel</th><th>Title</th><th>Why</th></tr></thead>
    <tbody>
      ${recent.map((r) => html`<tr>
        <td><span class="score">${r.score}</span></td>
        <td class="muted">${r.channel || '—'}</td>
        <td>${r.permalink ? html`<a href="${r.permalink}" target="_blank">${r.title || '(no title)'}</a>` : (r.title || '(no title)')}</td>
        <td class="muted">${r.rationale || ''}</td>
      </tr>`)}
    </tbody>
  </table>`}

  <div class="footer">
    Endpoints: <code>POST /ingest</code> · <code>POST /score</code> · <code>POST /label</code> · <code>GET /eval</code> · <code>GET /leads</code> · <a href="/api/v1/pocket/">admin UI</a> · <a href="/api/v1/doc/ui">OpenAPI</a>
  </div>
</div>
</body></html>`)
})

// ===== Helpers ===============================================================

function safeJson(v: any) {
  if (v == null) return null
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return null }
}

// Approximate ROC AUC by averaging over all positive-negative pairs.
// O(n²) but n is the labeled subset, which stays small.
function aucRoc(points: [number, boolean][]): number | null {
  const pos = points.filter(([, y]) => y).map(([s]) => s)
  const neg = points.filter(([, y]) => !y).map(([s]) => s)
  if (!pos.length || !neg.length) return null
  let wins = 0
  for (const p of pos) for (const n of neg) {
    if (p > n) wins += 1
    else if (p === n) wins += 0.5
  }
  return wins / (pos.length * neg.length)
}

// ===== Bootstrap =============================================================

const root = teenyHono(async (c: any) => {
  const db = new $Database(c, config, c.env.TEENY_PRIMARY_DB, c.env.TEENY_PRIMARY_R2)
  await db.registerExtension(new OpenApiExtension(db, true))
  await db.registerExtension(new PocketUIExtension(db))
  return db
})

root.route('/', app)

export default root
