import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { Buffer } from 'node:buffer'
import { z } from 'zod'

import { Controller, Get, Payload, Post } from 'helpers/route.ts'
import { cBoards, cKeypairs, cPlayers } from 'models'
import { Http400, Http404 } from 'helpers/http.ts'
import { Instruction, MAX_PLAYERS, PROGRAM_ID } from 'helpers/constants.ts'
import {
  type Seat,
  type SeatState,
  SeatSession,
  shuffle,
  U64,
  type GlobalState,
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

const INITIAL_HANDS: [number, number] = [0, 0]

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
      const seat = await r.getJSON<Seat>(`seat:${seatKey}`)
      if (!seat) {
        return
      }

      const id = Buffer.from(data.slice(0, 16)).toString('hex')
      const chips = Buffer.from(data.slice(16)).readBigUint64LE()
      if (id !== seat.boardId || chips != BigInt(seat.chips)) {
        return
      }

      seat.status = 'ready'
      await r.set(`seat:${seatKey}`, JSON.stringify(seat))
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
        await nats.jsm().consumers.delete(`state_${boardId}`, consumerName)
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
    await nats.jsm().consumers.add(`state_${board.id}`, {
      name: consumerName,
      durable_name: consumerName,
      filter_subject: `states.${board.id}`,
      ack_policy: AckPolicy.None,
      deliver_policy: DeliverPolicy.Last,
    })

    const seatKey = await r.hget(`owner:${owner}`, 'seatKey')
    if (seatKey) {
      const seat = await r.getJSON<Seat>(`seat:${seatKey}`)
      if (seat) {
        return { seatKey, seat }
      }
    }
  }

  @Post('/:boardId/play', auth)
  @Payload(PlayPayloadSchema)
  async play(payload: PlayPayload, ctx: Ctx) {
    const owner = ctx.profile.address

    const board = await cBoards.findOne({ id: ctx.params['boardId'] })
    if (!board) {
      throw new Http404('Board does not exist')
    }
    const player = await cPlayers.findOne({ owner })
    if (!player) {
      throw new Http404('Player does not exist')
    }

    if ((await r.hlen(`board:${board.id}:players`)) > MAX_PLAYERS) {
      throw new Http400('Board is full')
    }

    const signer = new PublicKey(owner)
    const playerAddress = new PublicKey(player.address)
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

    // Create seat session
    const seatKey = Math.random().toString(36).slice(2)
    await r.setJSON<Seat>(`seat:${seatKey}`, {
      boardId: board.id,
      chips: payload.chips,
      playerId: player._id.toString(),
      owner,
      status: 'unready',
    })
    await r.hset(`owner:${owner}`, 'seatKey', seatKey)

    // Create seat message consumer
    await nats.jsm().consumers.add(`seat_${board.id}`, {
      name: seatKey,
      durable_name: seatKey,
      filter_subject: `seats.${seatKey}`,
      ack_policy: AckPolicy.Explicit,
    })

    return { tx: encodeBase64(tx.serialize()), seatKey }
  }

  /**
   * Publish global state to all players
   * @param boardId
   */
  async #sync(boardId: string) {
    const states = await r.hgetall(`board:${boardId}:seats`)

    const globalState: GlobalState = {
      seats: [],
    }

    for (let i = 0; i < states.length; i += 2) {
      const state = JSON.parse(states[i + 1]) as SeatState
      globalState.seats.push({
        playerId: state.playerId,
        hands: state.opened ? state.hands : INITIAL_HANDS,
        chips: state.chips,
      })
    }

    await nats.js().publish(
      `states.${boardId}`,
      JSON.stringify({
        code: GameCode.Sync,
        globalState,
      })
    )
  }

  @Post('/sit', auth)
  @SeatSession(ReadyPayloadSchema)
  async sit(seat: Seat, payload: ReadyPayload) {
    const key = `board:${seat.boardId}:seats`

    await r.hset(
      key,
      payload.seatKey,
      JSON.stringify({
        playerId: seat.playerId,
        chips: seat.chips,
      })
    )

    // Update seat status
    seat.status = 'playing'
    await r.set(`seat:${payload.seatKey}`, JSON.stringify(seat))

    const len = await r.hlen(key)
    if (len >= 2) {
      const states = await r.hgetall(key)
      const js = nats.js()

      const cards = shuffle()
      for (let i = 0; i < states.length; i += 2) {
        const seatKey = states[i]
        const hands = [cards.shift(), cards.shift()] as [number, number]
        const state = JSON.parse(states[i + 1]) as SeatState
        state.hands = hands
        r.hset(key, seatKey, JSON.stringify(state))
        js.publish(
          `seats.${seatKey}`,
          JSON.stringify({
            hands,
          })
        )
      }
      await r.lpush(`board:${seat.boardId}:cards`, ...cards)
    }

    this.#sync(seat.boardId)
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
