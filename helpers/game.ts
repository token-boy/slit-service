import { PublicKey } from '@solana/web3.js'
import { PLAYER, PROGRAM_ID } from 'helpers/constants.ts'
import { EventEmitter } from 'node:events'

export const encoder = new TextEncoder()
export const decoder = new TextDecoder()

export const eventEmitter = new EventEmitter()

export function getPlayerAddress(owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [encoder.encode(PLAYER), owner.toBytes()],
    PROGRAM_ID
  )[0]
}

export class U64 {
  static toUint8Array(value: number | string) {
    return new Uint8Array(new BigUint64Array([BigInt(value)]).buffer)
  }
}
