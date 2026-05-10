// gRPC door — typed wrapper around the chain's `sentrix.v1.Sentrix`
// service. Node-only (uses @grpc/grpc-js + @grpc/proto-loader). For
// browser consumers the chain exposes the same methods over gRPC-Web
// at the same endpoint; use a separate gRPC-Web client (eg the
// sentrix-explorer-v2 wrapper, or wire your own via grpc-web npm).
//
// Why a thin wrapper instead of having callers `loadProto` themselves:
//   1. Bundle the .proto with the npm package — version-locked to the
//      SDK so a chain proto bump can't silently mismatch your client.
//   2. Centralise the endpoint URL (mainnet / testnet) via the same
//      network spec the rest of the SDK uses.
//   3. Hide the proto-loader → service-stub plumbing so consumers
//      don't need to reach into @grpc/grpc-js internals.
//
// Available calls on the v0.4+ chain side:
//   - getBlock { latest } / { height }    → Block
//   - getBalance { address }              → Account
//   - getValidatorSet { atHeight }        → ValidatorSet
//   - getSupply { atHeight }              → Supply
//   - getMempool { limit }                → Mempool
//   - streamEvents { filters, from }      → server-stream of ChainEvent
//
// Older (v0.2/0.3) chain hosts return Status::unimplemented for the
// newer methods. The SDK forwards the error so callers can fall back
// to the JSON-RPC / REST surface or skip the feature.

import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import { credentials, type ChannelCredentials, type ClientReadableStream } from "@grpc/grpc-js";
import { loadSync, type Options as ProtoOptions } from "@grpc/proto-loader";
import { loadPackageDefinition } from "@grpc/grpc-js";
import { getSpec, type SentrixNetwork } from "../network.js";

// Resolve the bundled proto file relative to THIS source file. Works
// for both ESM (import.meta.url) and after esbuild/tsc compile (the
// proto sits next to dist/grpc/index.js because tsc copies static
// assets via tsconfig "files" + the package.json "files" array).
const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = pathResolve(HERE, "..", "grpc-proto", "sentrix.proto");

const PROTO_OPTS: ProtoOptions = {
  // Match Sentrix's prost generation: long fields → string (so u64
  // block heights survive JSON round-trip) + bytes as Buffer.
  longs: String,
  bytes: Buffer,
  enums: String,
  defaults: true,
  oneofs: true,
};

// Lazy-loaded so callers that never touch /grpc don't pay the
// proto-load cost on import.
let cachedDef: GrpcServiceShape | null = null;
function getServiceDef(): GrpcServiceShape {
  if (cachedDef) return cachedDef;
  const pkg = loadPackageDefinition(loadSync(PROTO_PATH, PROTO_OPTS));
  // pkg shape: { sentrix: { v1: { Sentrix: <ServiceClient ctor> } } }
  const ctor = (pkg as unknown as { sentrix: { v1: { Sentrix: new (...args: unknown[]) => GrpcServiceClient } } })
    .sentrix.v1.Sentrix;
  if (typeof ctor !== "function") {
    throw new Error("@sentrix/chain/grpc: failed to load sentrix.v1.Sentrix service from bundled proto");
  }
  cachedDef = { ctor };
  return cachedDef;
}

interface GrpcServiceShape {
  ctor: new (target: string, creds: ChannelCredentials) => GrpcServiceClient;
}

// Method shape — proto-loader generates per-method functions. Typing
// stays loose intentionally: the .proto is the source of truth, and
// hand-mirroring every message type would drift the moment chain v0.5
// adds a field. Callers cast at the use site if they need a strict
// shape.
interface GrpcServiceClient {
  getBlock(req: object, cb: GrpcUnaryCallback): void;
  getBalance(req: object, cb: GrpcUnaryCallback): void;
  getValidatorSet(req: object, cb: GrpcUnaryCallback): void;
  getSupply(req: object, cb: GrpcUnaryCallback): void;
  getMempool(req: object, cb: GrpcUnaryCallback): void;
  streamEvents(req: object): ClientReadableStream<unknown>;
  close(): void;
}
type GrpcUnaryCallback = (err: Error | null, resp: unknown) => void;

