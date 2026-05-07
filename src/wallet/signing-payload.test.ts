// Audit 2026-05-07 H4 fix: signing-payload byte-equality fixture.
// CI was running `pnpm test --passWithNoTests` because no test files
// existed. This file establishes the canonical signing payload format
// matches the Rust chain side byte-for-byte. Future drift on either
// side fails this test.
//
// Generated with:
//   node -e 'crypto.createHash("sha256").update(<payload>).digest("hex")'

import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { SentrixWallet } from "./index.js";

describe("SentrixWallet.signingPayload", () => {
  it("emits the canonical alphabetical-key JSON shape", () => {
    const tx = {
      amount: 100n,
      chain_id: 7119n,
      data: "",
      fee: 10n,
      from_address: "0xabc1234567890abcdef1234567890abcdef123456",
      nonce: 0n,
      timestamp: 1700000000n,
      to_address: "0xdef1234567890abcdef1234567890abcdef987654",
    };
    const payload = SentrixWallet.signingPayload(tx);
    // Field order: amount, chain_id, data, fee, from, nonce, timestamp, to
    // Note: "from" not "from_address", "to" not "to_address" (matches Rust).
    expect(payload).toBe(
      `{"amount":100,"chain_id":7119,"data":"","fee":10,"from":"0xabc1234567890abcdef1234567890abcdef123456","nonce":0,"timestamp":1700000000,"to":"0xdef1234567890abcdef1234567890abcdef987654"}`
    );
    // sha256 must match what crypto.createHash("sha256").update(payload).digest("hex")
    // produces. Drift fails this assertion.
    expect(bytesToHex(sha256(utf8ToBytes(payload)))).toBe(
      "d9fd5a36e5bc6ca55f18ad6e9ac80a36467df800cba91931369aed76ee2a624e"
    );
  });

  it("preserves precision for amounts > 2^53 (audit H1 + H2)", () => {
    // 10^16 sentri = 100M SRX. JS Number.MAX_SAFE_INTEGER = 2^53 ≈ 9.007e15.
    // 10^16 exceeds safe-int by ~10x. Pre-fix, JSON.stringify(number)
    // produced "amount":1e16 OR rounded the value silently.
    // With bigint + manual JSON build, the output is the exact integer literal.
    const tx = {
      amount: 10_000_000_000_000_000n,
      chain_id: 7119n,
      data: "",
      fee: 10000n,
      from_address: "0x1111111111111111111111111111111111111111",
      nonce: 42n,
      timestamp: 1778153000n,
      to_address: "0x2222222222222222222222222222222222222222",
    };
    const payload = SentrixWallet.signingPayload(tx);
    expect(payload).toBe(
      `{"amount":10000000000000000,"chain_id":7119,"data":"","fee":10000,"from":"0x1111111111111111111111111111111111111111","nonce":42,"timestamp":1778153000,"to":"0x2222222222222222222222222222222222222222"}`
    );
    expect(bytesToHex(sha256(utf8ToBytes(payload)))).toBe(
      "02a7d3b7e82c04ff59bda9de3b38befd3ebd89429a754192601d9dc532aeead3"
    );
  });

  it("alphabetical key order is stable regardless of input order", () => {
    // Caller may pass fields in any order; output must always be
    // amount/chain_id/data/fee/from/nonce/timestamp/to.
    const tx = {
      to_address: "0x2222222222222222222222222222222222222222",
      from_address: "0x1111111111111111111111111111111111111111",
      nonce: 1n,
      timestamp: 1700000000n,
      data: "",
      chain_id: 7119n,
      fee: 100n,
      amount: 1000n,
    };
    const payload = SentrixWallet.signingPayload(tx);
    expect(payload.startsWith(`{"amount":1000,`)).toBe(true);
    expect(payload.endsWith(`"to":"0x2222222222222222222222222222222222222222"}`)).toBe(true);
  });
});
