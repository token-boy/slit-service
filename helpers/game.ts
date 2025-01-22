import { PublicKey } from '@solana/web3.js'
import { PLAYER, PROGRAM_ID, SOL_DECIMALS } from 'helpers/constants.ts'
import { Http400 } from 'helpers/http.ts'
import { connection } from 'helpers/solana.ts'
import nats from 'helpers/nats.ts'

export const TE = new TextEncoder()
export const TD = new TextDecoder()

export interface Seat {
  /**
   * The owner address of the player.
   */
  owner: string

  /**
   * The id of the player.
   */
  playerId: string

  /**
   * The amount of chips the player current has.
   */
  chips: string

  /**
   * The hands of the player.
   */
  hands?: [number, number]

  // /**
  //  * `unready`: Wait for the transaction of stake chips to be confirmed.
  //  * `ready`: The transaction of stake chips has been confirmed.
  //  * `playing`: Game is in progress.
  //  * `settling`: Game is settling.
  //  */
  // status: 'unready' | 'ready' | 'playing' | 'settling'
}

export enum GameCode {
  Error = 0,
  Sync = 1,
  Bet = 2,
  Open = 3,
  Deal = 4,
}

export interface GameState {
  seats: Omit<Seat, 'owner'>[]
  deckCount: number
  turn?: string
  turnExpireAt?: number
  pot: string
}

export class U64 {
  static toUint8Array(value: bigint) {
    return new Uint8Array(new BigUint64Array([value]).buffer)
  }
}

export function getPlayerAddress(owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [TE.encode(PLAYER), owner.toBytes()],
    PROGRAM_ID
  )[0]
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

export function publishGameState(boardId: string, state: GameState) {
  return nats.js().publish(
    `states.${boardId}`,
    JSON.stringify({
      code: GameCode.Sync,
      ...state,
    })
  )
}

export function uiAmount(amount: string | bigint) {
  return (BigInt(amount) / BigInt(SOL_DECIMALS)).toString()
}
