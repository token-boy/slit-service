import { Router, RouterContext, Status } from '@oak/oak'
import { Reflect } from 'reflect-metadata'
import { z } from 'zod'

import { RouteDefinition } from 'helpers/route.ts'
import log from 'helpers/log.ts'

import PlayerController from './PlayerController.ts'
import TxController from './TxController.ts'
import BoardController from './BoardController.ts'
import SessionController from './SessionController.ts'
import ChipsController from './ChipsController.ts'
import GameController from './GameController.ts'
import BillController from './BillController.ts'

// deno-lint-ignore no-explicit-any
const Controllers: any[] = [
  PlayerController,
  ChipsController,
  BoardController,
  GameController,
  BillController,
  SessionController,
  TxController,
]

const isDev = Deno.env.get('DENO_ENV') === 'development'

// deno-lint-ignore no-explicit-any
function success(ctx: RouterContext<any, any, any>, data: any) {
  ctx.response.status = Status.OK
  ctx.response.body = data || {}
}

// deno-lint-ignore no-explicit-any
function fail(ctx: RouterContext<any, any, any>, error: any) {
  if (error instanceof z.ZodError) {
    ctx.response.status = Status.BadRequest
    ctx.response.body = {
      code: Status.BadRequest,
      message: error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(', '),
    }
  } else {
    ctx.response.status = error.status || Status.InternalServerError
    ctx.response.body = {
      code: error.code || Status.InternalServerError,
      message: error.message,
    }
    if (isDev) {
      console.error(error)
    }
  }
}

function initRoutes(router: Router) {
  for (const Controller of Controllers) {
    const controller = new Controller()
    const prefix = Reflect.getMetadata<string>('prefix', Controller)
    const routes = Reflect.getMetadata<RouteDefinition[]>('routes', controller)
    // deno-lint-ignore ban-types
    const gmws = Reflect.getMetadata<Function[]>('gmws', Controller)

    for (const route of routes) {
      router.add(
        route.method,
        prefix + route.path,
        async (ctx, next) => {
          log.info(`${route.method} ${prefix}${route.path}`)
          try {
            for (const gmw of gmws) await gmw(ctx)
            for (const mw of route.mws) await mw(ctx)
            const data = await controller[route.propertyKey](ctx)
            success(ctx, data)
          } catch (error) {
            fail(ctx, error)
          }
          next()
        }
      )
    }
  }
}

export default initRoutes
