import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { AckPolicy, DeliverPolicy } from '@nats-io/jetstream'
import { decodeBase58, encodeBase58, encodeBase64 } from '@std/encoding'

import nats from 'helpers/nats.ts'
import { Controller, Get, Payload, Post } from 'helpers/route.ts'
import { Bill, BillType, cBills, cBoards, cKeypairs, cPlayers } from 'models'
import { Http400, Http404 } from 'helpers/http.ts'
import {
  COUNTDOWN,
  FEE_RATE,
  HOSTNAME,
  Instruction,
  MAX_PLAYERS,
  PROGRAM_ID,
} from 'helpers/constants.ts'
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
import { FEE_VAULT_PDA } from 'helpers/constants.ts'
import { WithId } from 'mongodb'

const StakePayloadSchema = z.object({
  seatKey: z.string().optional(),
  chips: z.bigint({ coerce: true }).gt(0n),
})
type StakePayload = z.infer<typeof StakePayloadSchema>

const BetPayloadSchema = z.object({
  seatKey: z.string(),
  bet: z.bigint({ coerce: true }).nonnegative(),
})
type BetPayload = z.infer<typeof BetPayloadSchema>

const HandsPayloadSchema = z.object({
  seatKey: z.string(),
})
type HandsPayload = z.infer<typeof HandsPayloadSchema>

const RedeemPayloadSchema = z.object({
  seatKey: z.string(),
  billId: z.string().optional(),
})
type RedeemPayload = z.infer<typeof RedeemPayloadSchema>

const INITIAL_HANDS: [number, number] = [0, 0]
const BIGINT_TWO = BigInt(2)

@Controller('/v1/game')
class GameController {
  #handerName = HOSTNAME
  #nextHanderName = HOSTNAME

