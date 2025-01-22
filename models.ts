import { MongoClient } from 'mongodb'

export const mClient = new MongoClient(Deno.env.get('MONGO_URI') as string)
const db = mClient.db('slit')

export interface Player {
  owner: string
  address: string
  chips: number
  avatarUrl: string
  nickname: string
}

export enum BillType {
  Deposit = 0,
  Withdraw = 1,
  Stake = 2,
  Redeem = 3,
}

export const cPlayers = db.collection<Player>('players')

export const cBoards = db.collection<{
  id: string
  address: string
  chips: string
  dealer: string
  creator: string
  limit: string
  enabled: boolean
}>('boards')

export const cKeypairs = db.collection<{
  publicKey: string
  secretKey: string
}>('keypairs')


export const cBills = db.collection<{
  owner: string
  type: BillType
  amount: string
  boardId?: string
  seatKey?: string
  createdAt: number
}>('bills')
