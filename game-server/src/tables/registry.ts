import { randomUUID } from "node:crypto";
import {
  type Seat, type TableState, createTable,
} from "@muhabbetly/batak-engine";
import type { RuntimeConfig } from "@muhabbetly/batak-engine";
import { TableRunner, type RunnerDeps } from "./runner.js";

/**
 * Acik masalarin kaydi ve eslestirme.
 *
 * Lansmanda tek varyant ve tek bahis seviyesi acik olmali: oyuncuyu bolen
 * her secenek masa dolulugunu dusurur ve masa bulamayan oyuncu geri gelmez.
 */

export interface JoinRequest {
  userId: string;
  username: string;
  variantId: string;
  /** Alistirma masasi: bahis yok, bos koltuklari bot alir. */
  practice?: boolean;
  /** Sohbet odasindan geldiyse: ayni odadaki masaya oturtulur. */
  roomId?: string | null;
  /** Arkadasla gel: bu masaya oturmak istiyor. */
  tableId?: string | null;
}

export type JoinResult =
  | { ok: true; tableId: string; seat: Seat }
  | { ok: false; code: "VARIANT_CLOSED" | "TABLE_FULL" | "TABLE_NOT_FOUND" | "ALREADY_SEATED"; message: string };

export class TableRegistry {
  private tables = new Map<string, TableRunner>();
  /** userId -> tableId. Bir oyuncu ayni anda tek masada oturur. */
  private seatedAt = new Map<string, string>();

  constructor(
    private deps: RunnerDeps,
    private getConfig: () => RuntimeConfig,
  ) {}

  get(tableId: string): TableRunner | undefined { return this.tables.get(tableId); }

  list(): Array<{
    tableId: string; variant: string; phase: string; practice: boolean;
    handNo: number; players: number; bots: number; roomId: string | null;
  }> {
    return [...this.tables.values()].map((r) => {
      const s = r.snapshot;
      return {
        tableId: s.tableId,
        variant: s.variant.id,
        phase: s.phase,
        practice: s.practice,
        handNo: s.handNo,
        players: s.seats.filter((x) => x.userId !== null).length,
        bots: s.seats.filter((x) => x.bot).length,
        roomId: s.roomId,
      };
    });
  }

  async join(req: JoinRequest): Promise<JoinResult> {
    const cfg = this.getConfig();

    if (this.seatedAt.has(req.userId)) {
      return { ok: false, code: "ALREADY_SEATED", message: "Zaten bir masadasiniz." };
    }

    // Belirli bir masaya davet edildiyse (arkadasla gel)
    if (req.tableId) {
      const r = this.tables.get(req.tableId);
      if (!r) return { ok: false, code: "TABLE_NOT_FOUND", message: "Masa bulunamadi." };
      return this.sit(r, req);
    }

    if (!cfg.enabled[req.variantId]) {
      return { ok: false, code: "VARIANT_CLOSED", message: "Bu oyun su an kapali." };
    }

    // Alistirma ve gercek masalar ayri havuzlardir: bahissiz oyuncu
    // bahisli masaya dusmemeli, tersi de.
    const wantPractice = req.practice === true;
    const open = [...this.tables.values()].filter((r) => {
      const s = r.snapshot;
      return s.phase === "waiting"
        && s.variant.id === req.variantId
        && s.practice === wantPractice
        && s.seats.some((x) => x.userId === null);
    });
    const preferred = req.roomId
      ? open.find((r) => r.snapshot.roomId === req.roomId) ?? open[0]
      : open[0];

    if (preferred) return this.sit(preferred, req);
    return this.sit(
      this.create(req.variantId, req.roomId ?? null, wantPractice), req,
    );
  }

  private create(
    variantId: string, roomId: string | null, practice: boolean,
  ): TableRunner {
    const cfg = this.getConfig();
    const state: TableState = createTable({
      tableId: randomUUID(),
      // Ayarin KOPYASI masaya yazilir: panelden kural degisse bile bu masa
      // kendi kurallariyla biter.
      variant: cfg.variants[variantId],
      timers: cfg.timers,
      endCondition: { kind: "fixedHands", value: practice ? 2 : 4 },
      // Alistirma masasi bahissizdir; bota karsi kazanilan jeton ekonomiye
      // yoktan girmesin.
      stake: practice ? 0 : (cfg.stakes[variantId] ?? 0),
      botFillSeconds: practice ? 30 : 0,
      roomId,
    });
    const runner = new TableRunner(state, this.deps);
    this.tables.set(state.tableId, runner);
    return runner;
  }

  private async sit(r: TableRunner, req: JoinRequest): Promise<JoinResult> {
    const s = r.snapshot;
    const seat = s.seats.findIndex((x) => x.userId === null) as Seat | -1;
    if (seat === -1) {
      return { ok: false, code: "TABLE_FULL", message: "Masa dolu." };
    }
    const res = await r.enqueue({
      type: "join", seat: seat as Seat,
      userId: req.userId, username: req.username, now: Date.now(),
    });
    if (res.error) {
      return { ok: false, code: "TABLE_FULL", message: res.error.message };
    }
    this.seatedAt.set(req.userId, r.id);
    return { ok: true, tableId: r.id, seat: seat as Seat };
  }

  async leave(userId: string): Promise<void> {
    const tableId = this.seatedAt.get(userId);
    if (!tableId) return;
    const r = this.tables.get(tableId);
    this.seatedAt.delete(userId);
    if (!r) return;
    const seat = r.snapshot.seats.findIndex((x) => x.userId === userId);
    if (seat >= 0) {
      await r.enqueue({ type: "leave", seat: seat as Seat, now: Date.now() });
    }
  }

  async disconnect(userId: string): Promise<void> {
    const r = this.runnerFor(userId);
    if (!r) return;
    const seat = r.snapshot.seats.findIndex((x) => x.userId === userId);
    if (seat >= 0) {
      await r.enqueue({ type: "disconnect", seat: seat as Seat, now: Date.now() });
    }
  }

  async reconnect(userId: string): Promise<TableRunner | null> {
    const r = this.runnerFor(userId);
    if (!r) return null;
    const seat = r.snapshot.seats.findIndex((x) => x.userId === userId);
    if (seat >= 0) {
      await r.enqueue({ type: "reconnect", seat: seat as Seat, now: Date.now() });
    }
    return r;
  }

  runnerFor(userId: string): TableRunner | undefined {
    const id = this.seatedAt.get(userId);
    return id ? this.tables.get(id) : undefined;
  }

  seatOf(userId: string): Seat | null {
    const r = this.runnerFor(userId);
    if (!r) return null;
    const i = r.snapshot.seats.findIndex((x) => x.userId === userId);
    return i >= 0 ? (i as Seat) : null;
  }

  /** Biten masalari bellekten duser. Duzenli cagrilir. */
  sweep(): number {
    let n = 0;
    for (const [id, r] of this.tables) {
      const s = r.snapshot;
      if (s.phase !== "finished") continue;
      r.close();
      for (const seat of s.seats) {
        if (seat.userId) this.seatedAt.delete(seat.userId);
      }
      this.tables.delete(id);
      n++;
    }
    return n;
  }
}
