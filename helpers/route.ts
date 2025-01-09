// deno-lint-ignore-file no-explicit-any ban-types

import { Reflect } from 'reflect-metadata'
import { HTTPMethods } from '@oak/oak'
import { z } from 'zod'
import { parseBody } from "middlewares";

export interface RouteDefinition {
  method: HTTPMethods
  path: string
  propertyKey: string
  mws: Function[]
}

export interface JSONPatch {
  op: 'add' | 'remove' | 'replace' | 'copy' | 'move' | 'test'
  from?: string
  path: string
  value: any
}

export function Controller(prefix = '', ...gmws: Function[]) {
  return function (target: any) {
    Reflect.defineMetadata('prefix', prefix, target)
    Reflect.defineMetadata('gmws', gmws, target)
  }
}

export function Route(method: HTTPMethods, path = '', ...mws: Function[]) {
  return function (target: any, propertyKey: string) {
    if (!Reflect.hasMetadata('routes', target)) {
      Reflect.defineMetadata('routes', [], target)
    }
    const routes = Reflect.getMetadata<RouteDefinition[]>('routes', target)
    routes.push({ method, path, propertyKey, mws })
  }
}

export function Get(path = '', ...mws: Function[]) {
  return Route('GET', path, ...mws)
}

export function Post(path = '', ...mws: Function[]) {
  return Route('POST', path, parseBody, ...mws)
}

export function Put(path = '', ...mws: Function[]) {
  return Route('PUT', path, parseBody, ...mws)
}

export function Delete(path = '', ...mws: Function[]) {
  return Route('DELETE', path, ...mws)
}

export function Patch(path = '', ...mws: Function[]) {
  return Route('PATCH', path, parseBody, ...mws)
}

export function Payload(zodSchema: z.AnyZodObject) {
  return function (
    _target: Object,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const method = descriptor.value
    descriptor.value = function (ctx: Ctx) {
      const body = ctx.payload
      const payload = zodSchema.parse(body)
      return method.apply(this, [payload, ctx])
    }
  }
}

export function QueryParams(zodSchema: z.AnyZodObject) {
  return function (
    _target: Object,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const method = descriptor.value
    descriptor.value = function (ctx: Ctx) {
      const queryParams = Object.fromEntries(
        ctx.request.url.searchParams.entries()
      )
      const payload = zodSchema.parse(queryParams)
      return method.apply(this, [payload, ctx])
    }
  }
}
