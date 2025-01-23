import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { AckPolicy, DeliverPolicy } from '@nats-io/jetstream'
import { decodeBase58, encodeBase64 } from '@std/encoding'

import nats from 'helpers/nats.ts'
import { Controller, Get, Payload, Post } from 'helpers/route.ts'
import { BillType, cBills, cBoards, cKeypairs, cPlayers } from 'models'
import { Http400, Http404 } from 'helpers/http.ts'
import { Instruction, MAX_PLAYERS, PROGRAM_ID } from 'helpers/constants.ts'
import {
  type Seat,
  shuffle,
  U64,
  type GameState,
  GameCode,
  publishGameState,
  uiAmount,
} from 'helpers/game.ts'
import { buildTx, sleep } from 'helpers/solana.ts'
import { r, rSub } from 'helpers/redis.ts'
import log from 'helpers/log.ts'
import { auth } from 'middlewares'

import { addTxEventListener } from './TxController.ts'

const StakePayloadSchema = z.object({
  chips: z.bigint({ coerce: true }).gt(0n),
  seatKey: z.string().optional(),
})
type StakePayload = z.infer<typeof StakePayloadSchema>

const BetPayloadSchema = z.object({
  seatKey: z.string(),
  bet: z.bigint({ coerce: true }).nonnegative(),
})
type BetPayload = z.infer<typeof BetPayloadSchema>

const INITIAL_HANDS: [number, number] = [0, 0]
const COUNTDOWN = 30 // seconds
const BIGINT_TWO = BigInt(2)

@Controller('/v1/game')
class GameController {
  constructor() {
    addTxEventListener(Instruction.Stake, this.#handleStakeConfirmed.bind(this))
    this.#handleTimerExpired()
  }

  async #handleStakeConfirmed(accounts: PublicKey[], data: Uint8Array) {
    const owner = accounts[0].toBase58()
    const boardId = Buffer.from(data.slice(0, 16)).toString('hex')
    const chips = Buffer.from(data.slice(16)).readBigUint64LE()

    const board = await cBoards.findOne({ id: boardId })
    if (!board) {
      return
    }
    const seatKey = await r.hget(`owner:${owner}`, boardId)
    if (!seatKey) {
      return
    }
    const seat = await r.getJSON<Seat>(`board:${boardId}:seat:${seatKey}`)
    if (!seat) {
      return
    }

    // Update player chips
    seat.chips = (BigInt(seat.chips) + chips).toString()
    await cBills.insertOne({
      owner,
      type: BillType.Stake,
      amount: chips.toString(),
      boardId,
      createdAt: Date.now(),
    })

    // Update board chips
    board.chips = (BigInt(board.chips) + chips).toString()
    await cBoards.updateOne(
      { id: boardId },
      { $set: { chips: (BigInt(board.chips) + chips).toString() } }
    )

    // If player has staked enough chips, then add them to the players queue
    if (BigInt(seat.chips) > BigInt(board.limit) * BIGINT_TWO) {
      await r.zadd(`board:${boardId}:seats`, Date.now(), seatKey)
    }

    await r.setJSON(`board:${boardId}:seat:${seatKey}`, seat)
    this.#sync(boardId)
  }

