import {
  type Effect, type Seat, type StepResult, type TableEvent,
  type TableInput, type TableState, step, viewFor,
} from "@muhabbetly/batak-engine";
import type { EventStore } from "../effects/persist.js";
import type { ReverbClient } from "../effects/reverb.js";
import { publicEvents } from "../effects/reverb.js";
import { type WalletClient, walletKey } from "../effects/wallet.js";

/**
 * Bir masayi calistirir.
 *
 * Aktor SAFTIR: zamani ve yan etkiyi bilmez. Bu sinif zamani tutar,
 * efektleri gercek cagrilara cevirir ve istemcilere gorunum gonderir.
 *
 * Her masa TEK threadli bir kuyruk gibi isler: `enqueue` ile gelen girdiler
 * sirayla islenir. Race condition sorunu kokten biter.
 */

export interface RunnerDeps {
  wallet: WalletClient;
  reverb: ReverbClient;
  store: EventStore;
  /** Bir koltuga ozel gorunum gonderir. Koltuk bostaysa cagrilmaz. */
  sendToSeat(tableId: string, seat: Seat, payload: unknown): void;
  log(level: "info" | "warn" | "error", msg: string, meta?: unknown): void;
  now?(): number;
}

export class TableRunner {
  private state: TableState;
  private queue: TableInput[] = [];
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private handId: number | null = null;
  private closed = false;

  constructor(initial: TableState, private d: RunnerDeps) {
    this.state = initial;
  }

  get snapshot(): TableState { return this.state; }
  get id(): string { return this.state.tableId; }

  private now(): number { return this.d.now ? this.d.now() : Date.now(); }

  /** Girdiyi kuyruga koyar. Donus, islendikten sonraki sonuctur. */
  async enqueue(input: TableInput): Promise<{ error?: { code: string; message: string } }> {
    if (this.closed) return { error: { code: "TABLE_CLOSED", message: "Masa kapandi." } };
    this.queue.push(input);
    return this.drain();
  }

  private async drain(): Promise<{ error?: { code: string; message: string } }> {
    if (this.running) return {};
    this.running = true;
    let lastError: { code: string; message: string } | undefined;

    try {
      while (this.queue.length > 0) {
        const input = this.queue.shift()!;
        const r: StepResult = step(this.state, input);
        if (r.error) { lastError = r.error; continue; }
        this.state = r.state;
        await this.runEffects(r.effects, r.events);
        this.pushViews();
      }
    } finally {
      this.running = false;
    }
    return lastError ? { error: lastError } : {};
  }

  // ------------------------------------------------------------- efektler

  private async runEffects(effects: Effect[], events: TableEvent[]): Promise<void> {
    for (const e of effects) {
      try {
        switch (e.kind) {
          case "schedule": this.schedule(e.at); break;
          case "persist_events": await this.persist(e.events, events); break;
          case "publish":
            await this.d.reverb.publish(e.channel, "oyun", publicEvents(e.events));
            break;
          case "wallet_hold": await this.hold(e); break;
          case "wallet_settle": await this.settle(e); break;
          case "wallet_release": await this.release(e); break;
        }
      } catch (err) {
        // Efekt hatasi masayi dusurmez. Cuzdan hatalari ayrica ele alinir.
        this.d.log("error", `efekt hatasi: ${e.kind}`, { err: String(err), table: this.id });
      }
    }
  }

  private async persist(evts: TableEvent[], all: TableEvent[]): Promise<void> {
    const started = all.find((x) => x.type === "hand_started") as any;
    if (started) {
      this.handId = await this.d.store.startHand(
        this.id, this.state.handNo, started.seedHash,
      );
    }
    await this.d.store.append(this.id, evts as any, this.handId);

    const ended = all.find((x) => x.type === "hand_ended") as any;
    if (ended && this.handId !== null) {
      await this.d.store.endHand(this.handId, ended.seed, ended.scores);
    }
    if (this.state.phase === "finished") {
      await this.d.store.upsertTable({
        id: this.id, game: "batak", variant: this.state.variant,
        stake: this.state.stake, roomId: this.state.roomId, status: "finished",
      });
      this.close();
    }
  }

