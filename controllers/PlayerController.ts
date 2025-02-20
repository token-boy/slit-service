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
import { cPlayers, Player } from 'models'
import auth from '../middlewares/auth.ts'
import { Http404 } from 'helpers/http.ts'
import { ObjectId, WithId } from 'mongodb'
import { addTxEventListener } from './TxController.ts'
import { z } from 'zod'
import S3 from 'aws-sdk/clients/s3.js'
import { decodeBase64 } from '@std/encoding'

const s3 = new S3({
  endpoint: Deno.env.get('R2_ENDPOINT'),
  accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID'),
  secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY'),
  signatureVersion: 'v4',
})

const UpdateProfilePayloadSchame = z.object({
  avatarUrl: z.string(),
  nickname: z.string().max(24)
})
type UpdateProfilePayload = z.infer<typeof UpdateProfilePayloadSchame>

@Controller('/v1/players')
class PlayerController {
  constructor() {
    addTxEventListener(Instruction.Register, this.#handleRegisterConfirmed)
  }

  async #handleRegisterConfirmed(
    accounts: PublicKey[],
    _data: Uint8Array,
    signatures: string[]
  ) {
    await cPlayers.insertOne({
      owner: accounts[0].toBase58(),
      address: accounts[1].toBase58(),
      chips: '0',
      avatarUrl: 'default-avatar.jpeg',
      nickname: 'Pavel Durov',
      signature: signatures[0],
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
    let player: WithId<Player> | null
    if (ctx.params.id === 'profile') {
      await auth(ctx)
      player = await cPlayers.findOne({
        owner: ctx.profile.address,
      })
    } else {
      player = await cPlayers.findOne({
        _id: ObjectId.createFromHexString(ctx.params.id),
      })
    }
    if (!player) {
      throw new Http404('Player does not exist')
    }

    return {
      nickname: player.nickname,
      avatarUrl: player.avatarUrl,
    }
  }

  @Put('/profile', auth)
  @Payload(UpdateProfilePayloadSchame)
  async updateProfile({ avatarUrl, nickname }: UpdateProfilePayload, ctx: Ctx) {
    const player = await cPlayers.findOne({ owner: ctx.profile.address })
    if (!player) {
      throw new Http404('Player does not exist')
    }

    if (avatarUrl.startsWith('data:image/webp')) {
      const key = `avatars/${player._id}.webp`
      const presignedUrl = await s3.getSignedUrlPromise('putObject', {
        Bucket: 'slit',
        Key: key,
        Expires: 3600,
      })
      await fetch(presignedUrl, {
        method: 'PUT',
        body: decodeBase64(avatarUrl.replace('data:image/webp;base64,', '')),
      })
      await cPlayers.updateOne(
        { _id: player._id },
        {
          $set: {
            avatarUrl: `${key}?v=${Date.now()}`,
            nickname,
          },
        }
      )
    } else {
      await cPlayers.updateOne({ _id: player._id }, { $set: { nickname } })
    }
  }
}

export default PlayerController
