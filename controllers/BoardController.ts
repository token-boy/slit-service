import { Buffer } from 'node:buffer'
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  Keypair,
} from '@solana/web3.js'
import { encodeBase58, encodeBase64 } from '@std/encoding'

import { Long } from 'mongodb'
import { DiscardPolicy, RetentionPolicy } from '@nats-io/jetstream'
import { z } from 'zod'

import { Controller, Get, Payload, Post, QueryParams } from 'helpers/route.ts'
import { Instruction, PROGRAM_ID, BOARD } from 'helpers/constants.ts'
import { buildTx, connection } from 'helpers/solana.ts'
import { Http400, Http404 } from 'helpers/http.ts'
import { publishGameState, TE } from 'helpers/game.ts'
import auth from '../middlewares/auth.ts'
import { cBoards, cKeypairs } from 'models'
import nats from 'helpers/nats.ts'
import { addTxEventListener } from './TxController.ts'
import { r } from 'helpers/redis.ts'

const CreatePayloadSchama = z.object({
  limit: z.bigint({ coerce: true }).nonnegative(),
})
type CreatePayload = z.infer<typeof CreatePayloadSchama>

const ListPayloadSchama = z.object({
  minPlayers: z.string().optional(),
  limit: z.string().optional(),
  page: z.number({ coerce: true }). nonnegative().default(1),
})
type ListPayload = z.infer<typeof ListPayloadSchama>

@Controller('/v1/boards')
class BoardController {
  constructor() {
    addTxEventListener(Instruction.Create, this.#handleCreateConfirmed)
  }

  async #handleCreateConfirmed(
    _accounts: PublicKey[],
    data: Uint8Array,
    signatures: string[]
  ) {
    const id = Buffer.from(data).toString('hex')

    const board = await cBoards.findOne({ id })
    if (!board) {
      throw new Http400('Board already exists')
    }

    // Enable board
    await cBoards.updateOne(
      { id },
      {
        $set: {
          confirmed: true,
          signature: signatures[0],
        },
      }
    )

    // Initialize redis state
    const pl = r.pipeline()
    pl.lpush(`board:${id}:cards`, ...Array(52).fill(0))
    pl.set(`board:${id}:pot`, '0')
    pl.set(`board:${id}:roundCount`, '0')
    pl.hset(`board:${id}:settings`, 'limit', board.limit)
    await pl.exec()

    // Global state stream
    await nats.jsm().streams.add({
      name: `state_${id}`,
      subjects: [`states.${id}`],
      max_bytes: -1,
      retention: RetentionPolicy.Limits,
      discard: DiscardPolicy.Old,
    })

    // Publish initial state
    await publishGameState(id, {
      seats: [],
      deckCount: 52,
      pot: '0',
    })
  }

  @Post('', auth)
  @Payload(CreatePayloadSchama)
  async create(payload: CreatePayload, ctx: Ctx) {
    const signer = new PublicKey(ctx.profile.address)

    const uuid = crypto.randomUUID().replace(/-/g, '')
    const boardId = Uint8Array.from(Buffer.from(uuid, 'hex'))
    const boardAddress = PublicKey.findProgramAddressSync(
      [TE.encode(BOARD), boardId],
      PROGRAM_ID
    )[0]

    const accountInfo = await connection.getAccountInfo(boardAddress)
    if (accountInfo) {
      throw new Http400('Board already exists')
    }

    const dealer = Keypair.generate()

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: signer, isSigner: true, isWritable: false },
        { pubkey: dealer.publicKey, isSigner: true, isWritable: false },
        { pubkey: boardAddress, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([Instruction.Create, ...boardId]),
    })
    const tx = await buildTx(signer, [ix])
    tx.sign([dealer])

    await cKeypairs.insertOne({
      publicKey: dealer.publicKey.toBase58(),
      secretKey: encodeBase58(dealer.secretKey),
    })

    await cBoards.insertOne({
      id: uuid,
      address: boardAddress.toBase58(),
      chips: '0',
      players: 0,
      dealer: dealer.publicKey.toBase58(),
      creator: ctx.profile.address,
      limit: payload.limit.toString(),
      confirmed: false,
      createdAt: Date.now(),
    })

    return {
      tx: encodeBase64(tx.serialize()),
      boardId: uuid,
    }
  }

  @Get()
  @QueryParams(ListPayloadSchama)
  async boards(payload: ListPayload) {
    const filter = {
      confirmed: true,
      players: { $gte: parseInt(payload.minPlayers ?? '0') },
      $expr: {
        $gte: [{ $toLong: '$limit' }, new Long(payload.limit ?? '0')],
      },
    }

    const boards = await cBoards
      .find(filter)
      .project({
        id: 1,
        address: 1,
        chips: 1,
        limit: 1,
        players: 1,
        createdAt: 1,
      })
      .sort({ _id: -1 })
      .skip((payload.page - 1) * 20)
      .limit(20)
      .toArray()
    const total = await cBoards.countDocuments(filter)

    return { boards, total }
  }

  @Get('/:id')
  async findById(ctx: Ctx) {
    const board = await cBoards.findOne(
      {
        id: ctx.params.id,
        confirmed: true,
      },
      { projection: { limit: 1 } }
    )
    if (!board) {
      throw new Http404('Board does not exist')
    }

    return board
  }
}

export default BoardController