  private async hold(e: Extract<Effect, { kind: "wallet_hold" }>): Promise<void> {
    const key = walletKey("hold", e.tableId, e.handNo);
    const r = await this.d.wallet.hold({
      idempotencyKey: key, tableId: e.tableId, handNo: e.handNo,
      userIds: e.userIds, amount: e.amount,
    });

    for (const u of e.userIds) {
      await this.d.store.logWalletCall({
        key: `${key}:${u}`, tableId: e.tableId, userId: u,
        op: "hold", amount: e.amount,
        status: r.ok ? "ok" : "failed", response: r,
      }).catch(() => {});
    }

    if (r.ok) return;

    // Bahis bloke edilemedi: el baslamamali. Masayi kapat, oyunculara soyle.
    this.d.log("warn", "cuzdan hold basarisiz", { table: this.id, r });
    const reason = r.code === "INSUFFICIENT_FUNDS"
      ? "Bir oyuncunun bakiyesi yetmedi."
      : "Cuzdan servisine ulasilamadi.";

    await this.d.reverb.publish(`table.${this.id}`, "oyun", [
      { type: "hand_aborted", reason },
    ]).catch(() => {});

    for (const s of [0, 1, 2, 3] as Seat[]) {
      this.d.sendToSeat(this.id, s, { type: "hand_aborted", reason });
    }
    await this.d.store.upsertTable({
      id: this.id, game: "batak", variant: this.state.variant,
      stake: this.state.stake, roomId: this.state.roomId, status: "abandoned",
    }).catch(() => {});
    this.close();
  }

  private async settle(e: Extract<Effect, { kind: "wallet_settle" }>): Promise<void> {
    const key = walletKey("settle", e.tableId, e.handNo);
    const r = await this.d.wallet.settle({
      idempotencyKey: key, tableId: e.tableId, handNo: e.handNo,
      userIds: e.userIds, deltas: e.deltas,
    });
    for (let i = 0; i < e.userIds.length; i++) {
      await this.d.store.logWalletCall({
        key: `${key}:${e.userIds[i]}`, tableId: e.tableId, userId: e.userIds[i],
        op: "settle", amount: e.deltas[i],
        status: r.ok ? "ok" : "failed", response: r,
      }).catch(() => {});
    }
    if (!r.ok) {
      // KRITIK: el oynandi ama para yazilamadi. Idempotent anahtar sayesinde
      // tekrar denenebilir; mutabakat isi icin alarm uretilir.
      this.d.log("error", "cuzdan settle basarisiz — MUTABAKAT GEREKIYOR", {
        table: this.id, handNo: e.handNo, key, r,
      });
    }
  }

  private async release(e: Extract<Effect, { kind: "wallet_release" }>): Promise<void> {
    const key = walletKey("release", e.tableId, e.handNo);
    await this.d.wallet.release({
      idempotencyKey: key, tableId: e.tableId, handNo: e.handNo,
      userIds: e.userIds, amount: e.amount,
    });
  }

  // ------------------------------------------------------------- zamanlayici

  private schedule(at: number): void {
    const delay = Math.max(0, at - this.now());
    if (this.timer) clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue({ type: "tick", now: this.now() });
    }, delay + 5); // +5ms: deadline'in gectiginden emin ol
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  // ------------------------------------------------------------- gorunum

  /** Her koltuga YALNIZCA kendi kartlarini iceren gorunum gonderir. */
  private pushViews(): void {
    for (const s of [0, 1, 2, 3] as Seat[]) {
      if (this.state.seats[s].userId === null) continue;
      this.d.sendToSeat(this.id, s, { type: "state", view: viewFor(this.state, s) });
    }
  }

  viewFor(seat: Seat | null): unknown { return viewFor(this.state, seat); }

  close(): void {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
