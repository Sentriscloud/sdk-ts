// BFT door — WebSocket subscription helpers for the 9 Sentrix channels.
//
// All subscriptions go through `eth_subscribe`, even the Sentrix-native
// channels (sentrix_finalized, sentrix_validatorSet, sentrix_tokenOps,
// sentrix_stakingOps, sentrix_jail). The chain dispatches them by
// channel name — there is no separate `sentrix_subscribe` method,
// common confusion source.
//
// Recommended usage: instantiate `SubscriptionManager` once per process
// + call `.subscribe()` repeatedly. The manager multiplexes every
// subscription over one socket, sends keepalive pings every 30 s, and
// transparently re-subscribes after reconnect. The single-shot
// `subscribe(network, channel, opts)` helper is convenient for one-off
// scripts but opens its own socket — avoid in production code that
// listens to multiple channels.

import WebSocket from "ws";
import { getSpec, type SentrixNetwork } from "../network.js";

export type Channel =
  // Standard EVM
  | "newHeads"
  | "logs"
  | "newPendingTransactions"
  | "syncing"
  // Sentrix native (all dispatched via eth_subscribe by name)
  | "sentrix_finalized"
  | "sentrix_validatorSet"
  | "sentrix_tokenOps"
  | "sentrix_stakingOps"
  | "sentrix_jail";

// Discriminated payload type per channel. Consumers that opt into
// `subscribeTyped<C>()` get a precise payload type; the original
// untyped `subscribe()` path stays for back-compat with existing apps.
export interface NewHeadsPayload {
  number: `0x${string}`;
  hash: `0x${string}`;
  parentHash: `0x${string}`;
  timestamp: `0x${string}`;
  miner: `0x${string}`;
}
export interface LogsPayload {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: `0x${string}`;
  removed: boolean;
}
export type SentrixFinalizedPayload = { height: number; hash: `0x${string}` };
export type SentrixValidatorSetPayload = { epoch: number; validators: `0x${string}`[] };
// Native ops payloads stay loose for now — chain shape is still
// stabilising and a precise type would lag the source. Apps cast at
// the use site if they need a stricter shape.
export type SentrixOpsPayload = Record<string, unknown>;

export interface ChannelPayloadMap {
  newHeads: NewHeadsPayload;
  logs: LogsPayload;
  newPendingTransactions: `0x${string}`;
  syncing: boolean | { startingBlock: `0x${string}`; currentBlock: `0x${string}`; highestBlock: `0x${string}` };
  sentrix_finalized: SentrixFinalizedPayload;
  sentrix_validatorSet: SentrixValidatorSetPayload;
  sentrix_tokenOps: SentrixOpsPayload;
  sentrix_stakingOps: SentrixOpsPayload;
  sentrix_jail: SentrixOpsPayload;
}

export interface SubscribeOptions {
  /** Override the WS URL. */
  wsUrl?: string;
  /** For `logs`, the filter object passed as second arg. */
  filter?: Record<string, unknown>;
  /** Called when a subscription event arrives. */
  onMessage: (payload: unknown, channel: Channel) => void;
  /** Called on socket error / unexpected close. */
  onError?: (err: Error) => void;
}

export interface Subscription {
  /** Unsubscribe + close the underlying socket. */
  close(): Promise<void>;
}

/** Open a single subscription on a fresh WS connection. Convenience for
 *  one-off scripts. For multi-channel usage, instantiate
 *  `SubscriptionManager` once and call `subscribe` repeatedly to share
 *  a single connection — opening N sockets for N channels burns server
 *  file descriptors and breaks the per-IP connection cap. */
export function subscribe(
  network: SentrixNetwork,
  channel: Channel,
  opts: SubscribeOptions,
): Promise<Subscription> {
  const mgr = new SubscriptionManager(network, opts.wsUrl);
  return mgr.subscribe(channel, opts).then((sub) => ({
    close: async () => {
      await sub.close();
      mgr.close();
    },
  }));
}

