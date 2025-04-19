import {z} from 'zod';
import {sqlValSchema2} from '../zod/sqlSchemas';
import {SQLLiteral, SQLQuery} from '../sql';

export function sqlRaw(q: string, p?: Record<string, z.infer<typeof sqlValSchema2>>): SQLQuery {
    return {q, p}
}

export function sqlValue<T extends z.infer<typeof sqlValSchema2>>(v: T): SQLLiteral<T> {
    return {l: v}
}

export const sql = (strings: TemplateStringsArray, ...values: any[]) => ({
    q: String.raw(strings, ...values)
})
