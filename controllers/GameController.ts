import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { Buffer } from 'node:buffer'
import { z } from 'zod'

import { Controller, Get, Payload, Post } from 'helpers/route.ts'
import { cBoards, cKeypairs } from 'models'
import { Http400, Http404 } from 'helpers/http.ts'
import { Instruction, MAX_PLAYERS, PROGRAM_ID } from 'helpers/constants.ts'
import {
  type GameSession,
  PlayerState,
  getPlayerAddress,
  Seat,
  shuffle,
  U64,
  GlobalState,
  GameCode,
} from 'helpers/game.ts'
import { decodeBase58, encodeBase64 } from '@std/encoding'
import { buildTx } from 'helpers/solana.ts'
import { r, rSub } from 'helpers/redis.ts'
import { eventEmitter } from 'helpers/game.ts'

import auth from '../middlewares/auth.ts'
import { AckPolicy, DeliverPolicy } from '@nats-io/jetstream'
import nats from 'helpers/nats.ts'
import log from 'helpers/log.ts'

const PlayPayloadSchema = z.object({
  chips: z.number().nonnegative(),
})
type PlayPayload = z.infer<typeof PlayPayloadSchema>

const ReadyPayloadSchema = z.object({
  seatKey: z.string(),
})
type ReadyPayload = z.infer<typeof ReadyPayloadSchema>

@Controller('/v1/game')
class GameController {
  constructor() {
    eventEmitter.on(
      `tx-confirmed-${Instruction.Play}`,
      this.#handlePlayConfirmed
    )
    this.#subscribeSessionExpiration()
  }

  async #handlePlayConfirmed(accounts: PublicKey[], data: Uint8Array) {
    try {
      const owner = accounts[0].toBase58()
      const seatKey = await r.hget(`owner:${owner}`, 'seatKey')
      if (!seatKey) {
        return
      }
      const gs = await r.getJSON<GameSession>(`gs:${seatKey}`)
      if (!gs) {
        return
      }

      const id = Buffer.from(data.slice(0, 16)).toString('hex')
      const chips = Buffer.from(data.slice(16)).readBigUint64LE()
      if (id !== gs.boardId || chips != BigInt(gs.chips)) {
        return
      }

      gs.ready = true
      await r.set(`gs:${seatKey}`, JSON.stringify(gs))
    } catch (error) {
      log.error(error)
    }
  }

  /**
   * Subscribe key expiration event to remove nats consumer
   */
  async #subscribeSessionExpiration() {
    await r.configSet('notify-keyspace-events', 'Ex')
    const sub = await rSub.subscribe('__keyevent@0__:expired')
    for await (const msg of sub.receive()) {
      try {
        const [_, boardId, __, consumerName] = msg.message.split(':')
        await nats.jsm().consumers.delete(`states_${boardId}`, consumerName)
      } catch (error) {
        log.error(error)
      }
    }
  }

  @Post('/:boardId/enter')
  async enter(ctx: Ctx) {
    const board = await cBoards.findOne({ id: ctx.params['boardId'] })
    if (!board) {
      throw new Http404('Board does not exist')
    }

    // Used to identify the client
    const consumerName = Math.random().toString(36).slice(2)
    const sessionId = `board:${board.id}:session:${consumerName}`
    ctx.cookies.set('sessionId', sessionId, {
      // path: `/game/`,
      httpOnly: false,
    })
    let owner: string | null = null
    try {
      await auth(ctx)
      owner = ctx.profile.address
      // deno-lint-ignore no-empty
    } catch (_) {}
    await r.setex(sessionId, 30, owner ?? '')

    // Create consumer to consume global states
    await nats.jsm().consumers.add(`states_${board.id}`, {
      name: consumerName,
      durable_name: consumerName,
      filter_subject: `states.${board.id}`,
      ack_policy: AckPolicy.None,
      deliver_policy: DeliverPolicy.Last,
    })
  }

  @Post('/:boardId/play', auth)
  @Payload(PlayPayloadSchema)
  async play(payload: PlayPayload, ctx: Ctx) {
    const board = await cBoards.findOne({ id: ctx.params['boardId'] })
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
    const seatKey = Math.random().toString(36).slice(2)
    await r.setJSON(`gs:${seatKey}`, {
      boardId: board.id,
      chips: payload.chips,
      owner,
    })
    await r.hset(`owner:${owner}`, 'seatKey', seatKey)

    // Create game session message consumer
    await nats.jsm().consumers.add(`game`, {
      name: seatKey,
      durable_name: seatKey,
      filter_subject: `gs.${seatKey}`,
      ack_policy: AckPolicy.Explicit,
    })

    return { tx: encodeBase64(tx.serialize()), seatKey }
  }

  @Post('/sit', auth)
  @Seat(ReadyPayloadSchema)
  async sit(gs: GameSession, payload: ReadyPayload) {
    const key = `board:${gs.boardId}:seats`

    await r.hset(
      key,
      payload.seatKey,
      JSON.stringify({ hands: [0, 0], chips: gs.chips })
    )

    const len = await r.hlen(key)
    if (len >= 2) {
      const states = await r.hgetall(key)
      const js = nats.js()

      const globalState: GlobalState = {
        players: [],
      }

      const cards = shuffle()
      for (let i = 0; i < states.length; i += 2) {
        const seatKey = states[i]
        const hands = [cards.shift(), cards.shift()] as [number, number]
        const state = JSON.parse(states[i + 1]) as PlayerState
        state.hands = hands
        r.hset(key, seatKey, JSON.stringify(state))
        js.publish(
          `gs.${seatKey}`,
          JSON.stringify({
            hands,
          })
        )
        globalState.players.push({ hands: [0, 0], chips: gs.chips })
      }

      // Publish global state to all
      await nats.js().publish(
        `states.${gs.boardId}`,
        JSON.stringify({
          code: GameCode.Sync,
          globalState,
        })
      )

      await r.lpush(`board:${gs.boardId}:cards`, ...cards)
    }
  }

  @Get('/ping')
  async ping(ctx: Ctx) {
    const sessionId = await ctx.cookies.get('sessionId')
    if (!sessionId) {
      return
    }
    r.expire(sessionId, 30)
  }
}

export default GameController
