// Native transaction shapes — must match `crates/sentrix-primitives/src/transaction.rs`
// byte-for-byte. Drift = signature verify failure on the chain.
//
// All amounts are in `sentri` (1 SRX = 100,000,000 sentri = 1e8). EVM tooling
// sees 18-decimal wei via `eth_getBalance`, but native txs deal in 8-decimal
// sentri only.
//
// Audit 2026-05-07 H1+H2 (HIGH): all amount/fee/nonce/timestamp/chain_id
// fields are now `bigint`. Pre-fix these were `number` which overflows JS
// safe-int (~90.07M SRX) below the 315M supply cap; high-value txs would
// silently round on the JS side and hash to a different signing payload than
// the chain expected. Bigint ⇒ exact arithmetic at any size.

export interface NativeTx {
  /** sha256(signing_payload), hex-encoded, lowercase, no `0x` prefix. */
  txid: string;
  from_address: string;
  to_address: string;
  /** Sentri (8-decimal). u64 on the chain; bigint here for exact precision. */
  amount: bigint;
  /** Sentri. Minimum on-chain fee is 10_000 sentri = 0.0001 SRX. */
  fee: bigint;
  /** Per-sender nonce. u64 on the chain. */
  nonce: bigint;
  /** Encoded payload: empty for plain SRX transfer; "TOKEN:..." for SRC-20
   *  TokenOps; "STAKE:..." for native StakingOps. */
  data: string;
  /** Unix seconds. u64 on the chain. */
  timestamp: bigint;
  /** 7119 mainnet, 7120 testnet. u64 on the chain. */
  chain_id: bigint;
  /** Hex-encoded secp256k1 signature (compact 64 bytes), lowercase, no `0x`. */
  signature: string;
  /** Hex-encoded compressed secp256k1 pubkey (33 bytes), lowercase, no `0x`. */
  public_key: string;
}

/** Default timestamp helper — current Unix seconds as bigint. */
const nowSecs = (): bigint => BigInt(Math.floor(Date.now() / 1000));

/** Build an unsigned native SRX transfer tx. The wallet's `sign()` then
 *  fills in txid + signature + public_key. */
export function buildTransfer(opts: {
  from: string;
  to: string;
  amount: bigint;
  fee: bigint;
  nonce: bigint;
  chainId: bigint;
  /** Defaults to `Date.now()/1000`. Override for deterministic tests. */
  timestamp?: bigint;
}): Omit<NativeTx, "txid" | "signature" | "public_key"> {
  return {
    from_address: opts.from.toLowerCase(),
    to_address: opts.to.toLowerCase(),
    amount: opts.amount,
    fee: opts.fee,
    nonce: opts.nonce,
    data: "",
    timestamp: opts.timestamp ?? nowSecs(),
    chain_id: opts.chainId,
  };
}

/** Native StakingOp — Delegate to a validator. Encoded as `STAKE:DELEGATE:<validator>`
 *  per sentrix-primitives. The amount field carries the bond size. */
export function buildDelegate(opts: {
  from: string;
  validator: string;
  amount: bigint;
  fee: bigint;
  nonce: bigint;
  chainId: bigint;
  timestamp?: bigint;
}): Omit<NativeTx, "txid" | "signature" | "public_key"> {
  return {
    from_address: opts.from.toLowerCase(),
    to_address: "0x0000000000000000000000000000000000000100",
    amount: opts.amount,
    fee: opts.fee,
    nonce: opts.nonce,
    data: `STAKE:DELEGATE:${opts.validator.toLowerCase()}`,
    timestamp: opts.timestamp ?? nowSecs(),
    chain_id: opts.chainId,
  };
}

/** Native StakingOp — Undelegate from a validator. Bond amount comes from
 *  `amount`. */
export function buildUndelegate(opts: {
  from: string;
  validator: string;
  amount: bigint;
  fee: bigint;
  nonce: bigint;
  chainId: bigint;
  timestamp?: bigint;
}): Omit<NativeTx, "txid" | "signature" | "public_key"> {
  return {
    from_address: opts.from.toLowerCase(),
    to_address: "0x0000000000000000000000000000000000000100",
    amount: opts.amount,
    fee: opts.fee,
    nonce: opts.nonce,
    data: `STAKE:UNDELEGATE:${opts.validator.toLowerCase()}`,
    timestamp: opts.timestamp ?? nowSecs(),
    chain_id: opts.chainId,
  };
}

/** Native StakingOp — ClaimRewards. Pulls accumulated rewards from the
 *  protocol treasury into the caller's balance. `amount` is informational
 *  here; the chain ignores it for ClaimRewards (the actual claim size is
 *  whatever the registry has accrued for this address). */
export function buildClaimRewards(opts: {
  from: string;
  fee: bigint;
  nonce: bigint;
  chainId: bigint;
  timestamp?: bigint;
}): Omit<NativeTx, "txid" | "signature" | "public_key"> {
  return {
    from_address: opts.from.toLowerCase(),
    to_address: "0x0000000000000000000000000000000000000100",
    amount: 0n,
    fee: opts.fee,
    nonce: opts.nonce,
    data: "STAKE:CLAIM_REWARDS",
    timestamp: opts.timestamp ?? nowSecs(),
    chain_id: opts.chainId,
  };
}

/** Native SRC-20 Transfer. */
export function buildTokenTransfer(opts: {
  from: string;
  contract: string;
  to: string;
  amount: bigint;
  fee: bigint;
  nonce: bigint;
  chainId: bigint;
  timestamp?: bigint;
}): Omit<NativeTx, "txid" | "signature" | "public_key"> {
  return {
    from_address: opts.from.toLowerCase(),
    to_address: "0x0000000000000000000000000000000000000000",
    amount: 0n,
    fee: opts.fee,
    nonce: opts.nonce,
    // Note: token amount is part of the data string (not the tx amount field).
    // Bigint stringifies via String(amount) which emits the bare integer literal
    // — exactly what the chain's deserializer expects.
    data: `TOKEN:TRANSFER:${opts.contract.toLowerCase()}:${opts.to.toLowerCase()}:${String(opts.amount)}`,
    timestamp: opts.timestamp ?? nowSecs(),
    chain_id: opts.chainId,
  };
}
