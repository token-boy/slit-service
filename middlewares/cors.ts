import { Context, Next } from '@oak/oak'

// Allow cors origins.
const allowOrigins = JSON.parse(
  atob(Deno.env.get('ACCESS_CONTROL_LIST')!)
) as string[]

async function cors(ctx: Context, next: Next) {
  const origin = ctx.request.headers.get('origin') ?? ''

  if (allowOrigins.indexOf(origin) !== -1) {
    ctx.response.headers.set('Access-Control-Allow-Origin', origin)
    ctx.response.headers.set(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type'
    )
    ctx.response.headers.set(
      'Access-Control-Allow-Methods',
      'OPTIONS, POST, DELETE, PUT, DELETE, PATCH'
    )
    ctx.response.headers.set('Access-Control-Allow-Credentials', 'true')
    if (ctx.request.method === 'OPTIONS') {
      ctx.response.status = 200
    } else {
      await next()
    }
  } else {
    ctx.response.status = 403
  }
}

export default cors
