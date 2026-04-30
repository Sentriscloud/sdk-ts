// @sentrix/chain — official TypeScript SDK for Sentrix Chain.
//
// One package, three independent surfaces:
//   - `@sentrix/chain/evm`    — viem-based EVM client (the standard EVM dApp door)
//   - `@sentrix/chain/native` — native REST client (TokenOps, StakingOps, BFT-aware)
//   - `@sentrix/chain/bft`    — WebSocket subscription helpers (newHeads + sentrix_*)
//
// Importing the root re-exports everything at one path for the
// "I want it all" caller, but tree-shaking benefits from picking the
// surface you actually use.

export * from "./network.js";
export * as evm from "./evm/index.js";
export * as native from "./native/index.js";
export * as bft from "./bft/index.js";
export { SentrixWallet } from "./wallet/index.js";
