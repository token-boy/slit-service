import { verify, create } from '@zaubrik/djwt'

import { Http401 } from 'helpers/http.ts'
import {
  EXTRACTABLE,
  KEY_FORMAT,
  KEY_NAME,
  algorithm,
  keyUsages,
} from '../scripts/generate_key.ts'

const audience = ['slitgame.app']

const key = await crypto.subtle.importKey(
  KEY_FORMAT,
  Deno.readFileSync(KEY_NAME),
  algorithm,
  EXTRACTABLE,
  keyUsages
)

/**
 * Handling authentication.
 * 
 * @param ctx
 */
async function auth(ctx: Ctx) {
  const token = ctx.request.headers.get('Authorization') ?? ''
  const [type, accessToken] = token?.split(' ')

  try {
    if (type !== 'Bearer' || !accessToken) throw ctx
    const { sub } = await verify(accessToken, key, {
      audience,
    })
    ctx.profile = { address: sub as string }
  } catch (_) {
    throw new Http401(401, 'unauthorized')
  }
}

export function createAccessToken(address: string) {
  const now = Date.now()

  return create(
    { alg: 'HS512' },
    {
      iss: 'slitgame.app',
      sub: address,
      aud: audience,
      exp: now + 3600 * 24 * 7 * 1000,
      iat: now,
    },
    key
  )
}

export default auth
