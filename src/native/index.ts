// Native door — typed REST client for the Sentrix-shaped endpoints
// (`/chain/info`, `/chain/blocks/:h`, `/staking/validators`, `/epoch/current`,
// `/sentrix_status`, etc). The chain exposes both EVM JSON-RPC and these
// native shapes; the native shape carries fields the EVM API doesn't
// (validator name + commission, BFT justification signers, fork status,
// stake registry breakdowns).

import { getSpec, type SentrixNetwork } from "../network.js";

export interface ChainInfo {
  height: number;
  total_blocks: number;
  total_minted_srx: number;
  total_burned_srx: number;
  max_supply_srx: number;
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
  amount: number;
  fee: number;
  nonce: number;
  data?: string | null;
  signature?: string | null;
  chain_id?: number;
}

export interface Validator {
  address: string;
  name?: string;
  is_active: boolean;
  is_jailed: boolean;
  self_stake?: number;
  total_delegated?: number;
  commission_rate?: number;
  blocks_produced?: number;
}

export interface EpochInfo {
  epoch_number: number;
  start_height: number;
  end_height: number;
  total_blocks_produced: number;
  total_rewards: number;
  total_staked: number;
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
  balance(address: string): Promise<{ address: string; balance_srx: number; nonce: number }> {
    return this.get(`/accounts/${address}`);
  }

  history(address: string, page = 1): Promise<{ transactions: Transaction[]; total: number }> {
    return this.get(`/address/${address}/history?page=${page}`);
  }

  // ── mempool ──────────────────────────────────────────────────
  mempool(): Promise<{ size: number; transactions: Transaction[] }> {
    return this.get("/mempool");
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
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function nativeClient(network: SentrixNetwork, opts: NativeClientOptions = {}): SentrixNativeClient {
  return new SentrixNativeClient(network, opts);
}
