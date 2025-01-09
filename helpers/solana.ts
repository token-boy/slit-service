import {
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  Connection,
  TransactionMessage,
} from '@solana/web3.js'
import { ONE_MINUTE } from 'helpers/constants.ts'

export const connection = new Connection(
  Deno.env.get('SOLANA_RPC_URL') as string,
  'confirmed'
)

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Builds a v0 compatible transaction with the given payer and instructions.
 *
 * @param payer Public key of the transaction payer.
 * @param instructions Array of instructions to be executed in the transaction.
 * @returns A new VersionedTransaction object.
 */
export async function buildTx(
  payer: PublicKey,
  instructions: Array<TransactionInstruction>
) {
  const latestBlockhash = await connection.getLatestBlockhash()

  // create v0 compatible message
  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message()
  const tx = new VersionedTransaction(messageV0)

  return tx
}

/**
 * Simulates and sends a transaction, waiting until it is confirmed.
 *
 * @param tx The transaction to send.
 * @returns The signature of the sent transaction.
 * @throws If the transaction simulation fails.
 * @throws If the transaction times out, i.e., takes longer than 1.5 minutes to confirm.
 */
export async function sendAndConfirm(tx: VersionedTransaction) {
  const simulation = await connection.simulateTransaction(tx, {
    commitment: 'confirmed',
  })
  if (simulation.value.err) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`)
  }

  const signature = await connection.sendTransaction(tx, {
    // NOTE: Adjusting maxRetries to a lower value for trading, as 20 retries can be too much
    // Experiment with different maxRetries values based on your tolerance for slippage and speed
    // Reference: https://solana.com/docs/core/transactions#retrying-transactions
    maxRetries: 5,
    skipPreflight: true,
    preflightCommitment: 'confirmed',
  })

  const t0 = Date.now()
  while (true) {
    if (Date.now() - t0 > ONE_MINUTE * 1.5) {
      throw new Error('Transaction timed out')
    }
    const { value } = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })
    if (value[0] && value[0].confirmationStatus === 'confirmed') {
      return signature
    }
    await sleep(1000 * 3)
  }
}
