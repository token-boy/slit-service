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
  Cursor,
  publishGameState,
} from 'helpers/game.ts'
import { decodeBase58, encodeBase64 } from '@std/encoding'
import { buildTx, sleep } from 'helpers/solana.ts'
import { r, rSub } from 'helpers/redis.ts'
import { auth } from 'middlewares'

import { addTxEventListener } from './TxController.ts'
import log from 'helpers/log.ts'

const PlayPayloadSchema = z.object({
  chips: z.bigint({ coerce: true }).gt(0n),
})
type PlayPayload = z.infer<typeof PlayPayloadSchema>

const ReadyPayloadSchema = z.object({
  seatKey: z.string(),
})
type ReadyPayload = z.infer<typeof ReadyPayloadSchema>

const BetPayloadSchema = z.object({
  seatKey: z.string(),
  bet: z.bigint({ coerce: true }).nonnegative(),
})
type BetPayload = z.infer<typeof BetPayloadSchema>

const INITIAL_HANDS: [number, number] = [0, 0]
const COUNTDOWN = 30

@Controller('/v1/game')
class GameController {
  constructor() {
    addTxEventListener(Instruction.Play, this.#handlePlayConfirmed)
    this.#handleTimerExpired()
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

  async #handleTimerExpired() {
    await rSub.subscribe('__keyevent@0__:expired')
    rSub.on('message', async (_channel, message) => {
      try {
        const [_, boardId, timer] = message.split(':')
        if (timer !== 'timer') {
          return
        }
        const cursor = await r.getJSON<Cursor>(`board:${boardId}:cursor`)
        if (!cursor) {
          const len = await r.hlen(`board:${boardId}:seats`)
          if (len >= 2) {
            this.#deal(boardId)
          } else {
            await r.setex(`board:${boardId}:timer`, COUNTDOWN, '0')
          }
          return
        }
        const seat = await r.getJSON<Seat>(`seat:${cursor.seatKey}`)
        if (!seat) {
          return
        }
        this.#turn(cursor.seatKey, seat, 0n)
      } catch (error) {
        log.error(error)
      }
    })
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
    const boardId = board.id
    const player = await cPlayers.findOne({ owner })
    if (!player) {
      throw new Http404('Player does not exist')
    }

    if ((await r.hlen(`board:${boardId}:players`)) > MAX_PLAYERS) {
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
        ...Buffer.from(boardId, 'hex'),
        ...U64.toUint8Array(payload.chips),
      ]),
    })

    const tx = await buildTx(signer, [ix])
    tx.sign([dealer])

    // Create seat session
    const seatKey = Math.random().toString(36).slice(2)
    await r.setJSON<Seat>(`seat:${seatKey}`, {
      boardId,
      chips: payload.chips.toString(),
      playerId: player._id.toString(),
      owner,
      status: 'unready',
    })
    await r.hset(`owner:${owner}`, boardId, seatKey)

    // Create seat message consumer
    await nats.jsm().consumers.add(`seat_${boardId}`, {
      name: seatKey,
      durable_name: seatKey,
      filter_subject: `seats.${boardId}.${seatKey}`,
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

    const gameState: GameState = {
      seats: [],
      deckCount: deckCount as number,
      pot: pot as string,
    }

    if (cursor) {
      const cursorState = JSON.parse(cursor as string) as Cursor
      const seatState = await r.hgetJSON<SeatState>(
        `board:${boardId}:seats`,
        cursorState.seatKey
      )
      // FIXME : seatState maybe null
      gameState.turn = seatState!.playerId
      gameState.turnExpireAt = cursorState.expireAt
    }

    for (const seatState of Object.values(seatStates as Dict<string>)) {
      const state = JSON.parse(seatState) as SeatState
      gameState.seats.push({
        playerId: state.playerId,
        hands: state.hands ? INITIAL_HANDS : undefined,
        chips: state.chips,
      })
    }

    await publishGameState(boardId, gameState)
  }

  /**
   * Deal cards
   */
  async #deal(boardId: string) {
    const pl = r.pipeline()
    const js = nats.js()

    // Min bet
    const board = await cBoards.findOne({ id: boardId })
    if (!board) {
      return
    }
    const bet = BigInt(board.minChips)

    // Get needed data
    pl.hgetall(`board:${boardId}:seats`)
    pl.get(`board:${boardId}:pot`)
    const [states, potStr] = await pl.flush<[Dict<string>, string]>()
    let pot = BigInt(potStr)
    const messages: { subj: string; payload: string }[] = []

    // Deal each player two cards
    const cards = shuffle()
    for (const seatKey in states) {
      // Remove players who don't have enough chips
      const state = JSON.parse(states[seatKey]) as SeatState
      if (BigInt(state.chips) < bet) {
        pl.hdel(`board:${boardId}:seats`, seatKey)
        pl.hset(`board:${boardId}:breaks`, JSON.stringify(state))
        continue
      }

      // Give each player two cards
      const hands = [cards.shift(), cards.shift()] as [number, number]
      state.hands = hands
      state.chips = (BigInt(state.chips) - bet).toString()
      pot += bet
      pl.hset(`board:${boardId}:seats`, seatKey, JSON.stringify(state))
      messages.push({
        subj: `seats.${boardId}.${seatKey}`,
        payload: JSON.stringify({ code: GameCode.Deal, hands }),
      })
    }

    // Update deck, pot, and round
    pl.del(`board:${boardId}:cards`)
    pl.lpush(`board:${boardId}:cards`, ...cards)
    pl.set(`board:${boardId}:pot`, pot.toString())
    pl.incr(`board:${boardId}:roundCount`)
    await pl.exec()

    // Set next turn
    const nextTurn = Object.keys(states)[0]
    await this.#setNextTurn(boardId, nextTurn)

    // Publish each player their hands.
    for (const message of messages) {
      js.publish(message.subj, message.payload)
    }

    await this.#sync(boardId)
  }

  #setNextTurn(boardId: string, seatKey: string) {
    const pl = r.pipeline()
    pl.setex(`board:${boardId}:timer`, COUNTDOWN, seatKey)
    pl.set(
      `board:${boardId}:cursor`,
      JSON.stringify({
        seatKey,
        expireAt: Date.now() + COUNTDOWN * 1000,
      })
    )
    return pl.exec()
  }

  async #turn(seatKey: string, seat: Seat, bet: bigint) {
    const { boardId, playerId } = seat

    // Get needed data
    const pl = r.pipeline()
    pl.hget(`board:${boardId}:seats`, seatKey)
    pl.hkeys(`board:${boardId}:seats`)
    pl.get(`board:${boardId}:pot`)
    const [seatState, seatStateKeys, potStr] = await pl.flush()

    const state = JSON.parse(seatState as string) as SeatState
    let pot = BigInt(potStr as string)

    // Check bet
    if (bet > pot) {
      throw new Http400('You can not bet more than pot')
    } else if (bet > BigInt(seat.chips)) {
      throw new Http400('Not enough chips')
    }
    const isOpen = bet > 0n

    // Lock board to prevent double bet
    // const isLocked = await r.setnx(`board:${boardId}:lock`, '1')
    // if (!isLocked) {
    //   throw new Http400('Dont play too fast')
    // }

    // Notify other players
    await nats.js().publish(
      `states.${boardId}`,
      JSON.stringify({
        code: GameCode.Bet,
        playerId,
        bet,
        hands: isOpen ? state.hands : INITIAL_HANDS,
      })
    )

    // Get next player
    const seatKeys = seatStateKeys as string[]
    const index = seatKeys.findIndex((key) => key === seatKey)
    const nextIndex = (index + 1) % seatKeys.length

    // Compare hands
    // 1-52: SpadesAce ~ ClubsKing
    if (isOpen) {
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
        `states.${boardId}`,
        JSON.stringify({
          code: GameCode.Open,
          playerId: playerId,
          card: parseInt(card as string),
        })
      )
    }

    // Update seat state
    state.hands = undefined
    pl.hset(`board:${boardId}:seats`, seatKey, JSON.stringify(state))

    // Update pot
    pl.set(`board:${boardId}:pot`, pot.toString())

    await pl.exec()

    // Delay 3000ms ensure everyone has received the `Open` message
    ;(async () => {
      await sleep(isOpen ? 3000 : 0)

      // Check if this round is over
      if (nextIndex === 0) {
        await this.#deal(boardId)
      } else {
        await this.#setNextTurn(boardId, seatKeys[nextIndex])
        await this.#sync(boardId)
      }
    })()
  }

  // TODO : breaks resume
  // async resume() {}

  @Post('/sit')
  @SeatSession(ReadyPayloadSchema)
  async sit(seat: Seat, payload: ReadyPayload) {
    const { boardId } = seat
    const { seatKey } = payload

    // Check if player has enough chips
    const board = await cBoards.findOne({ id: boardId })
    if (!board) {
      throw new Http404('Board does not exist')
    }
    if (BigInt(seat.chips) < BigInt(board.minChips)) {
      throw new Http400(`You must stake more than ${board.minChips} chips`)
    }

    // Check if player is already in the game
    const isExist = !!(await r.hget(`board:${boardId}:seats`, seatKey))
    if (isExist) {
      throw new Http400('You are already in the game')
    }

    // Insert seat
    await r.hsetJSON(`board:${boardId}:seats`, seatKey, {
      playerId: seat.playerId,
      chips: seat.chips,
    })

    // Update seat status
    seat.status = 'playing'
    await r.setJSON(`seat:${seatKey}`, seat)

    await this.#sync(boardId)
  }

  @Post('/bet')
  @SeatSession(BetPayloadSchema)
  async bet(seat: Seat, payload: BetPayload) {
    // Check if it's your turn
    const cursor = await r.getJSON<Cursor>(`board:${seat.boardId}:cursor`)
    if (!cursor || cursor.seatKey !== payload.seatKey) {
      throw new Http400("It's not your turn")
    }

    return this.#turn(payload.seatKey, seat, payload.bet)
  }
}

export default GameController
