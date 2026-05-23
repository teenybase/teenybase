// Lead-Harness — self-improving lead classifier on teenybase.
//
// State the agent learns over: samples flow in from a local scraper or an
// agent-socket browser session; scoring runs in the worker via a routine
// the agent rewrites; humans label in PocketUI; eval pulls precision /
// recall / AUC from a labeled subset.
//
// The whole point of this schema is to be the kernel — auth, REST, RLS,
// migrations, admin UI all out of the box — so the agent spends its
// cognitive budget on `classify.ts`, not boilerplate.

import { sql, tableField, baseFields, createdTrigger, updatedTrigger } from 'teenybase'

// goals — the user's ICP. Single row in v1; one row per goal in vN.
// `description` is the prose the LLM scorer sees. `positives` / `negatives`
// are structured constraint hints.
const goals = {
  name: 'goals',
  autoSetUid: true,
  fields: [
    ...baseFields,
    tableField('name', 'text', 'text', { notNull: true }),
    tableField('description', 'text', 'text', { notNull: true }),
    tableField('positives', 'json', 'json', {}),
    tableField('negatives', 'json', 'json', {}),
    tableField('classifier_version', 'text', 'text', { default: sql`'heuristic-v1'` }),
  ],
  extensions: [
    { name: 'rules', listRule: 'true', viewRule: 'true', createRule: null, updateRule: null, deleteRule: null },
  ],
  triggers: [createdTrigger, updatedTrigger],
}

// samples — raw items the scraper pushes. external_id is the source-native
// ID (reddit post id, discord msg id) so re-ingest is idempotent.
const samples = {
  name: 'samples',
  autoSetUid: true,
  fields: [
    ...baseFields,
    tableField('external_id', 'text', 'text', { notNull: true, unique: true }),
    tableField('source', 'text', 'text', { notNull: true }),
    tableField('channel', 'text', 'text', {}),
    tableField('author', 'text', 'text', {}),
    tableField('permalink', 'text', 'text', {}),
    tableField('title', 'text', 'text', {}),
    tableField('body', 'text', 'text', {}),
    tableField('combined', 'text', 'text', { notNull: true }),
    tableField('links', 'json', 'json', {}),
    tableField('meta', 'json', 'json', {}),
    tableField('source_ts', 'text', 'text', {}),
  ],
  indexes: [{ fields: ['source'] }, { fields: ['external_id'] }, { fields: ['channel'] }],
  extensions: [
    { name: 'rules', listRule: 'true', viewRule: 'true', createRule: null, updateRule: null, deleteRule: null },
  ],
  triggers: [createdTrigger, updatedTrigger],
}

// scores — one row per (sample, version). Re-scoring with a new version
// keeps old scores intact so you can A/B classifier diffs over time.
const scores = {
  name: 'scores',
  autoSetUid: true,
  fields: [
    ...baseFields,
    tableField('sample_id', 'relation', 'text', { notNull: true, foreignKey: { table: 'samples', column: 'id', onDelete: 'CASCADE' } }),
    tableField('version', 'text', 'text', { notNull: true }),
    tableField('score', 'integer', 'integer', { notNull: true, default: sql`0` }),
    tableField('decision', 'text', 'text', { notNull: true, default: sql`'no'` }),
    tableField('reasons', 'json', 'json', {}),
    tableField('rationale', 'text', 'text', {}),
    tableField('evidence', 'json', 'json', {}),
    tableField('provider', 'text', 'text', {}),
    tableField('model', 'text', 'text', {}),
    tableField('cost_usd', 'number', 'real', { default: sql`0` }),
  ],
  indexes: [
    { fields: ['sample_id', 'version'], unique: true },
    { fields: ['score'] },
    { fields: ['decision'] },
  ],
  extensions: [
    { name: 'rules', listRule: 'true', viewRule: 'true', createRule: null, updateRule: null, deleteRule: null },
  ],
  triggers: [createdTrigger, updatedTrigger],
}

// labels — human ground truth. tp/fn = real leads, fp/tn = not.
// One label per sample; updates flip the label.
const labels = {
  name: 'labels',
  autoSetUid: true,
  fields: [
    ...baseFields,
    tableField('sample_id', 'relation', 'text', { notNull: true, unique: true, foreignKey: { table: 'samples', column: 'id', onDelete: 'CASCADE' } }),
    tableField('label', 'text', 'text', { notNull: true }),
    tableField('notes', 'text', 'text', {}),
    tableField('labeler', 'text', 'text', {}),
  ],
  extensions: [
    { name: 'rules', listRule: 'true', viewRule: 'true', createRule: null, updateRule: null, deleteRule: null },
  ],
  triggers: [createdTrigger, updatedTrigger],
}

export default {
  appName: 'Lead-Harness',
  appUrl: 'https://your-slug.app.blitz.dev',
  jwtSecret: '$JWT_SECRET_MAIN',
  tables: [goals, samples, scores, labels],
}
