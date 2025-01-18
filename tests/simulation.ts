import { TE } from 'helpers/game.ts'
import { Keypair, VersionedTransaction } from '@solana/web3.js'
import { connection, sleep } from 'helpers/solana.ts'
import nacl from 'tweetnacl'
import { decodeBase64, encodeBase64 } from '@std/encoding'
import { SOL_DECIMALS } from 'helpers/constants.ts'
import { HttpMethod } from 'jsr:@oak/commons@0.7/method'

interface Player {
  signer: Keypair
  cookie?: string
  accessToken?: string
  seatKey?: string
  playerId?: string
  index: number
  nickname: string
}
const players: Player[] = []

const boardId = Deno.args[0]
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

async function request(
  path: string,
  options: {
    player: Player
    method: HttpMethod
    // deno-lint-ignore no-explicit-any
    payload?: any
  }
) {
  const { player, method, payload } = options
  const res = await fetch(`http://localhost:8000/${path}`, {
    method: method,
    body: payload ? JSON.stringify(payload) : undefined,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${player.accessToken}`,
      Cookie: player.cookie,
      origin: 'http://localhost:3000',
    },
  })
  const cookie = res.headers.get('Set-Cookie')
  if (cookie) {
    player.cookie = cookie
  }
  if (!res.ok) {
    throw new Error(`Error: ${path} ${res.status}`)
  }
  return res.json()
}

async function signSendAndConfirmTx(tx: string, player: Player) {
  const transaction = VersionedTransaction.deserialize(decodeBase64(tx))
  transaction.sign([player.signer])
  const { signature } = await request(`v1/txs`, {
    player,
    method: 'POST',
    payload: {
      tx: encodeBase64(transaction.serialize()),
    },
  })
  return signature
}

async function register(player: Player) {
  const { tx } = await request(`v1/players`, { player, method: 'POST' })
  await signSendAndConfirmTx(tx, player)
  console.log(`${player.nickname} registered`)

  return updateProfile(player)
}

async function updateProfile(player: Player) {
  await request(`v1/players`, {
    player,
    method: 'PUT',
    payload: {
      avatarUrl: `avatar${player.index}.jpeg`,
      nickname: `${player.nickname}`,
    },
  })
  console.log(`${player.nickname} updated profile`)
}

async function signIn(player: Player) {
  const timestamp = Date.now().toString()
  const signature = nacl.sign.detached(
    TE.encode(timestamp),
    player.signer.secretKey
  )
  const { accessToken, isNew } = await request(`v1/sessions`, {
    player,
    method: 'POST',
    payload: {
      address: player.signer.publicKey.toBase58(),
      timestamp,
      signature: encodeBase64(signature),
    },
  })
  player.accessToken = accessToken
  console.log(`${player.nickname} signed in`)

  if (isNew) {
    return register(player)
  }
}

async function deposit(amount: number, player: Player) {
  const { tx } = await request(`v1/chips`, {
    player,
    method: 'POST',
    payload: {
      amount: amount.toString(),
    },
  })
  await signSendAndConfirmTx(tx, player)
  console.log(`${player.nickname} desposed ${amount} chips`)
}

async function enter(player: Player) {
  const { seatKey } = await request(`v1/game/${boardId}/enter`, {
    player,
    method: 'GET',
  })
  player.seatKey = seatKey
  console.log(`${player.nickname} entered game`)
}

async function play(chips: number, player: Player) {
  const { tx, seatKey, playerId } = await request(`v1/game/${boardId}/play`, {
    player,
    method: 'POST',
    payload: { chips },
  })
  await signSendAndConfirmTx(tx, player)
  player.seatKey = seatKey
  player.playerId = playerId
  console.log(`${player.nickname} joined game`)
}

async function sit(player: Player) {
  await request(`v1/game/sit`, {
    player,
    method: 'POST',
    payload: { seatKey: player.seatKey },
  })
  console.log(`${player.nickname} sitted`)
}

async function insertPlayer(index: number) {
  const signer = Keypair.generate()
  await connection.requestAirdrop(signer.publicKey, 10000000000)

  const player: Player = { signer, nickname: nicknames[index], index }
  players.push(player)
  Deno.writeTextFileSync('players.json', JSON.stringify(players))
  console.log(
    `Create player: ${player.nickname} ${player.signer.publicKey.toBase58()}`
  )

  await sleep(3000)

  await signIn(player)
  await deposit(1000 * SOL_DECIMALS, player)
  await enter(player)
  await play(100 * SOL_DECIMALS, player)
  await sit(player)
}

function join(num: number, offset = 0) {
  Array.from({ length: num }).forEach(async (_, i) => {
    try {
      await insertPlayer(offset+i)
    } catch (error) {
      console.error(error)
    }
  })
}

join(7, 2)
