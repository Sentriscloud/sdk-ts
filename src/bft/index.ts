// BFT door — WebSocket subscription helpers for the 9 Sentrix channels.
//
// All subscriptions go through `eth_subscribe`, even the Sentrix-native
// channels (sentrix_finalized, sentrix_validatorSet, sentrix_tokenOps,
// sentrix_stakingOps, sentrix_jail). The chain dispatches them by channel
// name — there is no separate `sentrix_subscribe` method, common
// confusion source.

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

/** Open a single subscription on a fresh WS connection. Use this when
 *  you want one channel and don't mind a dedicated socket. For
 *  multi-channel usage, instantiate `SubscriptionManager` once and
 *  call `subscribe` repeatedly to share a single connection. */
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
}

/** Multiplexes many subscriptions over one WebSocket. Reconnects with
 *  exponential backoff on close (1s → 2s → 4s → 8s → 16s, capped 30s);
 *  re-subscribes registered channels after each reconnect. */
export class SubscriptionManager {
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private subs = new Map<string, InternalSub>(); // serverId → sub
  private pending = new Map<number, (id: string) => void>(); // jsonrpc id → resolver
  private backoffMs = 1000;
  private closed = false;

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
      this.pending.set(id, resolve);
      const payload = { jsonrpc: "2.0", id, method: "eth_subscribe", params };
      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`subscribe ${channel} timed out`));
      }, 10_000);
    });

    this.subs.set(serverId, { channel, serverId, onMessage: opts.onMessage });

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

  /** Close the underlying socket and stop reconnecting. */
  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private ensureSocket(onError?: (err: Error) => void): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      ws.on("open", () => {
        this.backoffMs = 1000;
        resolve();
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString());
        // Subscribe-response (one-time): { id, result: "0x..." }
        if (typeof msg.id === "number" && typeof msg.result === "string") {
          const cb = this.pending.get(msg.id);
          if (cb) {
            this.pending.delete(msg.id);
            cb(msg.result);
          }
          return;
        }
        // Stream event: { method: "eth_subscription", params: { subscription, result } }
        if (msg.method === "eth_subscription") {
          const sid = msg.params?.subscription as string | undefined;
          if (!sid) return;
          const sub = this.subs.get(sid);
          sub?.onMessage(msg.params.result, sub.channel);
        }
      });

      ws.on("error", (err) => {
        if (onError) onError(err);
        if (this.pending.size > 0) {
          for (const r of this.pending.keys()) this.pending.delete(r);
          reject(err);
        }
      });

      ws.on("close", () => {
        if (this.closed) return;
        // Reconnect with exponential backoff, then re-subscribe.
        const wait = Math.min(this.backoffMs, 30_000);
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
        setTimeout(() => {
          this.ensureSocket(onError)
            .then(() => this.resubscribeAll(onError))
            .catch(() => {});
        }, wait);
      });
    });
  }

  private async resubscribeAll(onError?: (err: Error) => void): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const stale = Array.from(this.subs.values());
    this.subs.clear();
    for (const old of stale) {
      try {
        await this.subscribe(old.channel, { onMessage: old.onMessage, onError });
      } catch (err) {
        onError?.(err as Error);
      }
    }
  }
}
