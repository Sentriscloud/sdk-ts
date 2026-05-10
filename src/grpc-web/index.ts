// gRPC-Web door — browser-side client for the chain's `sentrix.v1.Sentrix`
// service. Mirror of the Node-side `@sentrix/chain/grpc` API but over
// `@protobuf-ts/grpcweb-transport` instead of `@grpc/grpc-js`, so it
// works in the browser bundle without HTTP/2 raw socket access.
//
// The chain accepts gRPC-Web at the same endpoint as native gRPC —
// Caddy at the edge runs `tonic-web` to transcode between the two. So
// browser dApps connect to the same `grpc.sentrixchain.com:443`
// hostname; only the transport changes.
//
// Why a thin wrapper instead of asking callers to wire the transport
// themselves: hide endpoint resolution, package the generated stubs
// behind a stable surface, and keep the API shape identical to the
// Node `/grpc` subpath so dApp code that reads from both rails (eg an
// Electron app or a desktop CLI sharing a UI lib) doesn't need to
// branch per environment.

import { GrpcWebFetchTransport } from "@protobuf-ts/grpcweb-transport";
import { SentrixClient as InnerClient } from "./sentrix.client.js";
import {
  GetBlockRequest,
  GetBalanceRequest,
  GetValidatorSetRequest,
  GetSupplyRequest,
  GetMempoolRequest,
  StreamEventsRequest,
} from "./sentrix.js";
import type {
  Block,
  Account,
  ValidatorSet,
  Supply,
  Mempool,
  ChainEvent,
  EventFilter,
} from "./sentrix.js";
import type { SentrixNetwork } from "../network.js";

export interface GrpcWebClientOptions {
  /** Override the gRPC-Web endpoint host. Defaults to the network's
   * public endpoint (`https://grpc.sentrixchain.com` mainnet,
   * `https://grpc-testnet.sentrixchain.com` testnet). Must include the
   * scheme — gRPC-Web speaks plain HTTP framing on top of TLS, so the
   * URL is `https://...` not `grpc://...`. */
  endpoint?: string;
  /** Pass through to fetch — useful for credentials / cookies in
   * authenticated proxy setups. */
  fetchInit?: Partial<RequestInit>;
}

/** Browser-friendly gRPC-Web client. Same surface as the Node-side
 * `@sentrix/chain/grpc` client; pick the subpath that fits your
 * runtime. */
export class GrpcWebClient {
  private readonly inner: InnerClient;

  constructor(network: SentrixNetwork, opts: GrpcWebClientOptions = {}) {
    const endpoint = opts.endpoint ?? defaultEndpoint(network);
    const transport = new GrpcWebFetchTransport({
      baseUrl: endpoint,
      fetchInit: opts.fetchInit,
    });
    this.inner = new InnerClient(transport);
  }

  /** GetBlock { latest: true } — latest finalised block. */
  async getLatestBlock(): Promise<Block> {
    const req = GetBlockRequest.create({ selector: { oneofKind: "latest", latest: true } });
    return (await this.inner.getBlock(req)).response;
  }

  /** GetBlock { height } — block at a specific height. Throws if the
   * chain pruned it. */
  async getBlockByHeight(height: bigint | number): Promise<Block> {
    const req = GetBlockRequest.create({
      selector: {
        oneofKind: "height",
        height: { value: BigInt(height) },
      },
    });
    return (await this.inner.getBlock(req)).response;
  }

  /** GetBalance — current balance for a 20-byte address. */
  async getBalance(address: string | Uint8Array): Promise<Account> {
    const bytes =
      typeof address === "string" ? hexToBytes(address) : address;
    if (bytes.length !== 20) {
      throw new Error(
        `@sentrix/chain/grpc-web: address must be 20 bytes (got ${bytes.length})`,
      );
    }
    const req = GetBalanceRequest.create({ address: { value: bytes } });
    return (await this.inner.getBalance(req)).response;
  }

  /** v0.4+ — ValidatorSet snapshot. */
  async getValidatorSet(atHeight?: bigint | number): Promise<ValidatorSet> {
    const req = GetValidatorSetRequest.create(
      atHeight !== undefined
        ? { atHeight: { value: BigInt(atHeight) } }
        : {},
    );
    return (await this.inner.getValidatorSet(req)).response;
  }

  /** v0.4+ — Supply snapshot. */
  async getSupply(atHeight?: bigint | number): Promise<Supply> {
    const req = GetSupplyRequest.create(
      atHeight !== undefined
        ? { atHeight: { value: BigInt(atHeight) } }
        : {},
    );
    return (await this.inner.getSupply(req)).response;
  }

  /** v0.4+ — Mempool snapshot. `limit = 0` ⇒ server default (100). */
  async getMempool(limit = 100): Promise<Mempool> {
    const req = GetMempoolRequest.create({ limit });
    return (await this.inner.getMempool(req)).response;
  }

  /** v0.4+ — server-streaming chain events. Drain with for-await:
   *
   *   for await (const ev of client.streamEvents([])) { … }
   *
   * Empty filter list = subscribe-all. */
  async *streamEvents(filters: EventFilter[] = []): AsyncIterable<ChainEvent> {
    const req = StreamEventsRequest.create({ filters, fromSequence: 0n });
    const call = this.inner.streamEvents(req);
    for await (const ev of call.responses) {
      yield ev;
    }
  }
}

function defaultEndpoint(network: SentrixNetwork): string {
  return network === "mainnet"
    ? "https://grpc.sentrixchain.com"
    : "https://grpc-testnet.sentrixchain.com";
}

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length % 2 !== 0) {
    throw new Error(`@sentrix/chain/grpc-web: hex address has odd length: ${stripped.length}`);
  }
  const out = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
