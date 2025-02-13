import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { TREASURY, PROGRAM_ID } from "helpers/constants.ts";
import { decodeBase58 } from "@std/encoding/base58";
import { Instruction } from "helpers/constants.ts";
import { buildTx, sendAndConfirm } from "helpers/solana.ts";
import { Buffer } from "node:buffer";
import { PLAYER } from "helpers/constants.ts";

const signer = Keypair.fromSecretKey(decodeBase58(Deno.args[0]))
const encoder = new TextEncoder()
const treasuryPDA = PublicKey.findProgramAddressSync(
  [encoder.encode(TREASURY)],
  PROGRAM_ID
)[0]
const feeVaultPDA = PublicKey.findProgramAddressSync(
  [encoder.encode(PLAYER), signer.publicKey.toBytes()],
  PROGRAM_ID
)[0]

console.log(`Treasury PDA: ${treasuryPDA.toBase58()}`);
console.log(`Fee Vault PDA: ${feeVaultPDA.toBase58()}`);

const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: signer.publicKey, isSigner: true, isWritable: false },
    { pubkey: treasuryPDA, isSigner: false, isWritable: true },
    { pubkey: feeVaultPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([Instruction.Initialize]),
})
const tx = await buildTx(signer.publicKey, [ix])
tx.sign([signer])

const signature = await sendAndConfirm(tx)
console.log(signature)
