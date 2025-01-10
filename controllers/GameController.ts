import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { Buffer } from 'node:buffer'
import { z } from 'zod'

import { Controller, Get, Payload, Post, QueryParams } from 'helpers/route.ts'
import { cBoards, cKeypairs } from 'models'
import { Http400, Http404 } from 'helpers/http.ts'
import { Instruction, PROGRAM_ID } from 'helpers/constants.ts'
import { getPlayerAddress, U64 } from 'helpers/game.ts'
import { decodeBase58, encodeBase64 } from '@std/encoding'
import { buildTx } from 'helpers/solana.ts'
import { r } from 'helpers/redis.ts'

import { handleSocket } from '../game.ts'
import auth from '../middlewares/auth.ts'

const playPayloadSchema = z.object({
  boardId: z.string(),
  chips: z.number().nonnegative(),
})
type PlayPayload = z.infer<typeof playPayloadSchema>

const connectPayloadSchema = z.object({
  gsKey: z.string(),
})
type ConnectPayload = z.infer<typeof connectPayloadSchema>

@Controller('/v1')
class GameController {
  constructor() {}

  @Post('/play', auth)
  @Payload(playPayloadSchema)
  async play(payload: PlayPayload, ctx: Ctx) {
    const board = await cBoards.findOne({ id: payload.boardId })
    if (!board) {
      throw new Http404('Board does not exist')
    }

    const signer = new PublicKey(ctx.profile.address)
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

    const gsKey = Math.random().toString(36).slice(2)
    await r.setJSON(`gs:${gsKey}`, {
      boardId: board.id,
      chips: payload.chips,
      owner: ctx.profile.address,
    })

    return { tx: encodeBase64(tx.serialize()), gsKey }
  }

  @Get('/ws')
  @QueryParams(connectPayloadSchema)
  async connect({ gsKey }: ConnectPayload, ctx: Ctx) {
    const board = await r.getJSON(`gs:${gsKey}`)
    if (!board) {
      throw new Http400('Game session does not exist')
    }

    const socket = ctx.upgrade()
    handleSocket(socket, gsKey, ctx)
  }
}

export default GameController
