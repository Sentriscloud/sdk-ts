// Network identity + endpoint inventory. Single source of truth for the
// SDK; every other surface (evm/native/bft) consumes from here, never
// hard-codes the chain id or RPC URL on its own.

import type { Chain } from "viem";

export type SentrixNetwork = "mainnet" | "testnet";

export interface SentrixChainSpec {
  /** Display name. */
  readonly name: string;
  /** EIP-155 chain id. */
  readonly chainId: number;
  /** Public HTTP RPC. */
  readonly rpcUrl: string;
  /** Public WebSocket RPC. */
  readonly wsUrl: string;
  /** Native REST API base (the `/chain/info`, `/staking/validators`, etc. surface). */
  readonly restUrl: string;
  /** Block explorer URL — EIP-3091 compatible. */
  readonly explorerUrl: string;
  /** Self-hosted Sourcify verifier URL. */
  readonly verifierUrl: string;
  /** Faucet URL — testnet only; null on mainnet. */
  readonly faucetUrl: string | null;
}

export const sentrixMainnet: SentrixChainSpec = {
  name: "Sentrix Chain",
  chainId: 7119,
  rpcUrl: "https://rpc.sentrixchain.com",
  wsUrl: "wss://rpc.sentrixchain.com/ws",
  restUrl: "https://rpc.sentrixchain.com",
  explorerUrl: "https://scan.sentrixchain.com",
  verifierUrl: "https://verify.sentrixchain.com",
  faucetUrl: null,
};

export const sentrixTestnet: SentrixChainSpec = {
  name: "Sentrix Testnet",
  chainId: 7120,
  rpcUrl: "https://testnet-rpc.sentrixchain.com",
  wsUrl: "wss://testnet-rpc.sentrixchain.com/ws",
  restUrl: "https://testnet-rpc.sentrixchain.com",
  explorerUrl: "https://scan-testnet.sentrixchain.com",
  verifierUrl: "https://verify.sentrixchain.com",
  faucetUrl: "https://faucet.sentrixchain.com",
};

export function getSpec(network: SentrixNetwork): SentrixChainSpec {
  return network === "mainnet" ? sentrixMainnet : sentrixTestnet;
}

/** Build a viem `Chain` object from a Sentrix network. Useful for callers
 *  that already use viem and want a drop-in chain object. */
export function viemChain(network: SentrixNetwork): Chain {
  const spec = getSpec(network);
  return {
    id: spec.chainId,
    name: spec.name,
    nativeCurrency: {
      name: spec.name,
      symbol: network === "mainnet" ? "SRX" : "tSRX",
      decimals: 18,
    },
    rpcUrls: {
      default: { http: [spec.rpcUrl], webSocket: [spec.wsUrl] },
    },
    blockExplorers: {
      default: { name: "Sentrix Scan", url: spec.explorerUrl },
    },
    testnet: network === "testnet",
  } as Chain;
}

/** Canonical contract addresses on each network — pulled from
 *  `sentrix-labs/canonical-contracts@v1.0.0`. */
export const CANONICAL_CONTRACTS: Record<SentrixNetwork, {
  readonly WSRX: `0x${string}`;
  readonly Multicall3: `0x${string}`;
  readonly TokenFactory: `0x${string}`;
  readonly SentrixSafe: `0x${string}`;
}> = {
  mainnet: {
    WSRX: "0x4693b113e523A196d9579333c4ab8358e2656553",
    Multicall3: "0xFd4b34b5763f54a580a0d9f7997A2A993ef9ceE9",
    TokenFactory: "0xc753199b723649ab92c6db8A45F158921CFDEe49",
    SentrixSafe: "0x6272dC0C842F05542f9fF7B5443E93C0642a3b26",
  },
  testnet: {
    WSRX: "0x85d5E7694AF31C2Edd0a7e66b7c6c92C59fF949A",
    Multicall3: "0x7900826De548425c6BE56caEbD4760AB0155Cd54",
    TokenFactory: "0x7A2992af0d4979aDD076347666023d66d29276Fc",
    SentrixSafe: "0xc9D7a61D7C2F428F6A055916488041fD00532110",
  },
};

/** Protocol-reserved sentinel addresses. They have no private key and
 *  appear in transaction history when a TokenOp / Stake op routes
 *  through them. Useful for tagging in UIs. */
export const SENTINELS = {
  TOKEN_OP: "0x0000000000000000000000000000000000000000",
  PROTOCOL_TREASURY: "0x0000000000000000000000000000000000000002",
  STAKING: "0x0000000000000000000000000000000000000100",
} as const;
