import log from 'helpers/log.ts'
import { Buffer } from 'node:buffer'
import { r } from 'helpers/redis.ts'
import { cPlayers, Player } from 'models'
import { WithId } from 'mongodb'

const conns: Dict<WebSocket> = {}

// function shuffle(cards?: number[]) {
//   if (!cards) {
//     cards = Array.from({ length: 52 }, (_, i) => i + 1)
//   }

//   for (let i = cards.length - 1; i > 0; i--) {
//     const j = Math.floor(Math.random() * (i + 1))
//     ;[cards[i], cards[j]] = [cards[j], cards[i]]
//   }
//   return cards
// }

async function handleReady(player: WithId<Player>, boardId: string) {
  const key = `board:${boardId}:players`
  await r.hset(key, player.address, JSON.stringify({ startingHands: [0, 0] }))

  const len = await r.hlen(key)
  if (len >= 2) {
    const states = await r.hgetall(key)

    // Sync states

    for (let i = 0; i < 2; ) {
      const address = states[i++]
      const a = Buffer.from(address)
      a.write

      const state = JSON.parse(states[i++])
      const ws = conns[address]
      if (ws) {
        ws.send(new Uint8Array([GameCode.Sync, ...Buffer.from(state)]))
      }
    }

    for (const [address, state] of Object.entries(states)) {
      const ws = conns[address]
      if (ws) {
        ws.send(new Uint8Array([GameCode.Sync, ...Buffer.from(state)]))
      }
    }
  }
}

export function handleSocket(ws: WebSocket, gsKey: string, ctx: Ctx) {
  const { address: owner } = ctx.profile

  ws.onopen = async () => {
    const { boardId } = await r.getJSON(`gs:${gsKey}`)
    const player = await cPlayers.findOne({ owner })
    if (!player) {
      ws.send(JSON.stringify({ code: GameError.PlayerNotFound }))
      return
    }
    const { address } = player
    conns[address] = ws

    log.info(`Connected: ${address} ${ctx.request.ip}`)

    ws.onmessage = async (e) => {
      const message = Buffer.from(e.data)
      const code = message.readUint8()

      if (code === GameCode.Ready) {
        await handleReady(player, boardId)
      }
    }
  }
}

export enum GameCode {
  Error = 0,
  Ready = 1,
  Sync = 2,
}

export enum GameError {
  Unknown = 0,
  PlayerNotFound = 1,
}
