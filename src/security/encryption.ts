// https://github.com/repalash/ts-browser-helpers/blob/ce93a683e0142e20ac60f8211a06698373fbba17/src/encryption.ts#L19

/** IV length in bytes for new ciphertexts: 96 bits, the length NIST SP 800-38D recommends for random GCM IVs. */
export const AES_GCM_IV_LENGTH = 12
/**
 * IV length of ciphertexts written before 0.1.0 (40 bits). Still accepted by aesGcmDecrypt, see there.
 * Only for reading old data, never encrypt with it.
 */
export const AES_GCM_LEGACY_IV_LENGTH = 5

/**
 * Encrypts plaintext using AES-GCM with supplied password, for decryption with aesGcmDecrypt().
 *                                                                      (c) Chris Veness MIT Licence
 * https://gist.github.com/chrisveness/43bcda93af9f646d083fad678071b90a
 * Modified to work with Uint8Array and string content.
 *
 * @param content - Plaintext or Uint8 Buffer to be encrypted.
 * @param password - Plaintext or Uint8 Buffer Password to use to encrypt content.
 * @param prefix - Optional prefix to prepend to the ciphertext.
 * @param ivLen - IV length in bytes, default {@link AES_GCM_IV_LENGTH} (12). The output is `prefix + iv + ciphertext + tag`.
 * @returns Encrypted ciphertext. If content is a string, the ciphertext is a string. If content is a Uint8Array, the ciphertext is a new Uint8Array.
 *
 *
 * @example
 *   const ciphertext = await aesGcmEncrypt('my secret text', 'pw');
 *   aesGcmEncrypt('my secret text', 'pw').then(function(ciphertext) { console.log(ciphertext); });
 *
 * @category Encryption
 */
export async function aesGcmEncrypt<T extends string|Uint8Array>(content: T, password: string|Uint8Array, prefix?: string | Uint8Array, ivLen = AES_GCM_IV_LENGTH): Promise<T> {
    const pwUtf8 = typeof password === 'string' ? new TextEncoder().encode(password) : password // encode password as UTF-8
    const pwHash = await crypto.subtle.digest('SHA-256', pwUtf8) // hash the password

    const iv = crypto.getRandomValues(new Uint8Array(ivLen))
    const ivStr = Array.from(iv).map(b => String.fromCharCode(b)).join('') // iv as utf-8 string

    const alg = {name: 'AES-GCM', iv: iv} // specify algorithm to use

    const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['encrypt']) // generate key from pw

    const ptUint8 = typeof content === 'string' ? new TextEncoder().encode(content) : content as Uint8Array // encode plaintext as UTF-8
    const ctBuffer = await crypto.subtle.encrypt(alg, key, ptUint8) // encrypt plaintext using key

    const ctUint = new Uint8Array(ctBuffer)
    const ctArray = Array.from(ctUint) // ciphertext as byte array
    const ctStr = ctArray.map(byte => String.fromCharCode(byte)).join('') // ciphertext as string

    const prefixStr = prefix ? typeof prefix === 'string' ? prefix : new TextDecoder().decode(prefix) : ''
    const prefixArray = prefix ? typeof prefix === 'string' ? new TextEncoder().encode(prefix) : Array.from(prefix) : []
    return typeof content === 'string' ? (prefixStr + ivStr + ctStr) as T : new Uint8Array([...prefixArray, ...iv, ...ctArray]) as T
}


/**
 * Decrypts ciphertext encrypted with aesGcmEncrypt() using supplied password.
 *                                                                      (c) Chris Veness MIT Licence
 *
 * https://gist.github.com/chrisveness/43bcda93af9f646d083fad678071b90a
 * Modified to work with Uint8Array and string content.
 *
 * @param ciphertext - Ciphertext to be decrypted.
 * @param password - Password to use to decrypt ciphertext.
 * @param ivLen - IV length in bytes. When omitted, the 12-byte IV of current ciphertexts is tried first and then the
 *   5-byte IV written before 0.1.0. The stored format (`iv + ciphertext + tag`) has no length marker, but GCM
 *   authenticates the IV: a wrong split fails the tag check (forgery probability 2^-128), so trying both is unambiguous.
 * @returns Decrypted content. If ciphertext is a string, the plaintext is a string. If ciphertext is a Uint8Array, the plaintext is a new Uint8Array.
 *
 * @example
 *   const plaintext = await aesGcmDecrypt(ciphertext, 'pw');
 *   aesGcmDecrypt(ciphertext, 'pw').then(function(plaintext) { console.log(plaintext); });
 *
 * @category Encryption
 */
export async function aesGcmDecrypt<T extends string|Uint8Array>(ciphertext: T, password: string|Uint8Array, ivLen?: number): Promise<T> {
    const pwUtf8 = typeof password === 'string' ? new TextEncoder().encode(password) : password // encode password as UTF-8
    const pwHash = await crypto.subtle.digest('SHA-256', pwUtf8) // hash the password

    if (ivLen !== undefined) return decryptWithIv(ciphertext, pwHash, ivLen)
    try {
        return await decryptWithIv(ciphertext, pwHash, AES_GCM_IV_LENGTH)
    } catch {
        return await decryptWithIv(ciphertext, pwHash, AES_GCM_LEGACY_IV_LENGTH)
    }
}

async function decryptWithIv<T extends string|Uint8Array>(ciphertext: T, pwHash: ArrayBuffer, ivLen: number): Promise<T> {
    // AES-GCM output is at least the 16-byte tag
    if (ciphertext.length < ivLen + 16) throw new Error('Decrypt failed')
    const ivStr = ciphertext.slice(0, ivLen)
    const iv = typeof ivStr === 'string' ? new Uint8Array(Array.from(ivStr).map(ch => ch.charCodeAt(0))) : ivStr // decode base64 iv

    const alg = {name: 'AES-GCM', iv: iv} // specify algorithm to use

    const key = await crypto.subtle.importKey('raw', pwHash, alg, false, ['decrypt']) // generate key from pw

    const ctStr = ciphertext.slice(ivLen)
    const ctUint8 = typeof ctStr === 'string' ? new Uint8Array(Array.from(ctStr).map(ch => ch.charCodeAt(0))) : ctStr
    // note: why doesn't ctUint8 = new TextEncoder().encode(ctStr) work?

    try {
        const plainBuffer = await crypto.subtle.decrypt(alg, key, ctUint8) // decrypt ciphertext using key
        return typeof ciphertext === 'string' ? new TextDecoder().decode(plainBuffer) as T : new Uint8Array(plainBuffer) as T
    } catch (e) {
        throw new Error('Decrypt failed')
    }
}

/** Constant-time string comparison. Returns true if both strings are equal. */
export function timingSafeEqual(a: string, b: string): boolean {
    const encoder = new TextEncoder()
    const aBytes = encoder.encode(a)
    const bBytes = encoder.encode(b)
    const lengthsMatch = aBytes.byteLength === bBytes.byteLength
    return lengthsMatch
        ? crypto.subtle.timingSafeEqual(aBytes, bBytes)
        : !crypto.subtle.timingSafeEqual(aBytes, aBytes)
}
