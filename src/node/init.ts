import fs from 'node:fs'
import path from 'node:path'
import {execSync} from 'node:child_process'
import colors from 'picocolors'
import {ask} from './prompts'
import {getErrorMessage} from './utils'
import {DEFAULT_CONFIG_FILES, DEFAULT_WRANGLER_CONFIG_FILES} from './constants'
import {readTeenybasePackageVersion} from './utils/package-root'
import {modify as jsoncModify, applyEdits as jsoncApplyEdits} from 'jsonc-parser'

// ─── Project State Detection ─────────────────────────────────────────────────

interface ProjectState {
    hasPackageJson: boolean
    hasWranglerConfig: boolean
    hasTeenyConfig: boolean
    hasTsconfig: boolean
    hasWorkerEntry: boolean
    hasWorkerConfigDts: boolean
    hasDevVars: boolean
    hasGitignore: boolean
    hasMigrationsDir: boolean
    hasClaudeSettings: boolean
    packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun'
    projectName: string
}

function detectProjectState(root: string): ProjectState {
    const exists = (f: string) => fs.existsSync(path.join(root, f))

    const hasPackageJson = exists('package.json')
    const hasWranglerConfig = DEFAULT_WRANGLER_CONFIG_FILES.some(f => exists(f))
    const hasTeenyConfig = DEFAULT_CONFIG_FILES.some(f => exists(f))
    const hasTsconfig = exists('tsconfig.json')
    const hasWorkerEntry = exists('src/index.ts') || exists('src/worker.ts')
    const hasWorkerConfigDts = exists('worker-configuration.d.ts')
    const hasDevVars = exists('.dev.vars')
    const hasGitignore = exists('.gitignore')
    const hasMigrationsDir = exists('migrations')
    const hasClaudeSettings = exists('.claude/settings.json')
    const packageManager = detectPackageManager(root)

    let projectName = path.basename(root)
    if (hasPackageJson) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
            if (pkg.name) projectName = pkg.name
        } catch {
            // ignore parse errors
        }
    }

    return {
        hasPackageJson,
        hasWranglerConfig,
        hasTeenyConfig,
        hasTsconfig,
        hasWorkerEntry,
        hasWorkerConfigDts,
        hasDevVars,
        hasGitignore,
        hasMigrationsDir,
        hasClaudeSettings,
        packageManager,
        projectName,
    }
}

function detectPackageManager(root: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
    const exists = (f: string) => fs.existsSync(path.join(root, f))
    if (exists('bun.lockb') || exists('bun.lock')) return 'bun'
    if (exists('pnpm-lock.yaml')) return 'pnpm'
    if (exists('yarn.lock')) return 'yarn'
    return 'npm'
}

// ─── Template Generators ─────────────────────────────────────────────────────

function generatePackageJson(name: string): string {
    const pkg = {
        name,
        type: 'module',
        scripts: {
            dev: 'teeny dev --local',
            generate: 'teeny generate --local',
            migrate: 'teeny deploy --local',
            deploy: 'teeny deploy --remote',
            'secrets-upload': 'teeny secrets --remote --upload',
            'cf-typegen': 'wrangler types --env-interface CloudflareBindings',
        },
        dependencies: {
            // Exact version of the CLI that generated the project, so a later teenybase
            // release doesn't change what an existing scaffold installs.
            teenybase: readTeenybasePackageVersion(),
            hono: '^4',
        },
        devDependencies: {
            // wrangler 4.x (latest) declares a peer dependency on workers-types ^5
            '@cloudflare/workers-types': '^5',
            typescript: '^5',
            wrangler: '^4',
        },
    }
    return JSON.stringify(pkg, null, 2) + '\n'
}

