// deno-lint-ignore-file no-explicit-any

import { createLazyClient } from '@db/redis'

declare module '@db/redis' {
  interface RedisCommands {
    setJSON<T = any>(key: string, value: T): Promise<any>
    getJSON<T = any>(key: string): Promise<T | null>
  }
}

const options = {
  hostname: Deno.env.get('REDIS_HOSTNAME') ?? '127.0.0.1',
  port: Deno.env.get('REDIS_PORT'),
  username: Deno.env.get('REDIS_USERNAME'),
  password: Deno.env.get('REDIS_PASSWORD'),
}

export const r = createLazyClient(options)

export const rSub = createLazyClient(options)

r.setJSON = (key: string, value: any) => {
  return r.set(key, JSON.stringify(value))
}

r.getJSON = async <T = any>(key: string) => {
  return JSON.parse((await r.get(key)) as string) as T
}
