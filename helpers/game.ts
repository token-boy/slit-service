import { PublicKey } from '@solana/web3.js'
import { PLAYER, PROGRAM_ID } from 'helpers/constants.ts'
import { EventEmitter } from 'node:events'
import { r } from 'helpers/redis.ts'
import { Http400, Http404 } from 'helpers/http.ts'
import { z } from 'zod'
import { connection } from 'helpers/solana.ts'

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

export interface GameSession {
  owner: string
  boardId: string
  chips: number
  ready: boolean
}

export interface PlayerState {
  hands: [number, number]
  chips: number
}

export interface GlobalState {
  players: PlayerState[]
}

export function Seat(Schame: z.AnyZodObject) {
  return function (
    // deno-lint-ignore ban-types
    _target: Object,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const method = descriptor.value
    descriptor.value = async function (ctx: Ctx) {
      const body = ctx.payload
      const payload = Schame.parse(body)

      const gs = await r.getJSON(`gs:${ctx.payload.seatKey}`)
      if (!gs) {
        throw new Http404('Seat key invalid')
      }
      if (!gs.ready) {
        throw new Http404('Seat not ready')
      }

      return method.apply(this, [gs, payload, ctx])
    }
  }
}

export async function checkTx(signature: string, instructionCode: number) {
  const receipt = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  })

  const error = new Http400('Invalid transaction')

  if (!receipt) {
    throw error
  }

  const { transaction: tx } = receipt

  if (!tx.signatures.length) {
    throw error
  }

  // Check if the transaction has unexpected instructions.
  const { staticAccountKeys, compiledInstructions } = tx.message
  if (compiledInstructions.length !== 1) {
    throw error
  }

  // Check if the transaction is for the correct program.
  const [instruction] = compiledInstructions
  if (!staticAccountKeys[instruction.programIdIndex].equals(PROGRAM_ID)) {
    throw error
  }

  // Check if the transaction has the correct instruction.
  if (instruction.data[0] !== instructionCode) {
    throw error
  }

  return { staticAccountKeys, instruction }
}

export function shuffle(cards?: number[]) {
  if (!cards) {
    cards = Array.from({ length: 52 }, (_, i) => i + 1)
  }

  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[cards[i], cards[j]] = [cards[j], cards[i]]
  }
  return cards
}

export enum GameCode {
  Error = 0,
  Sync = 1,
}

export enum GameError {
  Unknown = 0,
}