function generateWranglerJsonc(name: string): string {
    const today = new Date().toISOString().slice(0, 10)
    return `{
    // Use 'npx teenybase' commands instead of 'npx wrangler' — teenybase wraps wrangler with auto-resource creation and auth.
    "$schema": "node_modules/wrangler/config-schema.json",
    "name": ${JSON.stringify(name)},
    "main": "src/index.ts",
    "compatibility_date": "${today}",
    "compatibility_flags": ["nodejs_compat"],
    "observability": {
        "enabled": true,
        "logs": {
            "invocation_logs": true,
            "head_sampling_rate": 1
        }
    },
    // Keep "false" in production: "true" adds internal error details to API responses.
    // For local debugging, set RESPOND_WITH_ERRORS=true in .dev.vars instead (local dev only).
    "vars": { "RESPOND_WITH_ERRORS": "false" },
    "d1_databases": [
        {
            "binding": "PRIMARY_DB",
            "database_name": ${JSON.stringify(name + '-db')},
            "database_id": "TEENY_AUTO_CREATE",
            "migrations_dir": "migrations"
        }
    ]
}
`
}

function generateTsconfig(): string {
    const config = {
        compilerOptions: {
            target: 'ESNext',
            module: 'ESNext',
            moduleResolution: 'bundler',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            types: ['@cloudflare/workers-types'],
            paths: {
                'virtual:teenybase': ['./teenybase'],
            },
        },
        include: ['src/**/*.ts', 'teenybase.ts', 'worker-configuration.d.ts'],
    }
    return JSON.stringify(config, null, 4) + '\n'
}

function generateWorkerConfigDts(): string {
    return `// Generated by teeny init — regenerate with: npm run cf-typegen
interface CloudflareBindings {
\tPRIMARY_DB: D1Database;
}
`
}

function generateWorkerEntry(): string {
    return `import {$Database, $Env, OpenApiExtension, PocketUIExtension, D1Adapter, teenyHono} from 'teenybase/worker'
import config from 'virtual:teenybase'

type Env = $Env & {Bindings: CloudflareBindings}

const app = teenyHono<Env>(async (c) => {
    const db = new $Database(c, config, new D1Adapter(c.env.PRIMARY_DB))
    db.extensions.push(new OpenApiExtension(db, true))
    db.extensions.push(new PocketUIExtension(db))
    return db
})

export default app
`
}

function generateTeenyConfig(variant: 'blank' | 'with-auth'): string {
    if (variant === 'blank') {
        return `import {DatabaseSettings} from 'teenybase'

export default {
    appUrl: 'http://localhost:8787',
    jwtSecret: '$JWT_SECRET',
    tables: [],
} satisfies DatabaseSettings
`
    }

    return `import {DatabaseSettings, TableAuthExtensionData, TableRulesExtensionData} from 'teenybase'
import {baseFields, authFields, createdTrigger, updatedTrigger} from 'teenybase/scaffolds/fields'

export default {
    appUrl: 'http://localhost:8787',
    jwtSecret: '$JWT_SECRET',
    authCookie: { name: 'teeny_auth' }, // for SSR routes
    tables: [{
        name: 'users',
        autoSetUid: true,
        fields: [...baseFields, ...authFields],
        triggers: [createdTrigger, updatedTrigger],
        extensions: [
            {
                name: 'auth',
                passwordType: 'sha256',
                jwtSecret: '$JWT_SECRET_USERS',
                jwtTokenDuration: 3600,
                maxTokenRefresh: 5,
                passwordConfirmSuffix: 'Confirm',
            } as TableAuthExtensionData,
            {
                name: 'rules',
                listRule: 'auth.uid == id',
                viewRule: 'auth.uid == id',
                createRule: 'true',
                updateRule: 'auth.uid == id',
                deleteRule: 'auth.uid == id',
            } as TableRulesExtensionData,
        ],
    }],
} satisfies DatabaseSettings
`
}

function generateDevVars(): string {
    return `JWT_SECRET=dev-jwt-secret-change-in-production
JWT_SECRET_USERS=dev-users-jwt-secret-change-in-production
ADMIN_JWT_SECRET=dev-admin-jwt-secret-change-in-production
ADMIN_SERVICE_TOKEN=dev-admin-token
POCKET_UI_VIEWER_PASSWORD=viewer
POCKET_UI_EDITOR_PASSWORD=editor
# Uncomment to include error details in API responses during local development.
# Never set this in .prod.vars or in production vars.
# RESPOND_WITH_ERRORS=true
`
}

