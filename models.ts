import { MongoClient } from 'mongodb'

export const mClient = new MongoClient(Deno.env.get('MONGO_URI') as string)
const db = mClient.db('slit')

export interface Player {
  owner: string
  address: string
  chips: string
  avatarUrl: string
  nickname: string
  signature: string
}

export enum BillType {
  Deposit = 0,
  Withdraw = 1,
  Stake = 2,
  Redeem = 3,
}

export interface Bill {
  owner: string
  type: BillType
  amount: string
  fee?: string
  boardId?: string
  seatKey?: string
  confirmed: boolean
  signature?: string
  createdAt: number
}

export const cPlayers = db.collection<Player>('players')

export const cBoards = db.collection<{
  id: string
  address: string
  chips: string
  players: number
  dealer: string
  creator: string
  limit: string
  confirmed: boolean
  signature?: string
  createdAt: number
}>('boards')

export const cKeypairs = db.collection<{
  publicKey: string
  secretKey: string
}>('keypairs')


export const cBills = db.collection<Bill>('bills')
