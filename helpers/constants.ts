import { PublicKey } from '@solana/web3.js'

export const PLAYER = 'player'
export const TREASURY = 'treasury'
export const BOARD = 'board'

export const PROGRAM_ID = new PublicKey(
  '9NZYenyM5utBQ1uFneERRxS4oc2crY5xBHQq3TMWBaym'
)

export const ONE_MINUTE = 1000 * 60

export enum Instruction {
  Initialize = 0x00,
  Register = 0x01,
  Swap = 0x02,
  Create = 0x03,
  Stake = 0x04,
  Redeem = 0x05,
}

export enum SwapSide {
  Deposit = 0x00,
  Withdraw = 0x01,
}

export const SOL_DECIMALS = Math.pow(10, 9)

export const CHIPS_RATE = 1000;
export const FEE_RATE = BigInt(100);

export const TREASURY_PDA = new PublicKey(
  'A3Hj73Uh2nDvoMLJ1kTn3KgCNZNRdgTCW3hYeCRCwDJv'
)
export const FEE_VAULT_PDA = new PublicKey(
  '6gAovy9dx2wKdat2H3DAPtZwzN7HPVVYeZzyn5YiF9tj'
)

export const MAX_PLAYERS = 10
