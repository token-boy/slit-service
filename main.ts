import { Application, Router } from '@oak/oak'

import initRoutes from 'controllers'
import { cors } from 'middlewares'
import { r } from 'helpers/redis.ts'
import log from 'helpers/log.ts'

const app = new Application()
const router = new Router()

initRoutes(router)
app.use(router.routes())
app.use(router.allowedMethods())
app.use(cors)

const port = parseInt(Deno.env.get('PORT') ?? '8000')

try {
  await r.connect()

  log.info(`Listening on http://localhost:${port}`)

  await app.listen({ port })
} catch (error) {
  console.error(error)
}
