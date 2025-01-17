import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { AckPolicy, DeliverPolicy } from '@nats-io/jetstream'

import nats from 'helpers/nats.ts'
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
  type GameState,
  GameCode,
  CursorState,
} from 'helpers/game.ts'
import { decodeBase58, encodeBase64 } from '@std/encoding'
import { buildTx } from 'helpers/solana.ts'
import { r } from 'helpers/redis.ts'
import { auth } from 'middlewares'

import { addTxEventListener } from './TxController.ts'

const PlayPayloadSchema = z.object({
  chips: z.bigint({ coerce: true }).gt(0n),
})
type PlayPayload = z.infer<typeof PlayPayloadSchema>

const ReadyPayloadSchema = z.object({
  seatKey: z.string(),
})
type ReadyPayload = z.infer<typeof ReadyPayloadSchema>

const TurnPayloadSchema = z.object({
  seatKey: z.string(),
  bet: z.bigint({ coerce: true }).nonnegative(),
})
type TurnPayload = z.infer<typeof TurnPayloadSchema>

const INITIAL_HANDS: [number, number] = [0, 0]
const COUNTDOWN = 10 * 1000

@Controller('/v1/game')
class GameController {
  constructor() {
    addTxEventListener(Instruction.Play, this.#handlePlayConfirmed)
  }

  async #handlePlayConfirmed(accounts: PublicKey[], data: Uint8Array) {
    const owner = accounts[0].toBase58()
    const boardId = Buffer.from(data.slice(0, 16)).toString('hex')
    const seatKey = await r.hget(`owner:${owner}`, boardId)
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
    await r.setJSON(`seat:${seatKey}`, seat)
  }

