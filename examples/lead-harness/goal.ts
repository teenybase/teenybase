// goal.ts — THE FILE A FORKING AGENT EDITS FIRST.
//
// Everything here is "what counts as a lead for the user we're forked for."
// Everything in classify.ts is "how the loop runs" — leave it alone unless
// you're tuning weights / thresholds.
//
// When the agent forks this harness for a new product:
//   1. Rewrite GOAL (one paragraph — what's the product, who's the buyer)
//   2. Rewrite TP_CONSTRAINTS (the 5 things that must all be true)
//   3. Rewrite FP_SHAPES (the canonical false-positive patterns to reject)
//   4. Bump GOAL_VERSION (clean slate for the version column)
//   5. Run /score?llm=1 — measure with /eval?version=llm-<bump>
//
// The seed below is calibrated for blitz.dev — keep it as a reference, then
// replace.

export const GOAL_VERSION = 'blitz-v1'

export const GOAL = `Blitz.dev is an agent-native app hosting + backend platform on Cloudflare's edge: SQLite database, auth/JWT/OAuth, REST API auto-generated from a single TypeScript config, R2 file storage, admin UI, live preview URLs, scoped agent tokens. The buyer is a developer / founder / indie hacker / AI-agent builder who wants to ship a small web app, SaaS, MVP, dashboard, or bot dashboard without stitching Vercel+Supabase+S3+Auth0, and who wants their AI coding agent (Claude, Codex, Cursor, Lovable, Bolt, etc.) to drive the deploy/backend management directly. Strongest signals: scoped/revokable agent tokens, no-signup/no-credit-card, agent-driven CLI/API for backend ops, one platform replacing many.`

// TP_CONSTRAINTS — a sample is a true positive ONLY when all of these hold.
// Be specific. The LLM uses these verbatim in its prompt.
export const TP_CONSTRAINTS = [
  'Active or near-term build/deploy/ship intent for a web app, agent-built app, dashboard, MVP, SaaS, API, internal tool, or bot dashboard.',
  'Blitz-fit problem: needs deploy/host, backend, database, auth, file storage, REST API, full-stack-from-frontend, agent-driven deploy, preview URL, no-signup, scoped agent token, or one platform replacing Vercel+Supabase+S3+Auth0 stitching.',
  'Unresolved need / platform pain / agent-native workflow gap. The user is asking for recommendations, expressing friction, blocked by setup, or showing their current platform isn\'t agent-native enough.',
  'Reachable buyer/user: developer, founder, indie hacker, agency, AI-agent builder.',
  'NO hard disqualifier (Blitz.js, Blitz.gg, chess, jobs, tutorials, show-off posts, anecdotes, pure tool comparisons, agent orchestration meta-questions, "I\'m building a Vercel alternative", existing-platform support with no replacement intent, long-running processes / websockets-first / queues / cron / Durable Objects, native mobile-only apps).',
]

// FP_SHAPES — the canonical false-positive patterns to teach the LLM.
// These came directly from the v1 audit of 14 mis-flagged "leads". Every entry
// here corresponds to a real post that v1 got wrong.
export const FP_SHAPES = [
  '"I built X this weekend" / "Open-sourced Y" → show-off, not a lead',
  '"My full workflow for cursor" / "Step 1: ..." → tutorial, not a lead',
  '"Claude said \'my bad\' last night" / "X happened to me" → anecdote, not a lead',
  '"Cursor or Lovable? Which is best?" → tool comparison, weak lead at best',
  '"How do you organize agents in Cursor?" → meta-question, not a lead',
  '"I\'m building a Vercel/Railway alternative for AI agents" → competitor, not a lead',
  '".cursorrules going stale" / "memory layer for cursor" → Cursor tooling, not a lead',
]

