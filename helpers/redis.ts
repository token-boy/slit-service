// deno-lint-ignore-file no-explicit-any

import { Redis, type RedisOptions, Pipeline } from 'ioredis'
import log from "helpers/log.ts";

declare module 'ioredis' {
  interface RedisCommander {
    setJSON<T = any>(key: string, value: T): Promise<any>
    getJSON<T = any>(key: string): Promise<T | null>
    hsetJSON<T = any>(key: string, field: string, value: T): Promise<any>
    hgetJSON<T = any>(key: string, field: string): Promise<T | null>
    getNumber(key: string): Promise<number | null>
    flush<T = any>(): Promise<T>
  }
}

Redis.prototype.setJSON = function (key: string, value: any) {
  return this.set(key, JSON.stringify(value))
}

Redis.prototype.getJSON = async function <T = any>(key: string) {
  return JSON.parse((await this.get(key)) as string) as T
}

Redis.prototype.hsetJSON = function (key: string, field: string, value: any) {
  return this.hset(key, field, JSON.stringify(value))
}

Redis.prototype.hgetJSON = async function <T = any>(
  key: string,
  field: string
) {
  return JSON.parse((await this.hget(key, field)) as string) as T
}

Redis.prototype.getNumber = async function (key: string) {
  const value = await this.get(key)
  return value ? Number(value) : null
}

Pipeline.prototype.flush = async function <T>() {
  const result = await this.exec()
  if (result) {
    return result.map((item) => {
      if (item[0] instanceof Error) {
        log.error(item)
        console.trace()
        throw item[0]
      }
      return item[1]
    }) as T
  }
  console.trace()
  throw new Error('Pipeline error')
}

const options: RedisOptions = {
  host: Deno.env.get('REDIS_HOSTNAME') ?? '127.0.0.1',
  port: parseInt(Deno.env.get('REDIS_PORT') ?? '6379'),
  username: Deno.env.get('REDIS_USERNAME'),
  password: Deno.env.get('REDIS_PASSWORD'),
  lazyConnect: true,
  enableAutoPipelining: true,
  keepAlive: 30,
}

export const r = new Redis(options)

export const rSub = new Redis(options)
