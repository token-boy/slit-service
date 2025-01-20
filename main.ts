import { Application, Router } from '@oak/oak'

import initRoutes from 'controllers'
import { cors } from 'middlewares'
import { r, rSub } from 'helpers/redis.ts'
import log from 'helpers/log.ts'
import nats from 'helpers/nats.ts'
import { mClient } from 'models'
import 'helpers/bigint.ts'

const app = new Application()
const router = new Router()

const port = parseInt(Deno.env.get('PORT') ?? '8000')

globalThis.addEventListener('unhandledRejection', (error) => {
  log.error(error)
})
globalThis.addEventListener('uncaughtException', (error) => {
  log.error(error)
})

try {
  await r.connect()
  await rSub.connect()
  await nats.connect()
  await mClient.connect()

  initRoutes(router)
  app.use(router.routes())
  app.use(router.allowedMethods())
  app.use(cors)

  log.info(`Listening on http://localhost:${port}`)

  await app.listen({ port })
} catch (error) {
  log.error(error)
}
