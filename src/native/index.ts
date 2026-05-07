// Native door — typed REST client for the Sentrix-shaped endpoints
// (`/chain/info`, `/chain/blocks/:h`, `/staking/validators`, `/epoch/current`,
// `/sentrix_status`, etc). The chain exposes both EVM JSON-RPC and these
// native shapes; the native shape carries fields the EVM API doesn't
// (validator name + commission, BFT justification signers, fork status,
// stake registry breakdowns).

import { getSpec, type SentrixNetwork } from "../network.js";

// Audit 2026-05-07 H1 (HIGH): supply / amount / fee / stake fields use
// `bigint` instead of `number` — JS safe-int (~90.07M SRX) overflows
// below the 315M supply cap, causing silent rounding on any high-value
// query. Counters that are inherently bounded (height, validator count,
// per-sender nonce) stay `number` for ergonomics.

export interface ChainInfo {
  height: number;
  total_blocks: number;
  /** Sentri (8-decimal). u64 on chain; bigint for exact precision. */
  total_minted_srx: bigint;
  total_burned_srx: bigint;
  max_supply_srx: bigint;
  active_validators: number;
  mempool_size: number;
}

export interface BlockJustification {
  height: number;
  round: number;
  block_hash: string;
  precommits: Array<{
    validator: string;
    block_hash: string;
    signature: number[];
    stake_weight: number;
  }>;
}

export interface Block {
  index: number;
  hash: string;
  previous_hash: string;
  timestamp: string | number;
  validator: string;
  state_root?: string | number[] | null;
  round?: number;
  justification?: BlockJustification | null;
  transactions: Transaction[];
}

export interface Transaction {
  txid: string;
  from_address: string;
  to_address: string;
  /** Sentri. u64 on chain; bigint for exact precision. */
  amount: bigint;
  fee: bigint;
  /** Per-sender nonce. u64 on chain; bigint for parity with chain side. */
  nonce: bigint;
  data?: string | null;
  signature?: string | null;
  chain_id?: bigint;
}

export interface Validator {
  address: string;
  name?: string;
  is_active: boolean;
  is_jailed: boolean;
  /** Sentri. */
  self_stake?: bigint;
  /** Sentri. */
  total_delegated?: bigint;
  /** Basis points (1000 = 10%). Bounded by chain rules; number is fine. */
  commission_rate?: number;
  blocks_produced?: number;
}

export interface EpochInfo {
  epoch_number: number;
  start_height: number;
  end_height: number;
  total_blocks_produced: number;
  /** Sentri. */
  total_rewards: bigint;
  /** Sentri. */
  total_staked: bigint;
  validator_set?: string[];
}

export interface ChainStatus {
  chain_id: number;
  consensus: "DPoS+BFT" | "PoA" | string;
  native_token: string;
  uptime_seconds: number;
  version: { version: string; build: string };
  sync_info: {
    earliest_block_height: number;
    latest_block_height: number;
    latest_block_hash: string;
  };
}

export interface NativeClientOptions {
  /** Override the REST base URL. */
  baseUrl?: string;
  /** Per-call timeout in ms (default 8000). */
  timeoutMs?: number;
  /** Custom fetch impl — defaults to global `fetch`. Useful in Node ≤ 18 or for tests. */
  fetch?: typeof fetch;
}

export class SentrixNativeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(network: SentrixNetwork, opts: NativeClientOptions = {}) {
    const spec = getSpec(network);
    this.baseUrl = opts.baseUrl ?? spec.restUrl;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  // ── chain ────────────────────────────────────────────────────
  chainInfo(): Promise<ChainInfo> {
    return this.get<ChainInfo>("/chain/info");
  }

  block(height: number): Promise<Block> {
    return this.get<Block>(`/chain/blocks/${height}`);
  }

  status(): Promise<ChainStatus> {
    return this.get<ChainStatus>("/sentrix_status");
  }

