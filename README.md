# @sentrix/chain

Official TypeScript SDK for **Sentrix Chain** (chain ID `7119` mainnet, `7120` testnet). Three independent surfaces under one package:

- **`@sentrix/chain/evm`** — viem-based EVM client (the standard EVM dApp door)
- **`@sentrix/chain/native`** — typed REST client for Sentrix-shaped endpoints (validators, epochs, BFT justification)
- **`@sentrix/chain/bft`** — WebSocket subscription manager for all 9 channels

Pick the surface you actually need; tree-shaking will drop the rest.

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

`v0.1.0` — initial scaffold. Phase 1 covers the read surface for EVM + native + WS. Phase 2 will add transaction signing helpers (native Sentrix txs, not just EVM-via-viem).

## License

MIT — see [LICENSE](./LICENSE).