function generateClaudeSettings(): string {
    const settings = {
        plugins: [
            {path: './node_modules/teenybase'},
        ],
        rules: [
            'Never run npx wrangler directly. Always use npx teenybase commands instead. The teenybase CLI wraps wrangler with support for both teenybase and cloudflare platforms, handles auto-resource creation, authentication and edge-cases.',
        ],
    }
    return JSON.stringify(settings, null, 4) + '\n'
}

const GITIGNORE_LINES = [
    'node_modules',
    '.local-persist',
    '.teeny',
    '.tmp.*.json',
    '.dev.vars',
    '.prod.vars',
    'migrations',
]

function generateGitignore(existingContent?: string): string {
    if (!existingContent) {
        return GITIGNORE_LINES.join('\n') + '\n'
    }

    const existingLines = new Set(existingContent.split('\n').map(l => l.trim()))
    const missing = GITIGNORE_LINES.filter(l => !existingLines.has(l))
    if (missing.length === 0) return existingContent

    const needsNewline = existingContent.length > 0 && !existingContent.endsWith('\n')
    return existingContent + (needsNewline ? '\n' : '') + '\n# teenybase\n' + missing.join('\n') + '\n'
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export interface InitOptions {
    yes?: boolean
    template?: string
    /** Run `<package manager> install` after scaffolding (default true). */
    install?: boolean
}

const NON_INTERACTIVE_HINT = 'Pass --yes (-y) to use the defaults, and --template (-t) to pick a template.'

export async function runInit(root: string, options: InitOptions): Promise<void> {
    const state = detectProjectState(root)

    console.log(colors.bold('\nDetected project state:'))
    const check = (has: boolean, label: string) => {
        console.log(`  ${has ? colors.green('✓') : colors.yellow('○')} ${label}`)
    }
    check(state.hasPackageJson, 'package.json')
    check(state.hasWranglerConfig, 'wrangler config')
    check(state.hasTeenyConfig, 'teeny config')
    check(state.hasTsconfig, 'tsconfig.json')
    check(state.hasWorkerEntry, 'worker entry (src/index.ts)')
    check(state.hasWorkerConfigDts, 'worker-configuration.d.ts')
    check(state.hasDevVars, '.dev.vars')
    check(state.hasGitignore, '.gitignore')
    check(state.hasMigrationsDir, 'migrations/')
    console.log()

    // Determine template variant
    let variant: 'blank' | 'with-auth' = 'with-auth'
    if (options.template) {
        if (options.template !== 'blank' && options.template !== 'with-auth') {
            console.error(colors.red(`Unknown template "${options.template}". Use "with-auth" or "blank".`))
            process.exit(1)
        }
        variant = options.template as 'blank' | 'with-auth'
    } else if (!state.hasTeenyConfig && !options.yes) {
        variant = await ask<'blank' | 'with-auth'>({
            type: 'select',
            message: 'Project template:',
            choices: [
                {title: 'with-auth — Users table with authentication and rules', value: 'with-auth'},
                {title: 'blank — Empty project, no tables', value: 'blank'},
            ],
            initial: 0,
        }, NON_INTERACTIVE_HINT)
    }

    // Determine deploy target
    // New project: ask whether it will deploy to the user's own Cloudflare account, which only adds an
    // empty account_id line (filled in by the first `deploy --remote`). --yes never picks a target;
    // `deploy --remote` reads account_id or the wrangler login later.
    let deployToOwnAccount = false
    if (!state.hasWranglerConfig && !options.yes) {
        const target = await ask<string>({
            type: 'select',
            message: 'Where do you want to deploy?',
            choices: [
                {title: 'Your own Cloudflare account', value: 'own-account'},
                {title: 'Decide later', value: 'later'},
            ],
            initial: 1,
        }, NON_INTERACTIVE_HINT)
        deployToOwnAccount = target === 'own-account'
    }

    // Determine project name — sanitize auto-detected name when --yes skips the prompt
    let projectName = state.projectName
    if (!state.hasPackageJson && !options.yes) {
        const name = await ask<string>({
            type: 'text',
            message: 'Project name:',
            initial: sanitizePackageName(projectName),
            validate: (v: string) => isValidPackageName(v) || 'Must be lowercase, alphanumeric, hyphens only',
        }, NON_INTERACTIVE_HINT)
        if (!name) throw new Error('Project name is required')
        projectName = name
    } else if (!state.hasPackageJson) {
        // --yes mode: auto-sanitize the directory name to a valid package name
        projectName = sanitizePackageName(projectName)
    }

    console.log(colors.bold('\nScaffolding project files...'))

    const created: string[] = []
    const skipped: string[] = []

    const writeFile = (relPath: string, content: string) => {
        const absPath = path.join(root, relPath)
        if (fs.existsSync(absPath)) {
            skipped.push(relPath)
            console.log(`  ${colors.dim('skip')} ${relPath} (already exists)`)
            return
        }
        const dir = path.dirname(absPath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true})
        fs.writeFileSync(absPath, content)
        created.push(relPath)
        console.log(`  ${colors.green('create')} ${relPath}`)
    }

    // Generate missing files
    if (!state.hasPackageJson) {
        writeFile('package.json', generatePackageJson(projectName))
    }

    if (!state.hasWranglerConfig) {
        let wranglerContent = generateWranglerJsonc(projectName)
        if (deployToOwnAccount) {
            wranglerContent = wranglerContent.replace(
                '"main": "src/index.ts"',
                '"account_id": "",  // Your Cloudflare account ID. Filled in from your wrangler login by the first "teeny deploy --remote"\n    "main": "src/index.ts"'
            )
        }
        writeFile('wrangler.jsonc', wranglerContent)
    }

    if (!state.hasTsconfig) {
        writeFile('tsconfig.json', generateTsconfig())
    } else {
        ensureTsconfigHasVirtualTeenybase(root)
    }

    if (!state.hasTeenyConfig) {
        writeFile('teenybase.ts', generateTeenyConfig(variant))
    }

    if (!state.hasWorkerEntry) {
        writeFile('src/index.ts', generateWorkerEntry())
    }

    if (!state.hasWorkerConfigDts) {
        writeFile('worker-configuration.d.ts', generateWorkerConfigDts())
    }

    if (!state.hasDevVars) {
        writeFile('.dev.vars', generateDevVars())
    }

    if (!state.hasClaudeSettings) {
        writeFile('.claude/settings.json', generateClaudeSettings())
    }

    // .gitignore: append missing lines if it exists, create if it doesn't
    if (state.hasGitignore) {
        const gitignorePath = path.join(root, '.gitignore')
        const existing = fs.readFileSync(gitignorePath, 'utf8')
        const updated = generateGitignore(existing)
        if (updated !== existing) {
            fs.writeFileSync(gitignorePath, updated)
            console.log(`  ${colors.green('update')} .gitignore`)
        } else {
            console.log(`  ${colors.dim('skip')} .gitignore (already has all entries)`)
        }
    } else {
        writeFile('.gitignore', generateGitignore())
    }

    if (!state.hasMigrationsDir) {
        const migrationsDir = path.join(root, 'migrations')
        fs.mkdirSync(migrationsDir, {recursive: true})
        console.log(`  ${colors.green('create')} migrations/`)
    }

    // Install dependencies
    const pm = state.packageManager
    let installSkipped = false
    if (created.includes('package.json') || !fs.existsSync(path.join(root, 'node_modules'))) {
        if (options.install === false) {
            installSkipped = true
        } else {
            console.log(`\nInstalling dependencies with ${colors.bold(pm)}...`)
            try {
                execSync(`${pm} install`, {cwd: root, stdio: 'inherit'})
            } catch (e: any) {
                const how = typeof e?.status === 'number' ? `exited with code ${e.status}` : getErrorMessage(e)
                throw new Error(`Dependency install failed ("${pm} install" ${how}). The project files are in ${root}. Fix the error above, then run "${pm} install" there.`)
            }
        }
    }

    // Print next steps
    console.log(colors.bold('\n✓ Project ready!\n'))
    console.log('Next steps:')
    const steps: string[] = []
    if (installSkipped) steps.push(`${colors.cyan(`${pm} install`)}                 — install dependencies`)
    steps.push(`${colors.cyan('npx teenybase deploy --local')}  — generate and apply migrations to the local database`)
    steps.push(`${colors.cyan('npx teenybase dev')}             — start local dev server`)
    steps.push(`${colors.cyan('npx wrangler login')}            — authenticate with Cloudflare`)
    steps.push(`${colors.cyan('npx teenybase deploy --remote')} — deploy to your CF account`)
    steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`))
    console.log(`\n  No Cloudflare account yet? ${colors.cyan('npx teenybase deploy --temporary')} deploys to a temporary one (no login; claim it within 60 minutes to keep it).`)
    console.log()
}

export async function runCreate(name: string, options: InitOptions): Promise<void> {
    if (!isValidPackageName(name)) {
        console.error(colors.red(`Invalid project name "${name}". Must be lowercase, alphanumeric, hyphens, dots, and underscores only.`))
        process.exit(1)
    }

    const targetDir = path.resolve(name)

    let createdDir = false
    if (fs.existsSync(targetDir)) {
        const entries = fs.readdirSync(targetDir)
        if (entries.length > 0) {
            console.error(colors.red(`Directory "${name}" already exists and is not empty.`))
            process.exit(1)
        }
    } else {
        fs.mkdirSync(targetDir, {recursive: true})
        createdDir = true
    }

    console.log(`Creating project in ${colors.bold(targetDir)}`)
    try {
        await runInit(targetDir, options)
    } catch (e) {
        // Don't leave behind the empty directory this command created (e.g. a prompt failed
        // before any file was written). Anything with files in it is kept for the user to inspect.
        if (createdDir && fs.existsSync(targetDir) && fs.readdirSync(targetDir).length === 0) {
            fs.rmdirSync(targetDir)
        }
        throw e
    }

    console.log(`To get started:\n  ${colors.cyan(`cd ${name}`)}\n`)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// todo: scoped package names (@scope/name) are intentionally not supported —
// the name doubles as directory name for `teeny create` and wrangler worker name
function isValidPackageName(name: string): boolean {
    return /^[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= 214
}

/**
 * Ensures an existing tsconfig.json has the `virtual:teenybase` path alias.
 * Uses jsonc-parser modify/applyEdits to preserve comments and formatting.
 */
function ensureTsconfigHasVirtualTeenybase(root: string): void {
    const tsconfigPath = path.join(root, 'tsconfig.json')
    const raw = fs.readFileSync(tsconfigPath, 'utf8')

    // Quick check — if the alias is already present, skip
    if (raw.includes('virtual:teenybase')) {
        console.log(`  ${colors.dim('skip')} tsconfig.json (virtual:teenybase path alias already configured)`)
        return
    }

    // Detect which config file exists so the path alias points to the right file
    const configFile = DEFAULT_CONFIG_FILES.find(f => fs.existsSync(path.join(root, f)))
    const configAlias = configFile ? './' + configFile.replace(/\.[^.]+$/, '') : './teenybase'

    let text = raw
    // Ensure compilerOptions.paths.virtual:teenybase exists, preserving comments
    const edits = jsoncModify(text, ['compilerOptions', 'paths', 'virtual:teenybase'], [configAlias], {})
    text = jsoncApplyEdits(text, edits)

    fs.writeFileSync(tsconfigPath, text)
    console.log(`  ${colors.green('update')} tsconfig.json (added virtual:teenybase path alias)`)
}

/** Converts a directory name to a valid npm package name (lowercase, strip invalid chars) */
function sanitizePackageName(name: string): string {
    let sanitized = name
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '-')   // replace invalid chars with hyphens
        .replace(/^[._-]+/, '')            // strip leading dots/hyphens/underscores
        .replace(/-{2,}/g, '-')            // collapse consecutive hyphens
    if (!sanitized || !isValidPackageName(sanitized)) sanitized = 'my-teenybase-app'
    return sanitized
}
