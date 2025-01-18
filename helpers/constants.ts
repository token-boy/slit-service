import { PublicKey } from '@solana/web3.js'

export const PLAYER = 'player'
export const TREASURY = 'treasury'
export const BOARD = 'board'

export const PROGRAM_ID = new PublicKey(
  '79uMyLzwnjDgjTX1aMTxShygBaCkzWV5enXt3HD22vK'
)

export const ONE_MINUTE = 1000 * 60

export enum Instruction {
  Initialize = 0x00,
  Register = 0x01,
  Swap = 0x02,
  Create = 0x03,
  Play = 0x04,
  Settle = 0x05,
}

export enum SwapSide {
  Deposit = 0x00,
  Withdraw = 0x01,
}

export const SOL_DECIMALS = Math.pow(10, 9)

export const CHIPS_RATE = 1000;
export const FEE_RATE = 100;

export const TREASURY_PDA = new PublicKey(
  'DHXbu1dyy4eCZEgjYDMtpLtHNtx6C2znFZTU9xqukfzm'
)
export const FEE_VAULT_PDA = new PublicKey(
  '4M8D7JypYCz24biaYcy6AiuXuuYVHeH6fooNbFhKMAgk'
)

export const MAX_PLAYERS = 10
