// EVM door — the standard `viem` PublicClient pre-wired with Sentrix's
// chain spec. Anyone fluent in viem can drop this into existing dApp code
// without learning a Sentrix-specific API.

import { createPublicClient, http, webSocket, type PublicClient } from "viem";
import { getSpec, viemChain, type SentrixNetwork } from "../network.js";

export interface ClientOptions {
  /** Override the public HTTP RPC URL. */
  httpUrl?: string;
  /** Override the public WebSocket RPC URL. */
  wsUrl?: string;
}

/** HTTP `PublicClient` for the chosen network. Rule-of-thumb: use this
 *  for one-shot reads + writes (it's cheaper, simpler, no socket to keep
 *  alive). For real-time newHeads / log subscriptions use `wsClient`. */
export function httpClient(network: SentrixNetwork, opts: ClientOptions = {}): PublicClient {
  const spec = getSpec(network);
  return createPublicClient({
    chain: viemChain(network),
    transport: http(opts.httpUrl ?? spec.rpcUrl),
  });
}

/** WebSocket `PublicClient` — keep one of these alive when you want
 *  push-style updates via `client.watchBlocks` or `client.watchEvent`. */
export function wsClient(network: SentrixNetwork, opts: ClientOptions = {}): PublicClient {
  const spec = getSpec(network);
  return createPublicClient({
    chain: viemChain(network),
    transport: webSocket(opts.wsUrl ?? spec.wsUrl),
  });
}

export { CANONICAL_CONTRACTS } from "../network.js";
