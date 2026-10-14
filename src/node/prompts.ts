import prompts, {PromptObject} from 'prompts'

/**
 * Ask one question in the terminal. All CLI prompts go through this instead of calling `prompts`
 * directly.
 *
 * - **Not a terminal** (CI, pipes, agents, `< /dev/null`): throws immediately. `prompts` never
 *   settles when stdin is closed, so the event loop drains and Node exits with code 0 in the middle
 *   of the command, as if it had succeeded. `nonInteractiveHint` must tell the user how to answer
 *   the question without a terminal, usually by naming a flag, e.g. `'Pass --yes to continue.'`
 * - **Ctrl+C / Esc**: throws `Cancelled`. `prompts` would otherwise resolve with no value, which
 *   callers can mistake for an answer (e.g. a select falling back to a default).
 */
export async function ask<T = any>(question: Omit<PromptObject<'value'>, 'name'>, nonInteractiveHint: string): Promise<T> {
    if (!process.stdin.isTTY) {
        const raw = typeof question.message === 'string' ? question.message : ''
        const firstLine = raw.split('\n')[0].trim()
        const what = firstLine ? `"${firstLine}"` : 'a question'
        throw new Error(`Cannot ask ${what}: stdin is not an interactive terminal. ${nonInteractiveHint}`)
    }
    let cancelled = false
    const res = await prompts({...question, name: 'value'} as PromptObject<'value'>, {
        onCancel: () => {
            cancelled = true
            return false
        },
    })
    if (cancelled) throw new Error('Cancelled')
    return res.value as T
}

export async function promptEmail(initial?: string): Promise<string> {
    if (initial) return initial
    const value = await ask<string>({
        type: 'text', message: 'Email:',
        validate: (v: string) => v.includes('@') || 'Please enter a valid email',
    }, 'Pass --email.')
    if (!value) throw new Error('Email is required. Pass --email or run in an interactive terminal.')
    return value
}

export async function promptPassword(initial?: string, opts?: {confirm?: boolean, minLength?: number}): Promise<string> {
    const minLen = opts?.minLength ?? 0
    if (initial != null) {
        const val = String(initial)
        if (minLen && val.length < minLen) throw new Error(`Password must be at least ${minLen} characters`)
        return val
    }
    const password = await ask<string>({
        type: 'password', message: 'Password:',
        validate: minLen ? ((v: string) => v.length >= minLen || `Password must be at least ${minLen} characters`) : undefined,
    }, 'Pass --password.')
    if (!password) throw new Error('Password is required. Pass --password or run in an interactive terminal.')
    if (opts?.confirm) {
        const confirmed = await ask<string>({type: 'password', message: 'Confirm password:'}, 'Pass --password.')
        if (confirmed !== password) throw new Error('Passwords do not match')
    }
    return password
}