interface InternalSub {
  channel: Channel;
  serverId: string;
  onMessage: (payload: unknown, channel: Channel) => void;
  onError?: (err: Error) => void;
  filter?: Record<string, unknown>;
}

interface PendingSubscribe {
  channel: Channel;
  resolve: (serverId: string) => void;
  reject: (err: Error) => void;
}

/** Multiplexes many subscriptions over one WebSocket. Reconnects with
 *  exponential backoff on close (1s → 2s → 4s → 8s → 16s → 30s capped);
 *  re-subscribes registered channels after each reconnect. Sends a
 *  WebSocket ping frame every 30 s to keep middleboxes (NAT, ALB, Caddy)
 *  from killing the connection during quiet periods. */
export class SubscriptionManager {
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private subs = new Map<string, InternalSub>(); // serverId → sub
  private pending = new Map<number, PendingSubscribe>(); // jsonrpc id → callback pair
  private backoffMs = 1000;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Last time a frame (subscribe-response, event, or pong) arrived.
   * Used by the keepalive interval to detect a half-open connection. */
  private lastFrameAt = 0;
  /** How long to wait between pings + how long without a frame before
   * we consider the socket dead and force a reconnect. Tunable per
   * environment via constructor. */
  private static readonly KEEPALIVE_INTERVAL_MS = 30_000;
  private static readonly STALE_TIMEOUT_MS = 90_000;

  constructor(network: SentrixNetwork, wsUrl?: string) {
    this.wsUrl = wsUrl ?? getSpec(network).wsUrl;
  }

