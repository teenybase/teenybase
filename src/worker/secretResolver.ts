import {aesGcmDecrypt} from '../security/encryption';
import {HTTPException} from 'hono/http-exception';

export class SecretResolver {
    constructor(private readonly env: () => any, private readonly encKeyEnv?: string) {
    }

    resolver(secret?: string, required = false, message?: string) {
        return async () => this.resolve(secret, required, message);
    }
    async resolve(secret?: string, required = false, message?: string) {
        const env = this.env()
        const encKey = this.encKeyEnv ? env[this.encKeyEnv] : undefined

        const name = secret && secret[0] === '$' ? secret.slice(1) : undefined
        const res = name ? env[name] || '' : secret
        const result: string = typeof encKey === 'string' && name && res ? await aesGcmDecrypt(atob(res), encKey + name, 5) : res || ''
        if (required && !result) {
            throw new HTTPException(500, {message: `Invalid configuration, missing secret, ${message}, ${secret}`})
        }
        return result
    }

    static DEFAULT_KEY_ENV = 'TEENY_SECRET_ENCRYPTION_KEY'
}
