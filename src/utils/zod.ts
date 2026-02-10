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
 * Helper function to parse with path context
 * @deprecated - don't use, throw custom errors
 */
export function zParseWithPath<T>(schema: z.ZodType<T>, val: unknown, path: string[]): T {
    const result = schema.safeParse(val)
    if (!result.success) {
        throw new z.ZodError(
            result.error.issues.map(issue => ({
                ...issue,
                path: [...path, ...issue.path],
            }))
        )
    }
    return result.data
}
