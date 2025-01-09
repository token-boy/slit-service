import { Buffer } from 'node:buffer'
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js'
import { encodeBase64 } from '@std/encoding/base64'

import { Controller, Post } from 'helpers/route.ts'
import { Instruction, PROGRAM_ID } from 'helpers/constants.ts'
import { buildTx, connection } from 'helpers/solana.ts'
import { eventEmitter, getPlayerAddress } from 'helpers/game.ts'
import { cPlayers } from 'models'
import auth from '../middlewares/auth.ts'

@Controller('/v1/players', auth)
class PlayerController {
  constructor() {
    eventEmitter.on(
      `tx-confirmed-${Instruction.Register}`,
      (accounts: PublicKey[]) => {
        cPlayers.insertOne({
          owner: accounts[0].toBase58(),
          address: accounts[1].toBase58(),
          chips: 0,
        })
      }
    )
  }

  @Post()
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
}

export default PlayerController
