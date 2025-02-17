import { GameCode, TE } from 'helpers/game.ts'
import { Keypair, VersionedTransaction } from '@solana/web3.js'
import { connection, sleep } from 'helpers/solana.ts'
import nacl from 'tweetnacl'
import {
  decodeBase58,
  decodeBase64,
  encodeBase58,
  encodeBase64,
} from '@std/encoding'
import { SOL_DECIMALS } from 'helpers/constants.ts'
import { HttpMethod } from 'jsr:@oak/commons@0.7/method'
import { r } from 'helpers/redis.ts'
import { clearStream } from './clear_stream.ts'
import nats from 'helpers/nats.ts'
import { Consumer } from '@nats-io/jetstream/internal'

const nicknames = [
  'John',
  'Michael',
  'David',
  'James',
  'Robert',
  'Mary',
  'Sarah',
  'Emily',
  'Jessica',
  'Elizabeth',
]

const cardNames = [
  '背面',
  '黑桃A',
  '黑桃2',
  '黑桃3',
  '黑桃4',
  '黑桃5',
  '黑桃6',
  '黑桃7',
  '黑桃8',
  '黑桃9',
  '黑桃10',
  '黑桃J',
  '黑桃Q',
  '黑桃K',
  '红桃A',
  '红桃2',
  '红桃3',
  '红桃4',
  '红桃5',
  '红桃6',
  '红桃7',
  '红桃8',
  '红桃9',
  '红桃10',
  '红桃J',
  '红桃Q',
  '红桃K',
  '方片A',
  '方片2',
  '方片3',
  '方片4',
  '方片5',
  '方片6',
  '方片7',
  '方片8',
  '方片9',
  '方片10',
  '方片J',
  '方片Q',
  '方片K',
  '梅花A',
  '梅花2',
  '梅花3',
  '梅花4',
  '梅花5',
  '梅花6',
  '梅花7',
  '梅花8',
  '梅花9',
  '梅花10',
  '梅花J',
  '梅花Q',
  '梅花K',
]

export type Hands = [number, number]

interface SeatState {
  playerId: string
  hands?: Hands
  chips: string
}

type Sync = {
  code: GameCode.Sync
  seats: SeatState[]
  deckCount: number
  turn?: string
  turnExpireAt?: number
  pot: string
}

interface Bet {
  code: GameCode.Bet
  playerId: string
  bet: string
  hands: Hands
}

type Message = Sync | Bet

const TEST_MY_INDEX = parseInt(Deno.env.get('TEST_MY_INDEX') || '0')

class Player {
  signer: Keypair
  index: number
  nickname: string
  accessToken?: string
  seatKey?: string
  hands?: Hands
  chips?: string
  id?: string

  constructor(options: {
    signer: Keypair
    index: number
    nickname?: string
    accessToken?: string
    id?: string
  }) {
    this.signer = options.signer
    this.index = options.index
    this.nickname = nicknames[options.index]
    this.accessToken = options.accessToken
    this.id = options.id
  }

