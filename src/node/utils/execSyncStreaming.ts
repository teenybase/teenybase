import {spawn} from 'node:child_process';

/**
 * Execute a command like execSync but stream output to console in real-time.
 * Optionally captures stdout/stderr and returns them.
 * @param command The command to execute
 * @param options Spawn options (cwd, env, etc.)
 * @param capture Whether to capture and return stdout/stderr
 * @returns Promise resolving to {stdout, stderr, code} if capture=true, or just {code} if capture=false
 */
export async function execSyncStreaming(
    command: string,
    options?: { cwd?: string, env?: NodeJS.ProcessEnv },
    capture = true
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, {
            cwd: options?.cwd,
            env: options?.env,
            shell: true
        })

        let stdoutData = ''
        let stderrData = ''

        child.stdout.on('data', (data) => {
            const chunk = data.toString()
            if (capture) stdoutData += chunk
            process.stdout.write(chunk)
        })

        child.stderr.on('data', (data) => {
            const chunk = data.toString()
            if (capture) stderrData += chunk
            process.stderr.write(chunk)
        })

        child.on('close', (code) => {
            if (code === 0) resolve(stdoutData)
            else reject({stdout: stdoutData, output: stdoutData, stderr: stderrData, status: code || 0})
        })

        child.on('error', (err) => {
            reject(err)
        })
    })
}
