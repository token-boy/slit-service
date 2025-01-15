import { Buffer } from 'node:buffer'
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  Keypair,
} from '@solana/web3.js'
import { encodeBase64 } from '@std/encoding/base64'

import { Controller, Get, Payload, Post } from 'helpers/route.ts'
import { Instruction, PROGRAM_ID, BOARD } from 'helpers/constants.ts'
import { buildTx, connection } from 'helpers/solana.ts'
import { Http400 } from 'helpers/http.ts'
import { encoder, eventEmitter } from 'helpers/game.ts'
import auth from '../middlewares/auth.ts'
import { cBoards, cKeypairs } from 'models'
import { encodeBase58 } from '@std/encoding'
import { z } from 'zod'
import nats from 'helpers/nats.ts'
import { DiscardPolicy, RetentionPolicy } from '@nats-io/jetstream'
import log from "helpers/log.ts";

const CreatePayloadSchama = z.object({
  minChips: z.number(),
})
type CreatePayload = z.infer<typeof CreatePayloadSchama>

@Controller('/v1/boards')
class BoardController {
  constructor() {
    eventEmitter.on(
      `tx-confirmed-${Instruction.Create}`,
      this.#handleCreateConfirmed
    )
  }

  #handleCreateConfirmed(_accounts: PublicKey[], data: Uint8Array) {
    try {
      const id = Buffer.from(data).toString('hex')
      cBoards.updateOne(
        { id },
        {
          $set: {
            enabled: true,
          },
        }
      )
      
      // Global state stream
      nats.jsm().streams.add({
        name: `state_${id}`,
        subjects: ['states.*'],
        max_bytes: -1,
        retention: RetentionPolicy.Limits,
        discard: DiscardPolicy.Old,
      })

      // Seat stream
      nats.jsm().streams.add({
        name: `seat_${id}`,
        subjects: ['seats.*'],
        max_bytes: -1,
        retention: RetentionPolicy.Workqueue,
      })
    } catch (error) {
      log.error(error)
    }
  }

  @Post('', auth)
  @Payload(CreatePayloadSchama)
  async create(payload: CreatePayload, ctx: Ctx) {
    const signer = new PublicKey(ctx.profile.address)

    const uuid = crypto.randomUUID().replace(/-/g, '')
    const boardId = Uint8Array.from(Buffer.from(uuid, 'hex'))
    const boardAddress = PublicKey.findProgramAddressSync(
      [encoder.encode(BOARD), boardId],
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
      chips: 0,
      dealer: dealer.publicKey.toBase58(),
      creator: ctx.profile.address,
      minChips: payload.minChips,
      enabled: false,
    })

    return {
      tx: encodeBase64(tx.serialize()),
      boardId: uuid,
    }
  }

  @Get()
  boards() {
    return cBoards
      .find({ enabled: true })
      .project({ id: 1, address: 1, chips: 1, minChips: 1 })
      .toArray()
  }
}

export default BoardController