  @Get('/:boardId/enter')
  async enter(ctx: Ctx) {
    const board = await cBoards.findOne({ id: ctx.params['boardId'] })
    if (!board) {
      throw new Http404('Board does not exist')
    }

    let owner: string | null = null
    try {
      await auth(ctx)
      owner = ctx.profile.address
      // deno-lint-ignore no-empty
    } catch (_) {}

    // Create consumer to consume global states
    const sessionId = Math.random().toString(36).slice(2)
    await nats.jsm().consumers.add(`state_${board.id}`, {
      name: sessionId,
      durable_name: sessionId,
      filter_subject: `states.${board.id}`,
      ack_policy: AckPolicy.None,
      deliver_policy: DeliverPolicy.Last,
      inactive_threshold: 1000000000 * 60 * 10, // nanosecond
    })

    const seatKey = await r.hget(`owner:${owner}`, 'seatKey')
    if (seatKey) {
      const seat = await r.getJSON<Seat>(`seat:${seatKey}`)
      if (seat) {
        return { sessionId, seatKey, seat }
      }
    }
    return { sessionId }
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
      chips: payload.chips.toString(),
      playerId: player._id.toString(),
      owner,
      status: 'unready',
    })
    await r.hset(`owner:${owner}`, board.id, seatKey)

    // Create seat message consumer
    await nats.jsm().consumers.add(`seat_${board.id}`, {
      name: seatKey,
      durable_name: seatKey,
      filter_subject: `seats.${seatKey}`,
      ack_policy: AckPolicy.Explicit,
    })

    return {
      tx: encodeBase64(tx.serialize()),
      seatKey,
      playerId: player._id.toString(),
    }
  }

  /**
   * Publish game state to all players
   */
  async #sync(boardId: string) {
    // Get needed data
    const pl = r.pipeline()
    pl.hgetall(`board:${boardId}:seats`)
    pl.llen(`board:${boardId}:cards`)
    pl.get(`board:${boardId}:cursor`)
    pl.get(`board:${boardId}:pot`)
    const [seatStates, deckCount, cursor, pot] = await pl.flush()

    const cursorState = JSON.parse(cursor as string) as CursorState
    const seatState = (await r.hgetJSON(
      `board:${boardId}:seats`,
      cursorState.seatKey
    )) as SeatState
    const gameState: GameState = {
      seats: [],
      deckCount: deckCount as number,
      turn: seatState.playerId,
      turnExpireAt: cursorState.expireAt,
      pot: pot as string,
    }

    const states = seatStates as string[]
    for (let i = 0; i < states.length; i += 2) {
      const state = JSON.parse(states[i + 1]) as SeatState
      gameState.seats.push({
        playerId: state.playerId,
        hands: state.hands ? INITIAL_HANDS : undefined,
        chips: state.chips,
      })
    }

    await nats.js().publish(
      `states.${boardId}`,
      JSON.stringify({
        code: GameCode.Sync,
        gameState,
      })
    )
  }

  /**
   * Deal cards
   */
  async #deal(boardId: string) {
    const pl = r.pipeline()
    const js = nats.js()

    // Deal each player two cards
    const cards = shuffle()
    const states = await r.hgetall(`board:${boardId}:seats`)
    const messages: { subj: string; payload: string }[] = []
    for (let i = 0; i < states.length; i += 2) {
      const seatKey = states[i]
      const hands = [cards.shift(), cards.shift()] as [number, number]
      const state = JSON.parse(states[i + 1]) as SeatState
      state.hands = hands
      pl.hset(`board:${boardId}:seats`, seatKey, JSON.stringify(state))
      messages.push({
        subj: `seats.${boardId}.${seatKey}`,
        payload: JSON.stringify({ hands }),
      })
    }

    // Update deck
    pl.del(`board:${boardId}:cards`)
    pl.lpush(`board:${boardId}:cards`, ...cards)

    // Set next turn
    pl.setex(
      `board:${boardId}:cursor`,
      COUNTDOWN,
      JSON.stringify({
        seatKey: states[0],
        expireAt: Date.now() + COUNTDOWN,
      })
    )

    await pl.flush()
    for (const message of messages) {
      js.publish(message.subj, message.payload)
    }
    this.#sync(boardId)
  }

  @Post('/sit')
  @SeatSession(ReadyPayloadSchema)
  async sit(seat: Seat, payload: ReadyPayload) {
    const { boardId } = seat

    // Insert seat
    await r.hsetJSON(`board:${boardId}:seats`, payload.seatKey, {
      playerId: seat.playerId,
      chips: seat.chips,
    })

    // Update seat status
    seat.status = 'playing'
    await r.setJSON(`seat:${payload.seatKey}`, seat)

    // Check if enough players
    const len = await r.hlen(`board:${boardId}:seats`)
    const roundCount = await r.get(`board:${boardId}:roundCount`)
    if (len >= 2 && !roundCount) {
      // Start game
      this.#deal(boardId)
    } else {
      this.#sync(boardId)
    }
  }

  @Post('/turn')
  @SeatSession(TurnPayloadSchema)
  async turn(seat: Seat, payload: TurnPayload) {
    const { seatKey, bet } = payload
    const { boardId, playerId } = seat

    // Get needed data
    const pl = r.pipeline()
    pl.get(`board:${boardId}:cursor`)
    pl.hget(`board:${boardId}:seats`, seatKey)
    pl.hkeys(`board:${boardId}:seats`)
    pl.get(`board:${boardId}:pot`)
    const [cursor, seatState, seatStateKeys, potStr] = await pl.flush()

    // Check if it's your turn
    const cursorState = JSON.parse(cursor as string) as CursorState
    if (cursorState.seatKey !== seatKey) {
      throw new Http400("It's not your turn")
    }

    const state = JSON.parse(seatState as string) as SeatState
    let pot = BigInt(potStr as string)

    // Check bet
    if (bet > pot) {
      throw new Http400('You can not bet more than pot')
    } else if (bet < BigInt(seat.chips)) {
      throw new Http400('Not enough chips')
    }

    // Lock board to prevent double bet
    const isLocked = await r.setnx(`board:${boardId}:lock`, '1')
    if (!isLocked) {
      throw new Http400('Dont play too fast')
    }

    // Notify other players
    await nats.js().publish(
      `state.${boardId}`,
      JSON.stringify({
        code: GameCode.Turn,
        playerId,
        bet,
      })
    )

    // Get next player
    const seatKeys = seatStateKeys as string[]
    const index = seatKeys.findIndex((key) => key === seatKey)
    const nextIndex = (index + 1) % seatKeys.length

    // Compare hands
    // 1-52: SpadesAce ~ ClubsKing
    if (bet > 0n) {
      const numbers = state
        .hands!.map((n) => ((n - 1) % 13) + 1)
        .sort((a, b) => a - b)
      const card = await r.lpop(`board:${boardId}:cards`)
      const next = ((parseInt(card as string) - 1) % 13) + 1
      if (numbers[0] < next && next < numbers[1]) {
        // You win
        state.chips = (bet + BigInt(state.chips)).toString()
        pot -= bet
      } else {
        // You lose
        state.chips = (BigInt(state.chips) - bet).toString()
        pot += bet
      }

      // Push `Open` message
      await nats.js().publish(
        `state.${boardId}`,
        JSON.stringify({
          code: GameCode.Open,
          playerId: playerId,
          card,
        })
      )
    }

    // Update seat state
    state.hands = undefined
    pl.hset(`board:${boardId}:seats`, seatKey, JSON.stringify(state))

    // Update pot
    pl.set(`board:${boardId}:pot`, pot.toString())

    await pl.flush()

    // Check if this round is over
    if (nextIndex === 0) {
      this.#deal(boardId)
    }

    this.#sync(boardId)
  }
}

export default GameController
