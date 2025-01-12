import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { Buffer } from 'node:buffer'
import { z } from 'zod'

import { Controller, Payload, Post } from 'helpers/route.ts'
import { cBoards, cKeypairs } from 'models'
import { Http400, Http404 } from 'helpers/http.ts'
import { Instruction, MAX_PLAYERS, PROGRAM_ID } from 'helpers/constants.ts'
import {
  type GameSession,
  GameState,
  getPlayerAddress,
  GS,
  shuffle,
  U64,
} from 'helpers/game.ts'
import { decodeBase58, encodeBase64 } from '@std/encoding'
import { buildTx } from 'helpers/solana.ts'
import { r } from 'helpers/redis.ts'
import { eventEmitter } from 'helpers/game.ts'

import auth from '../middlewares/auth.ts'
import { AckPolicy } from '@nats-io/jetstream'
import nats from 'helpers/nats.ts'
import log from 'helpers/log.ts'

const playPayloadSchema = z.object({
  boardId: z.string(),
  chips: z.number().nonnegative(),
})
type PlayPayload = z.infer<typeof playPayloadSchema>

const readyPayloadSchema = z.object({
  gsKey: z.string(),
})
type ReadyPayload = z.infer<typeof readyPayloadSchema>

@Controller('/v1')
class GameController {
  constructor() {
    eventEmitter.on(
      `tx-confirmed-${Instruction.Play}`,
      this.#handlePlayConfirmed
    )
  }

  async #handlePlayConfirmed(accounts: PublicKey[], data: Uint8Array) {
    try {
      const owner = accounts[0].toBase58()
      const gsKey = await r.hget(`owner:${owner}`, 'gsKey')
      if (!gsKey) {
        return
      }
      const gs = await r.getJSON<GameSession>(`gs:${gsKey}`)
      if (!gs) {
        return
      }
      
      const id = Buffer.from(data.slice(0, 16)).toString('hex')
      const chips = Buffer.from(data.slice(16)).readBigUint64LE()
      if (id !== gs.boardId || chips != BigInt(gs.chips)) {
        return
      }

      gs.ready = true
      await r.set(`gs:${gsKey}`, JSON.stringify(gs))
    } catch (error) {
      log.error(error)
    }
  }

  @Post('/play', auth)
  @Payload(playPayloadSchema)
  async play(payload: PlayPayload, ctx: Ctx) {
    const board = await cBoards.findOne({ id: payload.boardId })
    if (!board) {
      throw new Http404('Board does not exist')
    }

    if ((await r.hlen(`board:${board.id}:players`)) > MAX_PLAYERS) {
      throw new Http400('Board is full')
    }

    const owner = ctx.profile.address

    const signer = new PublicKey(owner)
    const playerAddress = getPlayerAddress(signer)
    const keypair = await cKeypairs.findOne({ publicKey: board.dealer })
    const dealer = Keypair.fromSecretKey(decodeBase58(keypair!.secretKey))
    const boardAddress = new PublicKey(board.address)

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: signer, isSigner: true, isWritable: false },
        { pubkey: playerAddress, isSigner: false, isWritable: true },
        { pubkey: dealer.publicKey, isSigner: true, isWritable: false },
        { pubkey: boardAddress, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([
        Instruction.Play,
        ...Buffer.from(board.id, 'hex'),
        ...U64.toUint8Array(payload.chips),
      ]),
    })

    const tx = await buildTx(signer, [ix])
    tx.sign([dealer])

    // Create Game session
    const gsKey = Math.random().toString(36).slice(2)
    await r.setJSON(`gs:${gsKey}`, {
      boardId: board.id,
      chips: payload.chips,
      owner,
    })
    await r.hset(`owner:${owner}`, 'gsKey', gsKey)

    // Create game session message consumer
    await nats.jsm().consumers.add(`game`, {
      name: gsKey,
      durable_name: gsKey,
      filter_subject: `gs.${gsKey}`,
      ack_policy: AckPolicy.Explicit,
    })

    return { tx: encodeBase64(tx.serialize()), gsKey }
  }

  @Post('/sit', auth)
  @GS(readyPayloadSchema)
  async sit(gs: GameSession, payload: ReadyPayload) {
    const key = `board:${gs.boardId}:sessions`

    await r.hset(
      key,
      payload.gsKey,
      JSON.stringify({ hands: [0, 0], chips: gs.chips })
    )

    const len = await r.hlen(key)
    if (len >= 2) {
      const states = await r.hgetall(key)
      const js = nats.js()

      const cards = shuffle()
      for (let i = 0; i < states.length; i += 2) {
        const gsKey = states[i]
        const hands = [cards.shift(), cards.shift()] as [number, number]
        const state = JSON.parse(states[i + 1]) as GameState
        state.hands = hands
        r.hset(key, gsKey, JSON.stringify(state))
        js.publish(
          `gs.${gsKey}`,
          JSON.stringify({
            hands,
          })
        )
      }

      await r.lpush(`board:${gs.boardId}:cards`, ...cards)
    }
  }
}

export default GameController
