import { PublicKey } from '@solana/web3.js'
import nacl from 'tweetnacl'
import { z } from 'zod'
import { decodeBase64 } from '@std/encoding'

import { Controller, Payload, Post } from 'helpers/route.ts'
import { ONE_MINUTE } from 'helpers/constants.ts'
import { Http400 } from 'helpers/http.ts'
import { encoder } from 'helpers/game.ts'

import { createAccessToken } from '../middlewares/auth.ts'
import { cPlayers } from 'models'

const CreatePayloadSchama = z.object({
  address: z.string(),
  timestamp: z.string(),
  signature: z.string(),
})
type CreatePayload = z.infer<typeof CreatePayloadSchama>

@Controller('/v1/sessions')
class SessionController {
  constructor() {}

  @Post()
  @Payload(CreatePayloadSchama)
  async create(payload: CreatePayload) {
    const now = Date.now()
    const timestamp = parseInt(payload.timestamp)
    if (
      isNaN(timestamp) ||
      !(timestamp > now - ONE_MINUTE && timestamp < now)
    ) {
      throw new Http400('Invalid timestamp')
    }

    const result = nacl.sign.detached.verify(
      encoder.encode(payload.timestamp),
      Uint8Array.from(decodeBase64(payload.signature)),
      new PublicKey(payload.address).toBytes()
    )
    if (!result) {
      throw new Http400('Invalid signature')
    }

    const accessToken = await createAccessToken(payload.address)

    const count = await cPlayers.countDocuments({ owner: payload.address })

    return { accessToken, isNew: count === 0 }
  }
}

export default SessionController