// Heuristic patterns. The agent edits these when /eval errors reveal a
// repeated regex miss; the LLM is the safety net.
export const SIGNALS_INTENT = [
  /\b(?:i'?m|we'?re|i am|we are|i'?ve been|trying to|need to|want to|looking to|planning to)\s+(?:building|making|shipping|launching|prototyping|creating|deploying|hosting|publishing)\b/i,
  /\b(?:need to|want to|looking to|trying to|planning to|how do i|how can i|what'?s the)\s+(?:[a-z\s]{0,40}?)\b(?:deploy|host|launch|ship|publish|build|stand up|set up|provision)\b\s+(?:[a-z\s]{0,40}?)\b(?:web app|saas|mvp|backend|api|dashboard|side project|app)\b/i,
  /\b(?:recommend|alternative|which platform|best way|what'?s the easiest)\b(?:[a-z\s]{0,60})\b(?:deploy|host|backend|database|auth|api|full.?stack|web app|saas|mvp)\b/i,
]

export const SIGNALS_FIT = [
  /\bdeploy(?:ing|ed|ment)?\s+(?:my|our|an?|the)\s+(?:[a-z\s]{0,30}?)(?:app|site|dashboard|mvp|saas|frontend|backend|api)\b/i,
  /\b(?:host|hosting|publishing|launching)\s+(?:my|our|an?|the)\s+(?:[a-z\s]{0,30}?)(?:app|site|dashboard|mvp|saas|backend|api)\b/i,
  /\b(?:vercel|netlify|railway|render|fly\.io|fly io)\b[^.]*\b(?:supabase|firebase|neon|planetscale|auth0|clerk|s3|stripe)\b/i,
  /\b(?:supabase|firebase|neon|planetscale|auth0|clerk|s3)\b[^.]*\b(?:vercel|netlify|railway|render|fly\.io|fly io)\b/i,
  /\b(?:backend|database|db|sqlite|postgres|storage|file upload|rest api|crud|auth|oauth|login|jwt)\b[^.]{0,60}\b(?:deploy|host|launch|build|provision|set up|stand up|spin up|integrate|add)\b/i,
  /\b(?:deploy|host|launch|build|provision|set up|stand up|spin up|integrate|add)\b[^.]{0,60}\b(?:backend|database|db|sqlite|postgres|storage|file upload|rest api|crud|auth|oauth|login|jwt)\b/i,
  /\b(?:preview url|live preview|shareable preview|no signup|no credit card|scoped token|revokable token|agent token|temporary credential|without giving .* full|hand .* credentials)\b/i,
]

export const SIGNALS_AGENT_GAP = [
  /\b(?:agent|claude|codex|cursor|copilot|devin|cline|aider|lovable|bolt|replit|v0|windsurf)\b[^.]{0,80}\b(?:deploy|host|provision|manage|publish|launch|ship|set up|stand up|backend|auth|database|storage)\b/i,
  /\b(?:deploy|host|provision|manage|publish|launch|ship|set up|stand up|backend|auth|database|storage)\b[^.]{0,80}\b(?:agent|claude|codex|cursor|copilot|devin|cline|aider|lovable|bolt|replit|v0|windsurf)\b/i,
  /\bis there (?:a|an) (?:cli|api|sdk|endpoint|tool|service|platform)\b[^.]{0,80}\b(?:deploy|provision|backend|database|auth|storage|hosting|app)\b/i,
  /\b(?:without giving|hand(?:ing)?|share|sharing|give)\b[^.]{0,40}\b(?:full|whole|entire)\b[^.]{0,30}\b(?:cloud|account|credential|access)\b/i,
]

export const SIGNALS_PAIN = [
  /\b(?:stuck|blocked|failing|failed|broken|painful|annoying|frustrat\w+|too much setup|boilerplate|nightmare|hate)\b[^.]{0,80}\b(?:deploy|host|backend|database|auth|api|frontend|stack|setup|build)\b/i,
  /\b(?:deploy|host|backend|database|auth|api|frontend|stack|setup|build)\b[^.]{0,80}\b(?:stuck|blocked|failing|failed|broken|painful|annoying|frustrat\w+|too much setup|boilerplate|nightmare|hate)\b/i,
  /\b(?:multiple dashboards?|stitched together|cobble|too many tools|too much setup|annoying because)\b/i,
  /\b(?:replace|leave|switch from|migrate from|moving away from|alternative to|tired of)\b[^.]{0,40}\b(?:vercel|supabase|firebase|netlify|railway|render|cloudflare|auth0|aws)\b/i,
]

// NOISE — categories the v1 audit told us to filter aggressively.
// Each line traces back to a specific class of false positive.
export const NOISE = [
  /\b(?:hire|hiring|job|jobs|resume|internship|freelancer wanted|looking for work|open to work)\b/i,
  /\b(?:show hn|newsletter|podcast|course|tutorial|guide|blog post|youtube video|in case it helps|sharing because|sharing my)\b/i,
  /\b(?:my (?:full )?workflow|my (?:full )?process|my setup|my stack|how i (?:use|build|prompt|work)|step 1[:.]|lessons learned|what (?:i'?ve|i have) learned)\b/i,
  /\b(?:i (?:just )?built|we (?:just )?built|i (?:just )?made|we (?:just )?made|just launched|just shipped|built (?:this|a tool|an app|an extension)|open[-\s]sourced|open source(?:d|ing)?\s+(?:a|an|my))\b/i,
  /\b(?:this weekend|over the weekend|in a weekend|this morning)\b[^.]{0,80}\b(?:built|made|launched|shipped)\b/i,
  /\b(?:claude (?:actually )?said|gpt said|cursor said|the agent said|happened to me|got me thinking|story[:.]|funny (?:story|thing))\b/i,
  /\b(?:i'?m building|we'?re building|i (?:just )?built|we (?:just )?built|building a)\b[^.]{0,60}\b(?:vercel|railway|netlify|render|heroku|supabase|firebase)\b[^.]{0,30}\b(?:alternative|replacement|competitor|killer)\b/i,
  /\b(?:cloud (?:hosting )?platform|deploy platform|paas|baas|backend(?:-as-a-service)?)\b[^.]{0,80}\b(?:built for ai|for agents?|agent[-\s]native|managed by|run by)\b/i,
  /\b(?:blitz chess|blitz rating|blitz game|blitz\.gg|blitz\.js|blitzjs)\b/i,
  /\b(?:crypto|nft|dropshipping|affiliate|onlyfans|casino|betting)\b/i,
  /\b\.cursorrules\b|\bmemory layer\b|\bcontext window\b|\bbloating the (?:main )?prompt\b/i,
  /\b(?:organize|orchestrate|coordinate|manage|run)\s+(?:multiple |parallel |several )?agents?\b/i,
  /\b(?:gaslighting|hallucinat\w+|making (?:stuff|things) up|made up data)\b/i,
  /\bmigrating (?:from|to)\b[^.]{0,40}\b(?:vs ?code|copilot|cursor|jetbrains|intellij)\b/i,
]

// POSITIVE_GUARDS — strong signals that override NOISE.
// Reserved for the canonical "agent + concrete deploy/backend pain" combination.
export const POSITIVE_GUARDS = [
  /\b(?:agent|claude|codex|cursor|lovable|bolt|replit|v0)\b[^.]{0,80}\b(?:deploy|host|provision|backend|auth|database|storage)\b[^.]{0,200}\b(?:stuck|blocked|annoying|frustrat\w+|too much setup|how do i|how can i|can'?t|cannot|won'?t)\b/i,
  /\b(?:replace|alternative to|switch from|migrate from|tired of)\b[^.]{0,60}\b(?:vercel\s*\+\s*supabase|supabase\s*\+\s*vercel|vercel\s+and\s+supabase|firebase\s+functions|s3\s*\+\s*auth0)\b/i,
  /\beasiest way\b[^.]{0,40}\b(?:agent|codex|claude|cursor)\b[^.]{0,40}\b(?:deploy|backend|build)\b/i,
]
