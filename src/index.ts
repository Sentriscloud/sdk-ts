// @sentrix/chain — official TypeScript SDK for Sentrix Chain.
//
// One package, six independent surfaces (subpath imports for tree-shaking):
//   - `@sentrix/chain/evm`      — viem-based EVM client (standard EVM dApp door)
//   - `@sentrix/chain/native`   — typed REST client + native tx builders
//   - `@sentrix/chain/bft`      — WebSocket subscription manager (newHeads + sentrix_*)
//   - `@sentrix/chain/wallet`   — secp256k1 keypair + Sentrix-native tx signing
//   - `@sentrix/chain/grpc`     — Node-side gRPC client (`@grpc/grpc-js`)
//   - `@sentrix/chain/grpc-web` — browser-side gRPC client (`@protobuf-ts/grpcweb-transport`)
//
// This barrel re-exports the four surfaces that load safely in any
// environment (evm / native / bft / wallet). gRPC + gRPC-Web stay
// subpath-only because their transports don't load in the other env
// (`@grpc/grpc-js` needs raw HTTP/2 sockets browsers don't expose).

export * from "./network.js";
export * as evm from "./evm/index.js";
export * as native from "./native/index.js";
export * as bft from "./bft/index.js";
export { SentrixWallet } from "./wallet/index.js";
