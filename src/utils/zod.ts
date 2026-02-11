// https://github.com/colinhacks/zod/discussions/2215
import {z} from 'zod'

export const zStringToJSON = z.string()
    .transform( ( str, ctx ): any => {
        try {
            return JSON.parse( str )
        } catch ( e ) {
            ctx.addIssue( { code: 'custom', message: 'Invalid JSON' } )
            return z.NEVER
        }
    } )
export const zJsonString = z.string()
    .transform( ( str, ctx ) => {
        try {
            JSON.parse( str )
            return str
        } catch ( e ) {
            ctx.addIssue( { code: 'custom', message: 'Invalid JSON' } )
            return z.NEVER
        }
    } )

/**
 * Create a ZodError for validation errors outside of Zod schema parsing
 * This allows us to use the same error structure and formatting for all validation errors
 */
export function zCustomError(message: string, ...path: (string | number)[]): z.ZodError {
    return new z.ZodError([
        {
            code: 'custom',
            message,
            path,
        }
    ])
}

/**
 * Helper function to parse with path context
 */
export function zParseWithPath<T>(schema: z.ZodType<T>, val: unknown, path: (string|number)[]): T {
    const result = schema.safeParse(val)
    if (!result.success) {
        // we have to use ZodRealError here.
        throw new z.ZodRealError(
            result.error.issues.map(issue => ({
                ...issue,
                path: [...path, ...issue.path],
            }))
        )
    }
    return result.data
}


/**
 * Format a Zod error with full context path for better error messages
 */
export function formatZodError(error: z.ZodError, prefix?: string): string {
    const messages = error.issues.map(err => {
        const path = err.path.length > 0 ? err.path.join(' → ') : 'root';
        return `  - ${path}: ${err.message}`;
    });

    const prefixText = prefix ? `${prefix}\n` : '';
    return `${prefixText}Validation errors:\n${messages.join('\n')}`;
}