export interface GrpcClientOptions {
  /** Override the gRPC endpoint host:port. Defaults to the network's
   * public endpoint (`grpc.sentrixchain.com:443` for mainnet,
   * `grpc-testnet.sentrixchain.com:443` for testnet). */
  endpoint?: string;
  /** Use insecure (plaintext) credentials instead of TLS. Local
   * sidecar dev only — NEVER on a public endpoint. */
  insecure?: boolean;
}

export class GrpcClient {
  private readonly inner: GrpcServiceClient;

  constructor(network: SentrixNetwork, opts: GrpcClientOptions = {}) {
    const endpoint = opts.endpoint ?? defaultEndpoint(network);
    const creds = opts.insecure ? credentials.createInsecure() : credentials.createSsl();
    const { ctor } = getServiceDef();
    this.inner = new ctor(endpoint, creds);
  }

  /** GetBlock { latest: true } — latest finalized block. */
  async getLatestBlock(): Promise<unknown> {
    return this.unary("getBlock", { latest: true });
  }

  /** GetBlock { height } — block at a specific height. Throws
   * tonic::Status equivalent if the height has been pruned. */
  async getBlockByHeight(height: bigint | number): Promise<unknown> {
    return this.unary("getBlock", { height: { value: height.toString() } });
  }

  /** GetBalance — current native + EVM balance for a 20-byte address.
   * `address` accepts hex string (with or without 0x) or raw Buffer. */
  async getBalance(address: string | Buffer): Promise<unknown> {
    const bytes = typeof address === "string" ? hexToBytes(address) : address;
    return this.unary("getBalance", { address: { value: bytes } });
  }

  /** v0.4+ only — full validator set with active/jail flags. */
  async getValidatorSet(atHeight?: bigint | number): Promise<unknown> {
    const req: Record<string, unknown> = {};
    if (atHeight !== undefined) req.atHeight = { value: atHeight.toString() };
    return this.unary("getValidatorSet", req);
  }

  /** v0.4+ only — minted/burned/circulating snapshot. */
  async getSupply(atHeight?: bigint | number): Promise<unknown> {
    const req: Record<string, unknown> = {};
    if (atHeight !== undefined) req.atHeight = { value: atHeight.toString() };
    return this.unary("getSupply", req);
  }

  /** v0.4+ only — pending-tx size + capped header window. */
  async getMempool(limit = 100): Promise<unknown> {
    return this.unary("getMempool", { limit });
  }

  /** Server-stream of ChainEvent. Returns a Node Readable-like stream.
   * Drain with `for await (const ev of stream) { … }` or
   * `stream.on("data", ev => …)`. Filters list is sent verbatim;
   * empty array = subscribe-all. */
  streamEvents(filters: number[] = []): ClientReadableStream<unknown> {
    return this.inner.streamEvents({ filters, fromSequence: 0 });
  }

  /** Close the underlying channel. Outstanding RPCs cancel. */
  close(): void {
    this.inner.close();
  }

  // ── internals ────────────────────────────────────────────────
  private unary(method: keyof GrpcServiceClient, req: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const fn = this.inner[method] as (
        r: object,
        cb: GrpcUnaryCallback,
      ) => void;
      fn.call(this.inner, req, (err, resp) => {
        if (err) reject(err);
        else resolve(resp);
      });
    });
  }
}

function defaultEndpoint(network: SentrixNetwork): string {
  // Public gRPC endpoint mirrors the JSON-RPC LB; same chain, same
  // backend. See network.ts for the full URL inventory.
  void getSpec; // referenced for future per-spec endpoint fields
  return network === "mainnet"
    ? "grpc.sentrixchain.com:443"
    : "grpc-testnet.sentrixchain.com:443";
}

function hexToBytes(hex: string): Buffer {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length !== 40) {
    throw new Error(
      `@sentrix/chain/grpc: address must be 20 bytes / 40 hex chars (got ${stripped.length})`,
    );
  }
  return Buffer.from(stripped, "hex");
}
