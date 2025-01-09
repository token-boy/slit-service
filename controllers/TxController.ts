import { VersionedTransaction } from '@solana/web3.js'
import { decodeBase64 } from '@std/encoding/base64'
import { z } from "zod";

import { Controller, Payload, Post } from 'helpers/route.ts'
import { sendAndConfirm } from 'helpers/solana.ts'
import { eventEmitter } from 'helpers/game.ts'
import { PROGRAM_ID } from 'helpers/constants.ts'
import { Http400 } from "helpers/http.ts";

const createPayloadSchema = z.object({
  tx: z.string(),
})
type CreatePayload = z.infer<typeof createPayloadSchema>

@Controller('/v1/txs')
class TxController {
  constructor() {}

  @Post()
  @Payload(createPayloadSchema)
  async create(payload: CreatePayload) {
    const tx = VersionedTransaction.deserialize(decodeBase64(payload.tx))

    if (!tx.signatures.length) {
      throw new Http400('Invalid transaction')
    }

    // Check if the transaction has unexpected instructions.
    const { staticAccountKeys, compiledInstructions } = tx.message
    if (compiledInstructions.length !== 1) {
      throw new Http400('Invalid transaction')
    }

    // Check if the transaction is for the correct program.
    const [instruction] = compiledInstructions
    if (!staticAccountKeys[instruction.programIdIndex].equals(PROGRAM_ID)) {
      throw new Http400('Invalid transaction')
    }
    
    const signature = await sendAndConfirm(tx)

    // Emit the transaction confirmed event.
    eventEmitter.emit(
      `tx-confirmed-${instruction.data.at(0)}`,
      staticAccountKeys,
      instruction.data.slice(1)
    )

    return { signature }
  }
}

export default TxController
