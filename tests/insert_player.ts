/**
 * Inserts 10 players into the game
 */

import nats from 'helpers/nats.ts'
import { GameCode, SeatState } from 'helpers/game.ts'
import { SOL_DECIMALS } from 'helpers/constants.ts'
import { ObjectId } from 'mongodb'

await nats.connect()

const seats: SeatState[] = []

for (let i = 0; i < 10; i++) {
  setTimeout(() => {
    seats.push({
      playerId: new ObjectId().toHexString(),
      hands: [0, 0],
      chips: Math.random() * 1000 * SOL_DECIMALS,
      opened: false,
    })

    nats.js().publish(
      'states.e3aebea69f41453881a34c1f3227c718',
      JSON.stringify({
        code: GameCode.Sync,
        gameState: { seats },
      })
    )

    console.log(`inserted player ${i + 1}`)
  }, 5000 * (i + 1))
}