  async #handleTimerExpired() {
    await rSub.subscribe('__keyevent@0__:expired')
    rSub.on('message', async (_channel, message) => {
      try {
        const [_, boardId, timer] = message.split(':')
        if (timer !== 'timer') {
          return
        }
        const turnSeatKey = await r.lindex(`board:${boardId}:round`, 0)
        if (!turnSeatKey) {
          const len = await r.zcount(`board:${boardId}:seats`, 0, Date.now())
          if (len >= 2) {
            this.#deal(boardId)
          } else {
            await r.setex(`board:${boardId}:timer`, COUNTDOWN, '0')
          }
          return
        }
        const seat = await r.getJSON<Seat>(
          `board:${boardId}:seat:${turnSeatKey}`
        )
        if (!seat) {
          return
        }
        this.#turn(boardId, turnSeatKey, 0n)
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

  @Post('/:boardId/stake', auth)
  @Payload(StakePayloadSchema)
  async stake(payload: StakePayload, ctx: Ctx) {
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

    // Check if player staked enough chips
    const minAmount = BigInt(board.limit) * BIGINT_TWO
    if (BigInt(payload.chips) < minAmount) {
      throw new Http400(`You must stake more than ${uiAmount(minAmount)} chips`)
    }

    // Check if board is full
    if (
      (await r.zcount(`board:${boardId}:seats`, 0, Date.now())) > MAX_PLAYERS
    ) {
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
        Instruction.Stake,
        ...Buffer.from(boardId, 'hex'),
        ...U64.toUint8Array(payload.chips),
      ]),
    })

    const tx = await buildTx(signer, [ix])
    tx.sign([dealer])

    let seatKey = payload.seatKey
    if (!seatKey) {
      // Create seat session
      seatKey = Math.random().toString(36).slice(2)
      await r.setJSON<Seat>(`board:${boardId}:seat:${seatKey}`, {
        owner,
        playerId: player._id.toString(),
        chips: '0',
      })
      await r.hset(`owner:${owner}`, boardId, seatKey)

      // Create seat message consumer
      await nats.jsm().consumers.add(`seat_${boardId}`, {
        name: seatKey,
        durable_name: seatKey,
        filter_subject: `seats.${boardId}.${seatKey}`,
        ack_policy: AckPolicy.Explicit,
      })
    }

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
    let pl = r.pipeline()
    pl.zrange(`board:${boardId}:seats`, 0, -1)
    pl.llen(`board:${boardId}:cards`)
    pl.get(`board:${boardId}:pot`)
    pl.lindex(`board:${boardId}:round`, 0)
    pl.get(`board:${boardId}:timer`)
    const [seatKeys, deckCount, pot, turnSeatKey, turnExpireAt] =
      await pl.flush()
    pl = r.pipeline()
    for (const seatKey of seatKeys) {
      pl.get(`board:${boardId}:seat:${seatKey}`)
    }
    const seats = (await pl.flush<string[]>()).reduce((acc, seat, i) => {
      acc[seatKeys[i]] = JSON.parse(seat)
      return acc
    }, {}) as Dict<Seat>

    const state: GameState = {
      seats: Object.values(seats).map((seat) => ({
        playerId: seat.playerId,
        hands: seat.hands ? INITIAL_HANDS : undefined,
        chips: seat.chips,
      })),
      deckCount: deckCount as number,
      pot: pot as string,
    }

    if (turnSeatKey && seats[turnSeatKey]) {
      state.turn = seats[turnSeatKey].playerId
      state.turnExpireAt = turnExpireAt
    }

    await publishGameState(boardId, state)
  }

  /**
   * Deal cards
   */
  async #deal(boardId: string) {
    let pl = r.pipeline()
    const js = nats.js()

    // Get needed data
    pl.zrange(`board:${boardId}:seats`, 0, -1)
    pl.hgetall(`board:${boardId}:settings`)
    pl.get(`board:${boardId}:pot`)
    const [seatKeys, settings, potStr] = await pl.flush<
      [string[], Dict<string>, string]
    >()
    pl = r.pipeline()
    for (const seatKey of seatKeys) {
      pl.get(`board:${boardId}:seat:${seatKey}`)
    }
    const seats = (await pl.flush<string[]>()).reduce((acc, seat, i) => {
      acc[seatKeys[i]] = JSON.parse(seat)
      return acc
    }, {}) as Dict<Seat>
    pl = r.pipeline()

    let pot = BigInt(potStr)
    const bet = BigInt(settings['limit'])
    const messages: { subj: string; payload: string }[] = []

