import { Buffer } from 'node:buffer'
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js'
import { encodeBase64 } from '@std/encoding/base64'

import { Controller, Get, Payload, Post, Put } from 'helpers/route.ts'
import { Instruction, PROGRAM_ID } from 'helpers/constants.ts'
import { buildTx, connection } from 'helpers/solana.ts'
import { getPlayerAddress } from 'helpers/game.ts'
import { cPlayers } from 'models'
import auth from '../middlewares/auth.ts'
import { Http404 } from 'helpers/http.ts'
import { ObjectId } from 'mongodb'
import { addTxEventListener } from './TxController.ts'
import { z } from 'zod'

const UpdateProfilePayloadSchame = z.object({
  avatarUrl: z.string(),
  nickname: z.string(),
})
type UpdateProfilePayload = z.infer<typeof UpdateProfilePayloadSchame>

@Controller('/v1/players')
class PlayerController {
  constructor() {
    addTxEventListener(Instruction.Register, this.#handleRegisterConfirmed)
  }

  async #handleRegisterConfirmed(accounts: PublicKey[]) {
    await cPlayers.insertOne({
      owner: accounts[0].toBase58(),
      address: accounts[1].toBase58(),
      chips: 0,
      avatarUrl: 'default-avatar.jpeg',
      nickname: 'Pavel Durov',
    })
  }

  @Post('', auth)
  async create(ctx: Ctx) {
    const signer = new PublicKey(ctx.profile.address)
    const playerAddress = getPlayerAddress(signer)

    const accountInfo = await connection.getAccountInfo(playerAddress)
    if (accountInfo) {
      return { message: 'Player already exists' }
    }

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: signer, isSigner: true, isWritable: false },
        { pubkey: playerAddress, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([Instruction.Register]),
    })
    const tx = await buildTx(signer, [ix])

    return {
      tx: encodeBase64(tx.serialize()),
    }
  }

  @Get('/:id')
  async findById(ctx: Ctx) {
    const player = await cPlayers.findOne({
      _id: ObjectId.createFromHexString(ctx.params.id),
    })
    if (!player) {
      throw new Http404('Player does not exist')
    }

    try {
      await auth(ctx)
      return player
    } catch (_) {
      return {
        nickname: player.nickname,
        avatarUrl: player.avatarUrl,
      }
    }
  }

  @Put('', auth)
  @Payload(UpdateProfilePayloadSchame)
  async updateProfile(payload: UpdateProfilePayload, ctx: Ctx) {
    const player = await cPlayers.findOne({ owner: ctx.profile.address })
    if (!player ) {
      throw new Http404('Player does not exist')
    }
    await cPlayers.updateOne(
      { _id: player._id },
      {
        $set: {
          avatarUrl: payload.avatarUrl,
          nickname: payload.nickname,
        },
      }
    )
  }
}

export default PlayerController
