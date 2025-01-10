import { Buffer } from 'node:buffer'
import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js'
import { encodeBase64 } from '@std/encoding/base64'
import { z } from 'zod'

import {
  Controller,
  Delete,
  Get,
  Payload,
  Post,
  QueryParams,
} from 'helpers/route.ts'
import {
  CHIPS_RATE,
  FEE_VAULT_PDA,
  Instruction,
  PROGRAM_ID,
  SwapSide,
  TREASURY_PDA,
} from 'helpers/constants.ts'
import { buildTx, connection } from 'helpers/solana.ts'
import { Http400 } from 'helpers/http.ts'
import { getPlayerAddress, U64 } from 'helpers/game.ts'
import auth from '../middlewares/auth.ts'

const swapPayloadSchema = z.object({
  amount: z.string(),
})
type SwapPayload = z.infer<typeof swapPayloadSchema>

@Controller('/v1/chips', auth)
class ChipsController {
  constructor() {}

  private async swap(address: string, side: SwapSide, amount: string) {
    if (isNaN(parseInt(amount))) {
      throw new Http400('Invalid amount')
    }

    const player = new PublicKey(address)
    const playerAddress = getPlayerAddress(player)

    const accountInfo = await connection.getAccountInfo(playerAddress)
    if (!accountInfo) {
      throw new Http400('Player does not exist')
    }

    if (side === SwapSide.Deposit) {
      const balance = await connection.getBalance(player)
      if (balance < parseInt(amount) / CHIPS_RATE) {
        throw new Http400('Balance not enough')
      }
    } else if (accountInfo.data.readBigUInt64LE(8) < parseInt(amount)) {
      throw new Http400('Chips not enough')
    }

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: player, isSigner: true, isWritable: true },
        { pubkey: playerAddress, isSigner: false, isWritable: true },
        { pubkey: TREASURY_PDA, isSigner: false, isWritable: true },
        { pubkey: FEE_VAULT_PDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: Buffer.from([
        Instruction.Swap,
        side,
        ...U64.toUint8Array(amount),
      ]),
    })
    const tx = await buildTx(player, [ix])

    return {
      tx: encodeBase64(tx.serialize())
    }
  }

  @Post()
  @Payload(swapPayloadSchema)
  deposit(payload: SwapPayload, ctx: Ctx) {
    return this.swap(ctx.profile.address, SwapSide.Deposit, payload.amount)
  }

  @Delete()
  @QueryParams(swapPayloadSchema)
  withdraw(payload: SwapPayload, ctx: Ctx) {
    return this.swap(ctx.profile.address, SwapSide.Withdraw, payload.amount)
  }

  @Get()
  async chips(ctx: Ctx) {
    const player = new PublicKey(ctx.profile.address)
    const playerAddress = getPlayerAddress(player)

    const accountInfo = await connection.getAccountInfo(playerAddress)
    if (!accountInfo) {
      return { amount: 0 }
    }

    return { amount: accountInfo.data.readBigUInt64LE(8).toString() }
  }
}

export default ChipsController
