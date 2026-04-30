// Native transaction shapes — must match `crates/sentrix-primitives/src/transaction.rs`
// byte-for-byte. Drift = signature verify failure on the chain.
//
// All amounts are in `sentri` (1 SRX = 100,000,000 sentri = 1e8). EVM tooling
// sees 18-decimal wei via `eth_getBalance`, but native txs deal in 8-decimal
// sentri only.

export interface NativeTx {
  /** sha256(signing_payload), hex-encoded, lowercase, no `0x` prefix. */
  txid: string;
  from_address: string;
  to_address: string;
  /** Sentri (8-decimal). */
  amount: number;
  /** Sentri. Minimum on-chain fee is 10_000 sentri = 0.0001 SRX. */
  fee: number;
  /** Per-sender nonce. */
  nonce: number;
  /** Encoded payload: empty for plain SRX transfer; "TOKEN:..." for SRC-20
   *  TokenOps; "STAKE:..." for native StakingOps. */
  data: string;
  /** Unix seconds. */
  timestamp: number;
  /** 7119 mainnet, 7120 testnet. */
  chain_id: number;
  /** Hex-encoded secp256k1 signature (compact 64 bytes), lowercase, no `0x`. */
  signature: string;
  /** Hex-encoded compressed secp256k1 pubkey (33 bytes), lowercase, no `0x`. */
  public_key: string;
}

/** Build an unsigned native SRX transfer tx. The wallet's `sign()` then
 *  fills in txid + signature + public_key. */
export function buildTransfer(opts: {
  from: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  chainId: number;
  /** Defaults to `Date.now()/1000`. Override for deterministic tests. */
  timestamp?: number;
}): Omit<NativeTx, "txid" | "signature" | "public_key"> {
  return {
    from_address: opts.from.toLowerCase(),
    to_address: opts.to.toLowerCase(),
    amount: opts.amount,
    fee: opts.fee,
    nonce: opts.nonce,
    data: "",
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    chain_id: opts.chainId,
  };
}

/** Native StakingOp — Delegate to a validator. Encoded as `STAKE:DELEGATE:<validator>`
 *  per sentrix-primitives. The amount field carries the bond size. */
export function buildDelegate(opts: {
  from: string;
  validator: string;
  amount: number;
  fee: number;
  nonce: number;
  chainId: number;
  timestamp?: number;
}): Omit<NativeTx, "txid" | "signature" | "public_key"> {
  return {
    from_address: opts.from.toLowerCase(),
    to_address: "0x0000000000000000000000000000000000000100",
    amount: opts.amount,
    fee: opts.fee,
    nonce: opts.nonce,
    data: `STAKE:DELEGATE:${opts.validator.toLowerCase()}`,
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    chain_id: opts.chainId,
  };
}

/** Native StakingOp — Undelegate from a validator. Bond amount comes from
 *  `amount`. */
export function buildUndelegate(opts: {
  from: string;
  validator: string;
  amount: number;
  fee: number;
  nonce: number;
  chainId: number;
  timestamp?: number;
}): Omit<NativeTx, "txid" | "signature" | "public_key"> {
  return {
    from_address: opts.from.toLowerCase(),
    to_address: "0x0000000000000000000000000000000000000100",
    amount: opts.amount,
    fee: opts.fee,
    nonce: opts.nonce,
    data: `STAKE:UNDELEGATE:${opts.validator.toLowerCase()}`,
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    chain_id: opts.chainId,
  };
}

/** Native StakingOp — ClaimRewards. Pulls accumulated rewards from the
 *  protocol treasury into the caller's balance. `amount` is informational
 *  here; the chain ignores it for ClaimRewards (the actual claim size is
 *  whatever the registry has accrued for this address). */
export function buildClaimRewards(opts: {
  from: string;
  fee: number;
  nonce: number;
  chainId: number;
  timestamp?: number;
}): Omit<NativeTx, "txid" | "signature" | "public_key"> {
  return {
    from_address: opts.from.toLowerCase(),
    to_address: "0x0000000000000000000000000000000000000100",
    amount: 0,
    fee: opts.fee,
    nonce: opts.nonce,
    data: "STAKE:CLAIM_REWARDS",
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    chain_id: opts.chainId,
  };
}

/** Native SRC-20 Transfer. */
export function buildTokenTransfer(opts: {
  from: string;
  contract: string;
  to: string;
  amount: number;
  fee: number;
  nonce: number;
  chainId: number;
  timestamp?: number;
}): Omit<NativeTx, "txid" | "signature" | "public_key"> {
  return {
    from_address: opts.from.toLowerCase(),
    to_address: "0x0000000000000000000000000000000000000000",
    amount: 0,
    fee: opts.fee,
    nonce: opts.nonce,
    data: `TOKEN:TRANSFER:${opts.contract.toLowerCase()}:${opts.to.toLowerCase()}:${opts.amount}`,
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
    chain_id: opts.chainId,
  };
}
