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