  // ── staking ──────────────────────────────────────────────────
  validators(): Promise<Validator[]> {
    return this.get<Validator[]>("/staking/validators");
  }

  validator(address: string): Promise<Validator> {
    return this.get<Validator>(`/staking/validators/${address}`);
  }

  // ── epoch ────────────────────────────────────────────────────
  currentEpoch(): Promise<EpochInfo> {
    return this.get<EpochInfo>("/epoch/current");
  }

  // ── account ──────────────────────────────────────────────────
  /** Returns balance in sentri (u64 on chain → bigint here for precision). */
  balance(address: string): Promise<{ address: string; balance_srx: bigint; nonce: bigint }> {
    return this.get(`/accounts/${address}`);
  }

  history(address: string, page = 1): Promise<{ transactions: Transaction[]; total: number }> {
    return this.get(`/address/${address}/history?page=${page}`);
  }

  // ── mempool ──────────────────────────────────────────────────
  mempool(): Promise<{ size: number; transactions: Transaction[] }> {
    return this.get("/mempool");
  }

  // ── tx submit ────────────────────────────────────────────────
  /** Submit a signed native tx via `POST /transactions`. Returns the
   *  tx body the chain admitted (including the txid the chain computed,
   *  which the SDK already filled in client-side — the chain's view is
   *  authoritative for tie-breaking). Throws on non-2xx. */
  async submitTx(tx: import("./tx.js").NativeTx): Promise<{ txid: string; status?: string }> {
    return this.post(`/transactions`, tx);
  }

  private async get<T>(path: string): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: ctrl.signal,
        headers: { "accept": "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Sentrix REST ${path} → HTTP ${res.status}`);
      }
      // Audit 2026-05-07 H1: response numerics that must be bigint (amounts,
      // supply, stake) come back as JS number from res.json() — risks rounding
      // for values > 2^53. Bigint revival is a follow-up; until then, if a
      // caller hits a high-value endpoint, they should use bigintFromJsonText
      // (exported below) on the raw text. Tracked as v0.3.0 follow-up.
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", "accept": "application/json" },
        // Audit 2026-05-07 H2: bigint-aware serialize so submitTx with
        // high-value amounts doesn't throw on JSON.stringify.
        body: stringifyWithBigInt(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Sentrix REST POST ${path} → HTTP ${res.status} ${text}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Audit 2026-05-07 H2 helper. JSON.stringify replacement that emits bigint
 *  values as bare integer literals (matches Rust serde_json u64 output). */
export function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() + "n_BIG" : v))
    .replace(/"(\d+)n_BIG"/g, "$1");
}

/** Audit 2026-05-07 H1 follow-up helper. For endpoints that return high-value
 *  amounts (supply, stake) as integer literals, parse the raw response text
 *  with a per-key bigint revival. Pass `bigintKeys` listing the field names
 *  that should be bigint in your typed response.
 *
 *  Example: `bigintFromJsonText(text, ["total_minted_srx", "total_burned_srx"])`. */
export function bigintFromJsonText<T>(text: string, bigintKeys: readonly string[]): T {
  // Mark each `"key": <int>` for the listed keys so JSON.parse keeps
  // precision via reviver-as-string.
  let marked = text;
  for (const k of bigintKeys) {
    const re = new RegExp(`("${k}"\\s*:\\s*)(-?\\d+)(\\s*[,}])`, "g");
    marked = marked.replace(re, '$1"BIGINT:$2"$3');
  }
  return JSON.parse(marked, (_k, v) => {
    if (typeof v === "string" && v.startsWith("BIGINT:")) {
      return BigInt(v.slice("BIGINT:".length));
    }
    return v;
  }) as T;
}

export * from "./tx.js";

export function nativeClient(network: SentrixNetwork, opts: NativeClientOptions = {}): SentrixNativeClient {
  return new SentrixNativeClient(network, opts);
}