  constructor() {
    addTxEventListener(Instruction.Stake, this.#handleStakeConfirmed.bind(this))
    addTxEventListener(
      Instruction.Redeem,
      this.#handleRedeemConfirmed.bind(this)
    )
    this.#handleTimerExpired()
  }

  async #handleStakeConfirmed(
    accounts: PublicKey[],
    data: Uint8Array,
    signatures: string[]
  ) {
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
      confirmed: true,
      signature: signatures[0],
      createdAt: Date.now(),
    })

    // Update board chips
    board.chips = (BigInt(board.chips) + chips).toString()
    await cBoards.updateOne(
      { id: boardId },
      {
        $set: { chips: (BigInt(board.chips) + chips).toString() },
        $inc: { players: 1 },
      }
    )

    // If player has staked enough chips, then add them to the players queue
    if (BigInt(seat.chips) >= BigInt(board.limit) * BIGINT_TWO) {
      await r.zadd(`board:${boardId}:seats`, Date.now(), seatKey)
    }

    await r.setJSON(`board:${boardId}:seat:${seatKey}`, seat)
    this.#sync(boardId)
  }

  async #handleTimerExpired() {
    await rSub.subscribe('__keyevent@0__:expired', 'deployment')
    rSub.on('message', async (channel, message) => {
      // New instance online
      if (channel === 'deployment') {
        this.#nextHanderName = message
        console.log(`New instance online: ${message}`);
        
      } else if (channel === '__keyevent@0__:expired') {
        try {
          const [_, boardId, handerName, timer] = message.split(':')
          if (handerName !== this.#handerName || timer !== 'timer') {
            return
          }
          const [turnSeatKey] = await r.zrange(`board:${boardId}:round`, 0, 0)
          if (!turnSeatKey) {
            const len = await r.zcount(`board:${boardId}:seats`, 0, Date.now())
            if (len >= 2) {
              this.#deal(boardId)
            } else {
              console.log(`expired: ${this.#nextHanderName}`);
              
              await r.setex(
                `board:${boardId}:${this.#nextHanderName}:timer`,
                COUNTDOWN,
                '0'
              )
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
      }
    })
    await r.publish('deployment', this.#handerName)
  }

  async #handleRedeemConfirmed(
    accounts: PublicKey[],
    data: Uint8Array,
    signatures: string[]
  ) {
    const owner = accounts[0].toBase58()
    const chips = Buffer.from(data.slice(16)).readBigUint64LE()

    // Update player chips
    const player = await cPlayers.findOne({ owner })
    if (!player) {
      return
    }
    await cPlayers.updateOne(
      { owner },
      { $set: { chips: (BigInt(player.chips) + BigInt(chips)).toString() } }
    )

    await cBills.updateOne(
      { signature: signatures[1] },
      { $set: { signature: signatures[0], confirmed: true } }
    )
  }

  @Get('/:boardId/enter')
  async enter(ctx: Ctx) {
    const { boardId } = ctx.params
    const board = await cBoards.findOne(
      { id: boardId },
      {
        projection: ['limit'],
      }
    )
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
    await nats.jsm().consumers.add(`state_${boardId}`, {
      name: sessionId,
      durable_name: sessionId,
      filter_subject: `states.${boardId}`,
      ack_policy: AckPolicy.None,
      deliver_policy: DeliverPolicy.Last,
      inactive_threshold: 1000000000 * 60 * 10, // nanosecond
    })

    const seatKey = await r.hget(`owner:${owner}`, boardId)
    if (seatKey) {
      const seat = await r.getJSON<Seat>(`board:${boardId}:seat:${seatKey}`)
      if (seat) {
        return {
          sessionId,
          seatKey,
          seat,
          board,
        }
      }
    }
    return { sessionId, board }
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
    pl.zrange(`board:${boardId}:round`, 0, 0)
    pl.get(`board:${boardId}:${this.#handerName}:timer`)
    const [seatKeys, deckCount, pot, [turnSeatKey], turnExpireAt] =
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
    // Get needed data
    let pl = r.pipeline()
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
    const potIsEmpty = pot === 0n
    const bet = BigInt(settings['limit'])

    // Deal each player two cards
    const cards = shuffle()
    let index = 0
    for (const [seatKey, seat] of Object.entries(seats)) {
      // Remove players who don't have enough chips
      if (BigInt(seat.chips) < bet * BIGINT_TWO) {
        pl.zrem(`board:${boardId}:seats`, seatKey)
        continue
      }

      // Give each player two cards
      const hands = [cards.shift(), cards.shift()] as [number, number]
      seat.hands = hands

      // When the pot is empty, each player should place `limit` chips.
      if (potIsEmpty) {
        seat.chips = (BigInt(seat.chips) - bet).toString()
        pot += bet
      }

      pl.set(`board:${boardId}:seat:${seatKey}`, JSON.stringify(seat))
      pl.zadd(`board:${boardId}:round`, index++, seatKey)
    }

    // Update deck, pot, round and timer
    pl.del(`board:${boardId}:cards`)
    pl.lpush(`board:${boardId}:cards`, ...cards)
    pl.set(`board:${boardId}:pot`, pot.toString())
    pl.incr(`board:${boardId}:roundCount`)
    pl.setex(
      `board:${boardId}:${this.#nextHanderName}:timer`,
      COUNTDOWN,
      Date.now() + COUNTDOWN * 1000
    )
    await pl.flush()

    await this.#sync(boardId)
  }

  /**
   * Handle player's turn.
   * There are two scenarios where this method is called:
   *  1. The player actively places a bet.
   *  2. The countdown expires, bet will be zero.
   * If the bet is zero, it represents a fold.
   *
   * @param boardId The ID of the board
   * @param seatKey The key of the player's seat
   * @param bet The amount of chips the player bets
   */
  async #turn(boardId: string, seatKey: string, bet: bigint) {
    // Lock player to prevent double bet
    const lockKey = `board:${boardId}:lock:${seatKey}`
    const locked = await r.setnx(lockKey, '1')
    if (!locked) {
      throw new Http400('Dont play too fast')
    }
    try {
      // Get needed data
      let pl = r.pipeline()
      pl.get(`board:${boardId}:seat:${seatKey}`)
      pl.get(`board:${boardId}:pot`)
      const [seatStr, potStr] = await pl.flush()
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
      pl.zpopmin(`board:${boardId}:round`, 1)

      // Update pot
      pl.set(`board:${boardId}:pot`, pot.toString())

      await pl.flush()

      // Delay 2000ms ensure everyone has received the `Open` message
      ;(async () => {
        await sleep(isOpen ? 2000 : 0)
        this.#setNextTurn(boardId)
      })()
    } finally {
      // Unlock board
      await r.del(lockKey)
    }
  }

  async #setNextTurn(boardId: string) {
    const pl = r.pipeline()
    pl.zrange(`board:${boardId}:round`, 0, 0)
    pl.get(`board:${boardId}:pot`)
    const [[seatKey], potStr] = await pl.flush()

    // Check if this round is over
    if (seatKey && BigInt(potStr) > 0n) {
      await r.setex(
        `board:${boardId}:${this.#nextHanderName}:timer`,
        COUNTDOWN,
        Date.now() + COUNTDOWN * 1000
      )
      await this.#sync(boardId)
    } else {
      await this.#sync(boardId)
      await this.#deal(boardId)
    }
  }

  @Post('/:boardId/hands', auth)
  @Payload(HandsPayloadSchema)
  async hands(payload: HandsPayload, ctx: Ctx) {
    const seat = await r.getJSON<Seat>(
      `board:${ctx.params.boardId}:seat:${payload.seatKey}`
    )
    if (!seat) {
      throw new Http400('Seat does not exist')
    }
    return { hands: seat.hands }
  }

  @Post('/:boardId/bet')
  @Payload(BetPayloadSchema)
  async bet(payload: BetPayload, ctx: Ctx) {
    const { seatKey, bet } = payload
    const { boardId } = ctx.params

    // Check if it's your turn
    const [turnSeatKey] = await r.zrange(`board:${boardId}:round`, 0, 0)
    if (seatKey !== turnSeatKey) {
      throw new Http400("It's not your turn")
    }

    return this.#turn(boardId, seatKey, bet)
  }

  @Post('/:boardId/redeem', auth)
  @Payload(RedeemPayloadSchema)
  async redeem(payload: RedeemPayload, ctx: Ctx) {
    const { boardId } = ctx.params
    const { seatKey, billId } = payload

    const owner = ctx.profile.address
    const board = await cBoards.findOne({ id: boardId })
    if (!board) {
      throw new Http404('Board does not exist')
    }
    const player = await cPlayers.findOne({ owner })
    if (!player) {
      throw new Http404('Player does not exist')
    }
    let bill: WithId<Bill> | null = null
    if (billId) {
      bill = await cBills.findOne({
        id: billId,
        owner,
        boardId,
        type: BillType.Redeem,
        confirmed: false,
      })
      if (!bill) {
        throw new Http404('Bill does not exist')
      }
    }
    let seat: Seat | null = null

    // Lock player
    const lockKey = `board:${boardId}:lock:${seatKey}`
    const locked = await r.set(lockKey, '1')
    if (!locked) {
      throw new Http400('Please wait a moment')
    }

    try {
      // Calc fee
      let chips = 0n
      let feeChips = 0n
      if (bill) {
        chips = BigInt(bill.amount)
        if (bill.fee) {
          feeChips = BigInt(bill.fee)
        }
      } else {
        seat = await r.getJSON<Seat>(`board:${boardId}:seat:${seatKey}`)
        if (!seat) {
          throw new Http404('Seat does not exist')
        }
        const balance = BigInt(seat.chips)
        const bills = await cBills
          .find({
            owner,
            type: BillType.Stake,
            boardId: boardId,
            seatKey: seatKey,
          })
          .project({ amount: 1 })
          .toArray()
        const totalAmount = bills.reduce((a, b) => a + BigInt(b.amount), 0n)
        if (balance > totalAmount) {
          feeChips = (balance - totalAmount) / FEE_RATE
        }
        chips = balance - feeChips
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
          { pubkey: FEE_VAULT_PDA, isSigner: false, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: Buffer.from([
          Instruction.Redeem,
          ...Buffer.from(boardId, 'hex'),
          ...U64.toUint8Array(chips),
          ...U64.toUint8Array(feeChips),
        ]),
      })
      const tx = await buildTx(signer, [ix])
      tx.sign([dealer])

      if (!bill) {
        // Remove player from game
        const pl = r.pipeline()

        pl.zrange(`board:${boardId}:round`, 0, 0)
        pl.zrem(`board:${boardId}:round`, seatKey)
        pl.zrem(`board:${boardId}:seats`, seatKey)
        pl.del(`board:${boardId}:seat:${seatKey}`)
        pl.hdel(`owner:${owner}`, boardId)
        const [[turnSeatKey]] = await pl.flush()

        if (turnSeatKey === seatKey) {
          this.#setNextTurn(boardId)
        }

        // Insert bill
        await cBills.insertOne({
          owner,
          type: BillType.Redeem,
          amount: chips.toString(),
          fee: feeChips.toString(),
          boardId,
          seatKey,
          signature: encodeBase58(tx.signatures[1]),
          confirmed: false,
          createdAt: Date.now(),
        })

        // Update board state
        cBoards.updateOne(
          { id: boardId },
          {
            $set: {
              chips: (BigInt(board.chips) - BigInt(seat!.chips)).toString(),
            },
            $inc: { players: -1 },
          }
        )
      }

      return {
        tx: encodeBase64(tx.serialize()),
      }
    } finally {
      await r.del(lockKey)
    }
  }
}

export default GameController
