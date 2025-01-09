// deno-lint-ignore-file no-explicit-any

import { Http404, Http500 } from 'helpers/http.ts'

export function Model(Clazz: any) {
  return function (
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const method = descriptor.value
    descriptor.value = async function (ctx: Ctx) {
      const id = ctx.params.id
      try {
        const result = await Clazz.findById(id)
        if (!result) {
          throw new Http404('Resource does not exist.')
        }
        const args = [result, ctx]
        return method.apply(this, args)
      } catch (error) {
        if (error instanceof Http404) {
          throw error
        }
        throw new Http500(error.message)
      }
    }
  }
}

export function Request(Clazz: any) {
  return function (
    _target: any,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const method = descriptor.value
    descriptor.value = function (ctx: Ctx) {
      const args = [new Clazz(ctx.request.body), ctx]
      return method.apply(this, args)
    }
  }
}

export async function parseBody(ctx: Ctx) {
  if (
    ctx.request.headers.get('Content-Type') === 'application/json' &&
    ctx.request.hasBody
  ) {
    try {
      Object.defineProperty(ctx, 'payload', {
        value: await ctx.request.body.json(),
      })
    } catch (_) {
      Object.defineProperty(ctx, 'payload', {
        value: {}
      })
    }
  }
}
