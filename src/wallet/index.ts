// Native Sentrix wallet — secp256k1 keypair + Ethereum-style address.
//
// Sentrix derives addresses identically to Ethereum: take the uncompressed
// secp256k1 public key (65 bytes, skip the 0x04 prefix), keccak-256 the
// remaining 64 bytes, and the last 20 bytes are the address. So a
// MetaMask / EVM private key is also a Sentrix native private key — same
// address on both rails.
//
// Tx signing is over a sha256 of the canonical `signing_payload`, which
// is a BTreeMap-ordered JSON of {amount, chain_id, data, fee, from, nonce,
// timestamp, to}. Output: lower-S 64-byte signature, hex-encoded; the chain
// rejects high-S signatures (BIP-62 normalisation).

import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import type { NativeTx } from "../native/tx.js";

export class SentrixWallet {
  /** 32-byte secp256k1 private key. Held in memory; never logged. */
  private readonly secret: Uint8Array;
  /** Compressed public key (33 bytes) — used in tx.public_key as hex. */
  readonly publicKey: Uint8Array;
  /** Sentrix address (0x-prefixed, lowercase, EIP-55-style not checksummed). */
  readonly address: `0x${string}`;

  private constructor(secret: Uint8Array) {
    this.secret = secret;
    this.publicKey = secp.getPublicKey(secret, true);
    this.address = SentrixWallet.deriveAddress(secp.getPublicKey(secret, false));
  }

  /** Make a fresh wallet from a hex-encoded private key (with or without
   *  the `0x` prefix). Throws if the key isn't a valid secp256k1 scalar. */
  static fromPrivateKeyHex(hex: string): SentrixWallet {
    const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (stripped.length !== 64) {
      throw new Error(`SentrixWallet: private key must be 32 bytes (got ${stripped.length / 2})`);
    }
    return new SentrixWallet(hexToBytes(stripped));
  }

  /** Cryptographically random new keypair. Convenience for tests + onboarding flows. */
  static random(): SentrixWallet {
    return new SentrixWallet(secp.utils.randomPrivateKey());
  }

  /** Hex of the private key, with `0x` prefix. Use sparingly — copying out of
   *  this method defeats the "never logged" intent. */
  get privateKeyHex(): `0x${string}` {
    return `0x${bytesToHex(this.secret)}` as `0x${string}`;
  }

  /** 33-byte compressed pubkey, hex-encoded (0x-prefixed). The chain expects
   *  this in `tx.public_key`. */
  get publicKeyHex(): `0x${string}` {
    return `0x${bytesToHex(this.publicKey)}` as `0x${string}`;
  }

  /** Sentrix's canonical signing payload — BTreeMap-ordered JSON of the
   *  scalar tx fields. Must match `Transaction::signing_payload` in
   *  `crates/sentrix-primitives/src/transaction.rs` byte-for-byte; any
   *  drift produces a different sha256 and the chain rejects the
   *  signature.
   *
   *  We use `JSON.stringify` with a sorted key list (matches alphabetical
   *  BTreeMap iteration on the Rust side). Sentrix's signing payload omits
   *  `txid`, `signature`, `public_key` from the digest. */
  static signingPayload(tx: Pick<NativeTx, "amount" | "chain_id" | "data" | "fee" | "from_address" | "nonce" | "timestamp" | "to_address">): string {
    // Keep field order identical to the Rust BTreeMap iteration order
    // (alphabetical by key — "from" comes before "nonce" alphabetically).
    //
    // Audit 2026-05-07 H2: previously used JSON.stringify which throws on
    // bigint AND silently rounded numbers > 2^53 in the pre-bigint era.
    // Now we build the JSON string MANUALLY so bigint amounts are emitted
    // as bare integer literals — matching Rust's serde_json u64 output
    // byte-for-byte. Any drift here makes the sha256 differ → on-chain
    // signature verify fails.
    const intLit = (n: bigint): string => n.toString();
    const strLit = (s: string): string => JSON.stringify(s);
    return (
      "{" +
      `"amount":${intLit(tx.amount)},` +
      `"chain_id":${intLit(tx.chain_id)},` +
      `"data":${strLit(tx.data)},` +
      `"fee":${intLit(tx.fee)},` +
      `"from":${strLit(tx.from_address)},` +
      `"nonce":${intLit(tx.nonce)},` +
      `"timestamp":${intLit(tx.timestamp)},` +
      `"to":${strLit(tx.to_address)}` +
      "}"
    );
  }

  /** Sign a tx — fills in `txid`, `signature`, `public_key`, returns the
   *  full submittable Tx. The caller is expected to have populated
   *  `from_address`, `to_address`, `amount`, `fee`, `nonce`, `data`,
   *  `timestamp`, `chain_id` already. */
  async sign(tx: Omit<NativeTx, "txid" | "signature" | "public_key">): Promise<NativeTx> {
    const payload = SentrixWallet.signingPayload(tx);
    const digest = sha256(utf8ToBytes(payload));
    // Sentrix uses standard secp256k1 ECDSA over SHA-256(payload). Lower-S
    // is enforced by the noble lib by default; the on-chain verifier rejects
    // high-S signatures so we never want to opt out.
    const sigObj = await secp.signAsync(digest, this.secret, { lowS: true });
    const sigHex = bytesToHex(sigObj.toCompactRawBytes());

    return {
      ...tx,
      txid: bytesToHex(sha256(utf8ToBytes(payload))),
      signature: sigHex,
      public_key: bytesToHex(this.publicKey),
    };
  }

  /** Ethereum-style address derivation:
   *   1. uncompressed pubkey (65 bytes, drop the 0x04 prefix)
   *   2. keccak-256 the remaining 64 bytes
   *   3. take last 20 bytes
   *   4. prefix `0x`, lowercase. */
  static deriveAddress(uncompressedPub: Uint8Array): `0x${string}` {
    if (uncompressedPub.length !== 65 || uncompressedPub[0] !== 0x04) {
      throw new Error("SentrixWallet.deriveAddress expects 65-byte uncompressed pubkey starting with 0x04");
    }
    const hash = keccak_256(uncompressedPub.subarray(1));
    return `0x${bytesToHex(hash.subarray(12))}` as `0x${string}`;
  }
}
