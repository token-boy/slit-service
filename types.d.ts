// deno-lint-ignore-file no-explicit-any

import { RouterContext } from '@oak/oak'

declare global {
  type Dict<T = any> = Record<string, T>

  interface Priv {
    root: boolean
  }

  interface Ctx<T = any> extends RouterContext<string, Dict<string>, Dict> {
    payload: T
    profile: {
      address: string
    }
  }
}
