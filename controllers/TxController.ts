import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { decodeBase64 } from '@std/encoding/base64'
import { z } from 'zod'

import { Controller, Payload, Post } from 'helpers/route.ts'
import { sendAndConfirm } from 'helpers/solana.ts'
import { Instruction, PROGRAM_ID } from 'helpers/constants.ts'
import { Http400 } from 'helpers/http.ts'
import { encodeBase58 } from '@std/encoding'

const CreatePayloadSchema = z.object({
  tx: z.string(),
})
type CreatePayload = z.infer<typeof CreatePayloadSchema>

type TxEventListener = (
  accounts: PublicKey[],
  data: Uint8Array,
  signatures: string[]
) => Promise<void>

const listeners: Map<Instruction, TxEventListener> = new Map()

export function addTxEventListener(
  instruction: Instruction,
  listener: TxEventListener
) {
  listeners.set(instruction, listener)
}

@Controller('/v1/txs')
class TxController {
  constructor() {}

  @Post()
  @Payload(CreatePayloadSchema)
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

    // Emit the transaction confirmed event for all listeners.
    const listener = listeners.get(instruction.data.at(0) as Instruction)
    if (listener) {
      await listener(
        staticAccountKeys,
        instruction.data.slice(1),
        tx.signatures.map((sig) => encodeBase58(sig))
      )
    }

    return { signature }
  }
}

export default TxController