    // Deal each player two cards
    const cards = shuffle()
    for (const [seatKey, seat] of Object.entries(seats)) {
      // Remove players who don't have enough chips
      if (BigInt(seat.chips) < bet * BIGINT_TWO) {
        pl.zrem(`board:${boardId}:seats`, seatKey)
        continue
      }

      // Give each player two cards
      const hands = [cards.shift(), cards.shift()] as [number, number]
      seat.hands = hands
      seat.chips = (BigInt(seat.chips) - bet).toString()
      pot += bet
      pl.set(`board:${boardId}:seat:${seatKey}`, JSON.stringify(seat))
      pl.rpush(`board:${boardId}:round`, seatKey)
      messages.push({
        subj: `seats.${boardId}.${seatKey}`,
        payload: JSON.stringify({ code: GameCode.Deal, hands }),
      })
    }

    // Update deck, pot, round and timer
    pl.del(`board:${boardId}:cards`)
    pl.lpush(`board:${boardId}:cards`, ...cards)
    pl.set(`board:${boardId}:pot`, pot.toString())
    pl.incr(`board:${boardId}:roundCount`)
    pl.setex(`board:${boardId}:timer`, COUNTDOWN, Date.now() + COUNTDOWN * 1000)
    await pl.flush()

    // Publish each player their hands.
    for (const message of messages) {
      js.publish(message.subj, message.payload)
    }

    await this.#sync(boardId)
  }

  async #turn(boardId: string, seatKey: string, bet: bigint) {
    // Get needed data
    let pl = r.pipeline()
    pl.get(`board:${boardId}:seat:${seatKey}`)
    pl.lindex(`board:${boardId}:round`, 1)
    pl.get(`board:${boardId}:pot`)
    const [seatStr, nextTurnSeatKey, potStr] = await pl.flush()
    pl = r.pipeline()

    const seat = JSON.parse(seatStr) as Seat
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
        playerId: seat.playerId,
        bet,
        hands: isOpen ? seat.hands : INITIAL_HANDS,
      })
    )

    // Compare hands
    // 1-52: SpadesAce ~ ClubsKing
    if (isOpen) {
      const numbers = seat
        .hands!.map((n) => ((n - 1) % 13) + 1)
        .sort((a, b) => a - b)
      const card = await r.lpop(`board:${boardId}:cards`)
      const next = ((parseInt(card as string) - 1) % 13) + 1
      if (numbers[0] < next && next < numbers[1]) {
        // You win
        seat.chips = (bet + BigInt(seat.chips)).toString()
        pot -= bet
      } else {
        // You lose
        seat.chips = (BigInt(seat.chips) - bet).toString()
        pot += bet
      }

      // Push `Open` message
      await nats.js().publish(
        `states.${boardId}`,
        JSON.stringify({
          code: GameCode.Open,
          playerId: seat.playerId,
          card: parseInt(card as string),
        })
      )
    }

    // Update seat state
    seat.hands = undefined
    pl.set(`board:${boardId}:seat:${seatKey}`, JSON.stringify(seat))
    pl.lpop(`board:${boardId}:round`)

    // Update pot
    pl.set(`board:${boardId}:pot`, pot.toString())

    await pl.flush()

    // Delay 3000ms ensure everyone has received the `Open` message
    ;(async () => {
      await sleep(isOpen ? 3000 : 0)

      // Check if this round is over
      if (nextTurnSeatKey) {
        await r.setex(
          `board:${boardId}:timer`,
          COUNTDOWN,
          Date.now() + COUNTDOWN * 1000
        )
        await this.#sync(boardId)
      } else {
        await this.#deal(boardId)
      }
    })()
  }

  @Post('/:boardId/bet')
  @Payload(BetPayloadSchema)
  async bet(payload: BetPayload, ctx: Ctx) {
    const { seatKey, bet } = payload
    const { boardId } = ctx.params

    // Check if it's your turn
    const turnSeatKey = await r.lindex(`board:${boardId}:round`, 0)
    if (seatKey !== turnSeatKey) {
      throw new Http400("It's not your turn")
    }

    return this.#turn(boardId, seatKey, bet)
  }
}

export default GameController
