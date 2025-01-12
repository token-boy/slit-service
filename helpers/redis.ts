// deno-lint-ignore-file no-explicit-any

import { createLazyClient } from '@db/redis'

declare module '@db/redis' {
  interface RedisCommands {
    setJSON(key: string, value: any): Promise<any>
    getJSON<T = any>(key: string): Promise<T | null>
  }
}

export const r = createLazyClient({
  hostname: Deno.env.get('REDIS_HOSTNAME') ?? '127.0.0.1',
  port: Deno.env.get('REDIS_PORT'),
  username: Deno.env.get('REDIS_USERNAME'),
  password: Deno.env.get('REDIS_PASSWORD'),
})

r.setJSON = (key: string, value: any) => {
  return r.set(key, JSON.stringify(value))
}

r.getJSON = async <T = any>(key: string) => {
  return JSON.parse((await r.get(key)) as string) as T
}
