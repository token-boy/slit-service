import { Keypair, VersionedTransaction } from '@solana/web3.js'
import {  decodeBase58, encodeBase64 } from '@std/encoding'
import { Buffer } from 'node:buffer'

const signer = Keypair.fromSecretKey(decodeBase58(Deno.args[0]))
const tx = VersionedTransaction.deserialize(Buffer.from(Deno.args[1], 'base64'))
tx.sign([signer])

console.log(encodeBase64(tx.serialize()))
