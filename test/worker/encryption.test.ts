import {describe, expect, test} from 'vitest'
import {AES_GCM_IV_LENGTH, aesGcmDecrypt, aesGcmEncrypt} from '../../src/security/encryption'
import {SecretResolver} from '../../src/worker/secretResolver'

// AES-GCM used a 40-bit (5-byte) random IV; NIST SP 800-38D asks for 96 bits. New ciphertexts use 12 bytes, and
// decryption without an explicit ivLen still reads the old 5-byte format (the GCM tag decides which split is right).
// Used by SecretResolver for env secrets encrypted with TEENY_SECRET_ENCRYPTION_KEY.
// Runs in workerd: Node's Web Crypto rejects IVs shorter than 8 bytes (ERR_CRYPTO_INVALID_IV), workerd accepts them.

const TAG = 16

describe('aesGcmEncrypt / aesGcmDecrypt', () => {
    test('new ciphertexts carry a 12-byte IV', async () => {
        expect(AES_GCM_IV_LENGTH).toEqual(12)
        const ct = await aesGcmEncrypt('hello', 'pw')
        expect(ct.length).toEqual(12 + 'hello'.length + TAG)
        const bin = await aesGcmEncrypt(new Uint8Array([1, 2, 3]), 'pw')
        expect(bin.length).toEqual(12 + 3 + TAG)
    })

    test('round trip, string and bytes', async () => {
        expect(await aesGcmDecrypt(await aesGcmEncrypt('secret value ✓', 'pw'), 'pw')).toEqual('secret value ✓')
        const bytes = new Uint8Array([0, 255, 7, 42])
        expect(Array.from(await aesGcmDecrypt(await aesGcmEncrypt(bytes, 'pw'), 'pw'))).toEqual(Array.from(bytes))
        expect(await aesGcmDecrypt(await aesGcmEncrypt('', 'pw'), 'pw')).toEqual('')
    })

    test('data written with the old 5-byte IV still decrypts', async () => {
        for (const pt of ['', 'x', 'a longer secret that is more than twelve bytes']) {
            const legacy = await aesGcmEncrypt(pt, 'pw', undefined, 5)
            expect(legacy.length).toEqual(5 + pt.length + TAG)
            expect(await aesGcmDecrypt(legacy, 'pw')).toEqual(pt)
        }
        const legacyBytes = await aesGcmEncrypt(new Uint8Array([9, 8, 7]), 'pw', undefined, 5)
        expect(Array.from(await aesGcmDecrypt(legacyBytes, 'pw'))).toEqual([9, 8, 7])
    })

    test('a fixed old-format vector decrypts (not produced by this code)', async () => {
        // iv 01 02 03 04 05, key SHA-256('pw'), plaintext 'old' - built with Web Crypto directly
        const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pw')), 'AES-GCM', false, ['encrypt'])
        const iv = new Uint8Array([1, 2, 3, 4, 5])
        const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode('old')))
        const str = String.fromCharCode(...iv, ...ct)
        expect(await aesGcmDecrypt(str, 'pw')).toEqual('old')
    })

    test('an explicit ivLen is used as given', async () => {
        const ct = await aesGcmEncrypt('v', 'pw', undefined, 16)
        expect(await aesGcmDecrypt(ct, 'pw', 16)).toEqual('v')
        await expect(aesGcmDecrypt(await aesGcmEncrypt('v', 'pw'), 'pw', 5)).rejects.toThrow('Decrypt failed')
    })

    test('wrong password, tampering and truncation fail', async () => {
        const ct = await aesGcmEncrypt('hello', 'pw')
        await expect(aesGcmDecrypt(ct, 'other')).rejects.toThrow('Decrypt failed')
        const flipped = ct.slice(0, -1) + String.fromCharCode(ct.charCodeAt(ct.length - 1) ^ 1)
        await expect(aesGcmDecrypt(flipped, 'pw')).rejects.toThrow('Decrypt failed')
        await expect(aesGcmDecrypt(ct.slice(0, 10), 'pw')).rejects.toThrow('Decrypt failed')
    })
})

describe('SecretResolver with TEENY_SECRET_ENCRYPTION_KEY', () => {
    const resolve = async (stored: string) => {
        const env = {TEENY_SECRET_ENCRYPTION_KEY: 'enc-key', API_KEY: stored}
        return new SecretResolver(() => env, SecretResolver.DEFAULT_KEY_ENV).resolve('$API_KEY')
    }
    test('reads secrets encrypted with the new and the old IV length', async () => {
        expect(await resolve(btoa(await aesGcmEncrypt('new-format', 'enc-key' + 'API_KEY', undefined, 12)))).toEqual('new-format')
        expect(await resolve(btoa(await aesGcmEncrypt('old-format', 'enc-key' + 'API_KEY', undefined, 5)))).toEqual('old-format')
    })
})
