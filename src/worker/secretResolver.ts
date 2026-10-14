import {aesGcmDecrypt} from '../security/encryption';
import {HTTPException} from 'hono/http-exception';

export class SecretResolver {
    private cache: Map<string, string> = new Map()

    constructor(private readonly env: () => any, private readonly encKeyEnv?: string) {
    }

    resolver(secret?: string, required = false, message?: string) {
        return async () => this.resolve(secret, required, message);
    }
    async resolve(secret?: string, required = false, message?: string) {
        if (!secret) {
            if (required) throw new HTTPException(500, {message: `Invalid configuration, missing secret, ${message}, ${secret}`})
            return ''
        }

        const cached = this.cache.get(secret)
        if (cached !== undefined) return cached

        const env = this.env()
        const encKey = this.encKeyEnv ? env[this.encKeyEnv] : undefined

        const name = secret[0] === '$' ? secret.slice(1) : undefined
        const res = name ? env[name] || '' : secret
        const result: string = typeof encKey === 'string' && name && res ? await aesGcmDecrypt(atob(res), encKey + name, 5) : res || ''
        if (required && !result) {
            throw new HTTPException(500, {message: `Invalid configuration, missing secret, ${message}, ${secret}`})
        }
        this.cache.set(secret, result)
        return result
    }

    static DEFAULT_KEY_ENV = 'TEENY_SECRET_ENCRYPTION_KEY'
}
