// Internal bundle entry for the CF dashboard POC.
// Not listed in package.json `exports` — produced only via `npm run build:cf-ui-bundle`.
// Adds `generateMigrations` + `MigrationHelperRaw` to what `teenybase/worker` already exposes.
// (MigrationHelperRaw stays bundle-only; we don't want to promise it as public surface yet.)
export * from '../worker/index'
export {generateMigrations, nextUserIndex, USER_MIGRATION_START} from '../sql/schema/generateMigrations'
export {MigrationHelperRaw} from '../worker/migrationHelper'
export {$DatabaseRawImpl} from '../worker/$DatabaseRawImpl'
export {hasIdentitiesExtension} from '../types/config'
export {Hono} from 'hono'
// hono/html — string-tagged template engine for SSR in dynamic workers.
export {html, raw} from 'hono/html'
// hono/cookie — set/delete/get the teenybase auth cookie after login/logout.
export {setCookie, deleteCookie, getCookie} from 'hono/cookie'
export {version as TEENYBASE_VERSION} from '../../package.json'
