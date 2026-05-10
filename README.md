# @sentrix/chain

[![CI](https://github.com/Sentriscloud/sdk-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/Sentriscloud/sdk-ts/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Sentriscloud/sdk-ts)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/Sentriscloud/sdk-ts?include_prereleases&sort=semver)](https://github.com/Sentriscloud/sdk-ts/releases/latest)


Official TypeScript SDK for **Sentrix Chain** (chain ID `7119` mainnet, `7120` testnet). Five independent surfaces under one package — pick the one you actually need; tree-shaking drops the rest:

- **`@sentrix/chain/evm`** — viem-based EVM client (standard EVM dApp door)
- **`@sentrix/chain/native`** — typed REST client for Sentrix-shaped endpoints (validators, epochs, BFT justification, fork status)
- **`@sentrix/chain/bft`** — WebSocket subscription manager for all 9 channels (newHeads, logs, sentrix_finalized, sentrix_jail, …) with keepalive ping + automatic reconnect + typed payloads
- **`@sentrix/chain/wallet`** — secp256k1 keypair + Sentrix-native tx signing (same address as your MetaMask key — Sentrix derives addresses identically to Ethereum)
- **`@sentrix/chain/grpc`** — Node-side gRPC client over `@grpc/grpc-js` for the chain's `sentrix.v1.Sentrix` service (getBlock, getBalance, getValidatorSet, getSupply, getMempool, streamEvents). Bundled `.proto` so version drift can't bite you.
- **`@sentrix/chain/grpc-web`** — browser-side equivalent over `@protobuf-ts/grpcweb-transport`. Same surface, same chain endpoint (`grpc.sentrixchain.com` — Caddy transcodes gRPC-Web ↔ native gRPC).

## Install

```bash
npm install @sentrix/chain viem
# or
pnpm add @sentrix/chain viem
```

`viem` is a peer-dep — bring your own version (we test against `^2.21.0`).

## Quick start

### EVM read

```ts
import { evm } from "@sentrix/chain";

const client = evm.httpClient("mainnet");
const block = await client.getBlockNumber();
console.log("Current block:", block);
```

### Native REST read

```ts
import { native } from "@sentrix/chain";

const sentrix = native.nativeClient("mainnet");
const info = await sentrix.chainInfo();
console.log(`Height ${info.height}, ${info.active_validators} validators, supply ${info.total_minted_srx} SRX of ${info.max_supply_srx}`);

const validators = await sentrix.validators();
for (const v of validators) {
  console.log(`${v.name ?? v.address}: ${v.is_active ? "active" : "jailed"} self_stake=${v.self_stake} delegated=${v.total_delegated}`);
}
```

### Watch new heads + sentrix-native channels

```ts
import { bft } from "@sentrix/chain";

const mgr = new bft.SubscriptionManager("mainnet");

await mgr.subscribe("newHeads", {
  onMessage: (head) => console.log("new head:", head),
});

await mgr.subscribe("sentrix_jail", {
  onMessage: (event) => console.log("jail event:", event),
});

// Same socket carries both subscriptions; reconnects automatically with
// exponential backoff and re-subscribes everything.
```

The 9 channels available, all dispatched via `eth_subscribe`:

| Channel | What you get |
|---|---|
| `newHeads` | Standard EVM block-header push |
| `logs` | Standard EVM log filter (pass `filter` option) |
| `newPendingTransactions` | EVM mempool admission events |
| `syncing` | EVM sync-status |
| `sentrix_finalized` | BFT-finalised block (after 2/3+1 precommit supermajority) |
| `sentrix_validatorSet` | Active validator set rotation events |
| `sentrix_tokenOps` | Native SRC-20 Mint/Burn/Transfer/Approve/Deploy |
| `sentrix_stakingOps` | Native Delegate/Undelegate/ClaimRewards/RegisterValidator/AddSelfStake/Unjail |
| `sentrix_jail` | Per-validator jail / unjail events |

> All sentrix-native channels go through `eth_subscribe` by channel name — there is **no** separate `sentrix_subscribe` method on the chain. Common confusion source.

For typed payloads (instead of `unknown`):

```ts
await mgr.subscribeTyped("newHeads", {
  onMessage: (head) => console.log(head.number, head.hash), // typed as NewHeadsPayload
});
```

### Sign + broadcast a native Sentrix tx

```ts
import { wallet, native } from "@sentrix/chain";

const w = wallet.SentrixWallet.fromPrivateKeyHex(process.env.PRIVATE_KEY!);
const sentrix = native.nativeClient("mainnet");

const tx = await wallet.buildAndSignTransfer(w, {
  to: "0x0804a00f53fde72d46abd1db7ee3e97cbfd0a107",
  amountSentri: 100_000_000n, // 1 SRX
  feeSentri: 10_000n,         // 0.0001 SRX
  nonce: await sentrix.nextNonce(w.address),
  chainId: 7119,
});
const txid = await sentrix.broadcast(tx);
```

The wallet uses the same secp256k1 derivation as Ethereum — your MetaMask private key is also a Sentrix native private key, same address on both rails.

### Read via gRPC (Node only)

```ts
import { GrpcClient } from "@sentrix/chain/grpc";

const c = new GrpcClient("mainnet");
const block = await c.getLatestBlock();
const bal = await c.getBalance("0x4693b113e523A196d9579333c4ab8358e2656553");

// Server-stream chain events
for await (const ev of c.streamEvents([])) {
  console.log(ev);
}

c.close();
```

The chain's `sentrix.v1.Sentrix` service mirrors the JSON-RPC + REST shape. v0.4+ adds `getValidatorSet` / `getSupply` / `getMempool` and a server-streaming `streamEvents` for push-style consumption without the WebSocket overhead. Older chain hosts return `Status::unimplemented` for the newer methods; the SDK forwards the error verbatim so callers can fall back to JSON-RPC / REST.

> Browser consumers: use `@sentrix/chain/grpc-web` instead. Same surface, same chain endpoint — only the transport changes (`@protobuf-ts/grpcweb-transport` instead of `@grpc/grpc-js`). The `/grpc` subpath stays Node-only because `@grpc/grpc-js` needs raw HTTP/2 sockets browsers don't expose.

### Read via gRPC-Web (browser)

```ts
import { GrpcWebClient } from "@sentrix/chain/grpc-web";

const c = new GrpcWebClient("mainnet");
const block = await c.getLatestBlock();

for await (const ev of c.streamEvents([])) {
  console.log(ev);
}
```

Same chain endpoint as the Node `/grpc` subpath (`grpc.sentrixchain.com`) — Caddy at the edge transcodes gRPC-Web ↔ native gRPC via `tonic-web` so server code is identical.

## Network identity helpers

```ts
import { sentrixMainnet, sentrixTestnet, viemChain, CANONICAL_CONTRACTS } from "@sentrix/chain";

console.log(sentrixMainnet.rpcUrl);     // https://rpc.sentrixchain.com
console.log(sentrixTestnet.faucetUrl);  // https://faucet.sentrixchain.com

// Drop-in viem Chain object:
import { createPublicClient, http } from "viem";
const client = createPublicClient({
  chain: viemChain("mainnet"),
  transport: http(),
});

// Canonical contract addresses:
console.log(CANONICAL_CONTRACTS.mainnet.WSRX); // 0x4693...6553
```

## Decimals — the one thing that confuses everyone

Sentrix's underlying ledger is **8-decimal** native (1 SRX = 100,000,000 sentri). The EVM tooling sees a **18-decimal** view because `eth_getBalance` returns wei-scaled values for compatibility with MetaMask + ethers + viem.

When you use `evm.httpClient(...).getBalance(...)` you get 18-decimal wei. When you use `native.nativeClient(...).balance(...)` you get 8-decimal sentri scaled to SRX directly.

## Status

`v0.3.0-rc.0` — five-door surface: EVM (read + write via viem), native REST (typed read + nonce), BFT WebSocket (multiplexed subs + keepalive + typed payloads), wallet (secp256k1 + native tx signing), gRPC (Node-side typed client over the chain's `sentrix.v1.Sentrix` service).

## License

MIT — see [LICENSE](./LICENSE).