  async request(
    path: string,
    method: HttpMethod,
    // deno-lint-ignore no-explicit-any
    payload?: any
  ) {
    const res = await fetch(`http://localhost:8000/${path}`, {
      method: method,
      body: payload ? JSON.stringify(payload) : undefined,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
        origin: 'http://localhost:3000',
      },
    })
    if (!res.ok) {
      throw new Error(`${path} ${res.status}`)
    }
    return res.json()
  }

  async signSendAndConfirmTx(tx: string) {
    const transaction = VersionedTransaction.deserialize(decodeBase64(tx))
    transaction.sign([this.signer])
    const { signature } = await this.request(`v1/txs`, 'POST', {
      tx: encodeBase64(transaction.serialize()),
    })
    return signature
  }

  async register() {
    const { tx } = await this.request(`v1/players`, 'POST')
    await this.signSendAndConfirmTx(tx)
    console.log(`${this.nickname} registered`)

    return this.updateProfile()
  }

  async updateProfile() {
    await this.request(`v1/players`, 'PUT', {
      avatarUrl: `avatar${this.index}.jpeg`,
      nickname: `${this.nickname}`,
    })
    console.log(`${this.nickname} updated profile`)
  }

  async signIn() {
    const timestamp = Date.now().toString()
    const signature = nacl.sign.detached(
      TE.encode(timestamp),
      this.signer.secretKey
    )
    const { accessToken, isNew } = await this.request(`v1/sessions`, 'POST', {
      address: this.signer.publicKey.toBase58(),
      timestamp,
      signature: encodeBase64(signature),
    })
    this.accessToken = accessToken
    console.log(`${this.nickname} signed in`)

    if (isNew) {
      return this.register()
    }
  }

  async deposit(amount: number) {
    const { tx } = await this.request(`v1/chips`, 'POST', {
      amount: amount.toString(),
    })
    await this.signSendAndConfirmTx(tx)
    console.log(`${this.nickname} desposed ${amount} chips`)
  }

  async enter() {
    const { sessionId } = await this.request(`v1/game/${boardId}/enter`, 'GET')
    const c = await nats.js().consumers.get(`state_${boardId}`, sessionId)
    this.consume(c)
    console.log(`${this.nickname} entered game`)
  }

  async getHands() {
    const { hands } = await this.request(`v1/game/${boardId}/hands`, 'POST', {
      seatKey: this.seatKey,
    })
    this.hands = hands
  }

  async stake(chips: number) {
    const { tx, seatKey, playerId } = await this.request(
      `v1/game/${boardId}/stake`,
      'POST',
      { chips }
    )
    await this.signSendAndConfirmTx(tx)
    this.seatKey = seatKey
    this.id = playerId
    console.log(`${this.nickname} joined game`)
  }

  async consume(c: Consumer) {
    const ms = await c.consume()
    for await (const m of ms) {
      try {
        const msg = JSON.parse(m.string()) as Message
        if (msg.code === GameCode.Sync) {
          const mySeat = msg.seats.find((s) => s.playerId === this.id)
          if (mySeat) {
            this.chips = mySeat.chips
            if (mySeat.hands) {
              await this.getHands()
            }

            if (msg.turn === this.id && this.hands && TEST_MY_INDEX !== this.index) {
              const [hand1, hand2] = this.hands
                .map((n) => ((n - 1) % 13) + 1)
                .sort((a, b) => a - b)
              console.log(
                `${this.nickname} dealt ${cardNames[hand1]} ${cardNames[hand2]}`
              )
              const delay = Math.random() * 3000
              console.log(
                `${this.nickname} delay ${(delay / 1000).toFixed(1)}s `
              )
              await sleep(delay)
              if (this.chips) {
                const bet =
                  hand2 - hand1 > 6 ? (10 * SOL_DECIMALS).toString() : '0'
                await this.request(`v1/game/${boardId}/bet`, 'POST', {
                  seatKey: this.seatKey,
                  bet,
                })
                console.log(`${this.nickname} bet ${bet} chips`)
              }
            }
          }
        }
      } catch (error) {
        console.error(error)
      }
    }
  }

  toJSON() {
    return {
      privateKey: encodeBase58(this.signer.secretKey),
      index: this.index,
      nickname: this.nickname,
      accessToken: this.accessToken,
      id: this.id,
    }
  }
}

const boardId = Deno.args[0]

async function createPlayer(index: number) {
  let signer: Keypair
  if (TEST_MY_INDEX === index) {
    signer = Keypair.fromSecretKey(
      decodeBase58(Deno.env.get('TEST_MY_PRIVATE_KEY')!)
    )
  } else {
    signer = Keypair.generate()
  }
  await connection.requestAirdrop(signer.publicKey, 100 * SOL_DECIMALS)

  const player = new Player({ signer, index })
  console.log(
    `Create player: ${player.nickname} ${player.signer.publicKey.toBase58()}`
  )

  await sleep(3000)

  await player.signIn()
  await player.deposit(99 * 1000 * SOL_DECIMALS)

  return player
}

const script = `
  local keys = redis.call('KEYS', ARGV[1]);
  if #keys > 0 then
    return redis.call('DEL', unpack(keys));
  end
  return 0
`

async function join(num: number) {
  // Reset board state
  await r.connect()
  const pl = r.pipeline()
  pl.del(`board:${boardId}:seats`)
  pl.del(`board:${boardId}:cursor`)
  pl.del(`board:${boardId}:cards`)
  pl.lpush(`board:${boardId}:cards`, ...Array(52).fill(0))
  pl.set(`board:${boardId}:pot`, '0')
  pl.del(`board:${boardId}:round`, '0')
  pl.set(`board:${boardId}:roundCount`, '0')
  pl.setex(`board:${boardId}:timer`, 30, '0')
  pl.eval(script, 1, '', 'owner:*')
  pl.eval(script, 1, '', `board:${boardId}:seat:*`)
  await pl.exec()

  // Reset messages
  await nats.connect()
  await clearStream(`state_${boardId}`)

  try {
    Deno.statSync('players.json')
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      Deno.writeTextFileSync('players.json', '[]')
    }
  }

  const players: Player[] = JSON.parse(
    Deno.readTextFileSync('players.json')
  ).map(
    // deno-lint-ignore no-explicit-any
    (p: any) =>
      new Player({
        signer: Keypair.fromSecretKey(decodeBase58(p.privateKey)),
        index: p.index,
        nickname: p.nickname,
        accessToken: p.accessToken,
        id: p.id,
      })
  )

  Array.from({ length: num }).forEach(async (_, i) => {
    try {
      let player = players[i]
      if (!player) {
        player = await createPlayer(i)
        players.push(player)
      }

      await player.enter()
      await player.stake(50 * SOL_DECIMALS)

      Deno.writeTextFileSync('players.json', JSON.stringify(players))
    } catch (error) {
      console.error(error)
    }
  })
}

join(3)
