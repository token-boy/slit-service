/**
 * Generate random jwt private key.
 */

export const KEY_NAME = 'key'
export const KEY_FORMAT = 'raw'
export const EXTRACTABLE = true

export const algorithm: HmacImportParams = {
  name: 'HMAC',
  hash: 'SHA-512',
}
export const keyUsages: KeyUsage[] = ['sign', 'verify']

if (import.meta.main) {
  const cryptoKey = await crypto.subtle.generateKey(algorithm, true, keyUsages)
  const exportedKey = await crypto.subtle.exportKey(KEY_FORMAT, cryptoKey)
  Deno.writeFileSync(KEY_NAME, new Uint8Array(exportedKey))
}