  async subscribe(
    channel: Channel,
    opts: { filter?: Record<string, unknown>; onMessage: (payload: unknown, channel: Channel) => void; onError?: (err: Error) => void },
  ): Promise<Subscription> {
    await this.ensureSocket(opts.onError);
    const id = this.nextId++;
    const params: unknown[] = [channel];
    if (channel === "logs" && opts.filter) params.push(opts.filter);

    const serverId = await new Promise<string>((resolve, reject) => {
      this.pending.set(id, { channel, resolve, reject });
      const payload = { jsonrpc: "2.0", id, method: "eth_subscribe", params };
      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`subscribe ${channel} timed out`));
      }, 10_000);
    });

    this.subs.set(serverId, {
      channel,
      serverId,
      onMessage: opts.onMessage,
      onError: opts.onError,
      filter: opts.filter,
    });

    return {
      close: async () => {
        this.subs.delete(serverId);
        try {
          this.ws?.send(JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "eth_unsubscribe", params: [serverId] }));
        } catch {
          // socket may already be closed; that's fine.
        }
      },
    };
  }

  /** Typed alternative to `subscribe`. The payload type is derived
   * from the channel via `ChannelPayloadMap` — `subscribeTyped("newHeads", ...)`
   * gives `payload: NewHeadsPayload` instead of `unknown`. */
  subscribeTyped<C extends Channel>(
    channel: C,
    opts: {
      filter?: Record<string, unknown>;
      onMessage: (payload: ChannelPayloadMap[C]) => void;
      onError?: (err: Error) => void;
    },
  ): Promise<Subscription> {
    return this.subscribe(channel, {
      filter: opts.filter,
      onMessage: (p) => opts.onMessage(p as ChannelPayloadMap[C]),
      onError: opts.onError,
    });
  }

  /** Close the underlying socket and stop reconnecting. */
  close(): void {
    this.closed = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /** Diagnostic snapshot — useful for ops dashboards / debug pages. */
  status(): {
    socketState: "open" | "connecting" | "closed";
    subs: number;
    secondsSinceLastFrame: number | null;
  } {
    const sec =
      this.lastFrameAt === 0 ? null : Math.floor((Date.now() - this.lastFrameAt) / 1000);
    let state: "open" | "connecting" | "closed" = "closed";
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) state = "open";
      else if (this.ws.readyState === WebSocket.CONNECTING) state = "connecting";
    }
    return { socketState: state, subs: this.subs.size, secondsSinceLastFrame: sec };
  }

  private ensureSocket(onError?: (err: Error) => void): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      ws.on("open", () => {
        this.backoffMs = 1000;
        this.lastFrameAt = Date.now();
        this.startKeepalive();
        resolve();
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        this.lastFrameAt = Date.now();
        let msg: { id?: number; result?: string; method?: string; params?: { subscription?: string; result?: unknown }; error?: { message: string } };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          // Malformed frame — drop. Can happen on edge buffer fragmentation.
          return;
        }
        // Subscribe-response (one-time): { id, result: "0x..." } OR { id, error }
        if (typeof msg.id === "number" && (typeof msg.result === "string" || msg.error)) {
          const cb = this.pending.get(msg.id);
          if (!cb) return;
          this.pending.delete(msg.id);
          if (msg.error) {
            cb.reject(new Error(`eth_subscribe ${cb.channel}: ${msg.error.message}`));
          } else if (typeof msg.result === "string") {
            cb.resolve(msg.result);
          }
          return;
        }
        // Stream event: { method: "eth_subscription", params: { subscription, result } }
        if (msg.method === "eth_subscription") {
          const sid = msg.params?.subscription;
          if (!sid) return;
          const sub = this.subs.get(sid);
          sub?.onMessage(msg.params!.result, sub.channel);
        }
      });

      // Pong frame from server keepalive ping. Resets the
      // last-frame timestamp so a long-quiet subscription (eg
      // sentrix_jail with no events for hours) doesn't trip the
      // stale-connection guard.
      ws.on("pong", () => {
        this.lastFrameAt = Date.now();
      });

      ws.on("error", (err) => {
        if (onError) onError(err);
        // Reject every pending subscribe — pre-fix only the first
        // pending caller saw the rejection, the rest hung until their
        // 10 s timeout fired one-by-one. Now they all get the same
        // surfaced error immediately.
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(err);
        }
        // Surface to per-sub error handlers too.
        for (const sub of this.subs.values()) sub.onError?.(err);
        reject(err);
      });

      ws.on("close", () => {
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        // Reject any pending subscribes — same race fix as the error
        // path. Without this a subscribe in flight when the close
        // lands resolves never (the stream-event path can't fire on
        // a closed socket).
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(new Error("websocket closed before subscribe response"));
        }
        if (this.closed) return;
        // Reconnect with exponential backoff, then re-subscribe.
        const wait = Math.min(this.backoffMs, 30_000);
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
        setTimeout(() => {
          this.ensureSocket(onError)
            .then(() => this.resubscribeAll(onError))
            .catch(() => {
              /* will retry via the next close event */
            });
        }, wait);
      });
    });
  }

  /** Send a WebSocket ping frame every KEEPALIVE_INTERVAL_MS. If the
   * socket has gone STALE_TIMEOUT_MS without any frame, force a close
   * (which triggers the reconnect path). Middleboxes — Caddy
   * reverse_proxy idle_timeout, NAT, AWS ALB — drop quiet
   * connections at 60–120 s; the ping keeps them open. */
  private startKeepalive(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const idle = Date.now() - this.lastFrameAt;
      if (idle > SubscriptionManager.STALE_TIMEOUT_MS) {
        // Half-open — server stopped pong'ing. Force close so the
        // close handler fires and reconnects.
        try {
          this.ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        this.ws.ping();
      } catch {
        /* socket may have closed mid-call; close handler will recover */
      }
    }, SubscriptionManager.KEEPALIVE_INTERVAL_MS);
  }

  private async resubscribeAll(onError?: (err: Error) => void): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const stale = Array.from(this.subs.values());
    this.subs.clear();
    for (const old of stale) {
      try {
        await this.subscribe(old.channel, {
          filter: old.filter,
          onMessage: old.onMessage,
          onError: old.onError ?? onError,
        });
      } catch (err) {
        (old.onError ?? onError)?.(err as Error);
      }
    }
  }
}
