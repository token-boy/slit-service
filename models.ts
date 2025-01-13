import { MongoClient } from 'mongodb'

export const mClient = new MongoClient(Deno.env.get('MONGO_URI') as string)
const db = mClient.db('slit')

export interface Player {
  owner: string
  address: string
  chips: number
}

export const cPlayers = db.collection<Player>('players')

export const cBoards = db.collection<{
  id: string
  address: string
  chips: number
  dealer: string
  creator: string
  minChips: number
  enabled: boolean
}>('boards')

export const cKeypairs = db.collection<{
  publicKey: string
  secretKey: string
}>('keypairs')

// export async function findByIdOrFail<T>(model: Model<T>, id: string) {
//   const document = await model.findById(id)

//   if (!document) {
//     throw new Http404(`${model.modelName} not found`)
//   }
//   return document
// }
