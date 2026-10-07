import type { Pool, PoolClient } from "pg";

/**
 * Yerel cuzdan.
 *
 * Jeton defteri ayni veritabaninda oldugu icin hold/settle tek transaction.
 * HTTP cagrisi, imza, zaman asimi, mutabakat alarmi yok — ya hepsi olur ya
 * hicbiri. Bu, HTTP'li surumden hem daha sade hem daha saglam.
 *
 * TableRunner'in bekledigi arayuzle ayni imzayi tasir; runner degismez.
 */

export type WalletResult =
  | { ok: true; balances: Record<string, number> }
  | { ok: false; code: "INSUFFICIENT_FUNDS"; userIds: string[] }
  | { ok: false; code: "UNAVAILABLE" | "REJECTED"; message: string };

export interface HoldRequest {
  idempotencyKey: string; tableId: string; handNo: number;
  userIds: string[]; amount: number;
}
export interface SettleRequest {
  idempotencyKey: string; tableId: string; handNo: number;
  userIds: string[]; deltas: number[];
}
export interface ReleaseRequest {
  idempotencyKey: string; tableId: string; handNo: number;
  userIds: string[]; amount: number;
}

export class LocalWallet {
  constructor(private pool: Pool) {}

  /** El basinda bahsi bloke eder. Biri yetmezse HICBIRI bloke edilmez. */
  async hold(r: HoldRequest): Promise<WalletResult> {
    return this.tx(async (c) => {
      if (await this.alreadyDone(c, r.idempotencyKey)) {
        return { ok: true as const, balances: await this.balances(c, r.userIds) };
      }
      if (r.amount === 0) {
        await this.mark(c, r.idempotencyKey, r.userIds[0], "hold", 0, r.tableId, r.handNo, c);
        return { ok: true as const, balances: await this.balances(c, r.userIds) };
      }

      // Kilitli okuma. Sira SABIT (id'ye gore) ki iki masa ayni iki oyuncuyu
      // ters sirayla kilitleyip birbirini beklemesin.
      const ids = [...r.userIds].sort();
      const { rows } = await c.query<{ player_id: string; balance: string; held: string }>(
        `SELECT player_id, balance, held FROM wallets
          WHERE player_id = ANY($1::uuid[])
          ORDER BY player_id
          FOR UPDATE`,
        [ids],
      );
      const byId = new Map(rows.map((x) => [x.player_id, x]));

      const short: string[] = [];
      for (const id of r.userIds) {
        const w = byId.get(id);
        const free = w ? Number(w.balance) - Number(w.held) : 0;
        if (free < r.amount) short.push(id);
      }
      if (short.length > 0) {
        return { ok: false as const, code: "INSUFFICIENT_FUNDS" as const, userIds: short };
      }

      for (const id of r.userIds) {
        const { rows: u } = await c.query<{ balance: string; held: string }>(
          `UPDATE wallets SET held = held + $2, updated_at = now()
            WHERE player_id = $1 RETURNING balance, held`,
          [id, r.amount],
        );
        await c.query(
          `INSERT INTO wallet_ledger
             (player_id, op, amount, balance_after, held_after, table_id, hand_no, idempotency_key)
           VALUES ($1,'hold',$2,$3,$4,$5,$6,$7)`,
          [id, r.amount, Number(u[0].balance), Number(u[0].held),
           r.tableId, r.handNo, `${r.idempotencyKey}:${id}`],
        );
      }
      return { ok: true as const, balances: await this.balances(c, r.userIds) };
    });
  }

  /** El sonunda bloke acilir ve net degisim yazilir. */
  async settle(r: SettleRequest): Promise<WalletResult> {
    return this.tx(async (c) => {
      if (await this.alreadyDone(c, `${r.idempotencyKey}:${r.userIds[0]}`)) {
        return { ok: true as const, balances: await this.balances(c, r.userIds) };
      }

      const stake = await this.heldAmount(c, r.tableId, r.handNo);
      const ids = [...r.userIds].sort();
      await c.query(
        `SELECT player_id FROM wallets WHERE player_id = ANY($1::uuid[])
          ORDER BY player_id FOR UPDATE`,
        [ids],
      );

      for (let i = 0; i < r.userIds.length; i++) {
        const id = r.userIds[i];
        const delta = r.deltas[i];
        // Blokeyi ac, net degisimi yaz. Bakiye negatife dusemez (CHECK),
        // kayip blokenin uzerinden karsilanir.
        const { rows: u } = await c.query<{ balance: string; held: string }>(
          `UPDATE wallets
              SET held    = GREATEST(held - $2, 0),
                  balance = GREATEST(balance + $3, 0),
                  updated_at = now()
            WHERE player_id = $1
          RETURNING balance, held`,
          [id, stake, delta],
        );
        await c.query(
          `INSERT INTO wallet_ledger
             (player_id, op, amount, balance_after, held_after, table_id, hand_no, idempotency_key)
           VALUES ($1,'settle',$2,$3,$4,$5,$6,$7)`,
          [id, delta, Number(u[0].balance), Number(u[0].held),
           r.tableId, r.handNo, `${r.idempotencyKey}:${id}`],
        );
      }
      return { ok: true as const, balances: await this.balances(c, r.userIds) };
    });
  }

  /** El iptal edildiginde blokeyi geri verir. */
  async release(r: ReleaseRequest): Promise<WalletResult> {
    return this.tx(async (c) => {
      if (await this.alreadyDone(c, `${r.idempotencyKey}:${r.userIds[0]}`)) {
        return { ok: true as const, balances: await this.balances(c, r.userIds) };
      }
      const ids = [...r.userIds].sort();
      await c.query(
        `SELECT player_id FROM wallets WHERE player_id = ANY($1::uuid[])
          ORDER BY player_id FOR UPDATE`,
        [ids],
      );
      for (const id of r.userIds) {
        const { rows: u } = await c.query<{ balance: string; held: string }>(
          `UPDATE wallets SET held = GREATEST(held - $2, 0), updated_at = now()
            WHERE player_id = $1 RETURNING balance, held`,
          [id, r.amount],
        );
        await c.query(
          `INSERT INTO wallet_ledger
             (player_id, op, amount, balance_after, held_after, table_id, hand_no, idempotency_key)
           VALUES ($1,'release',$2,$3,$4,$5,$6,$7)`,
          [id, r.amount, Number(u[0].balance), Number(u[0].held),
           r.tableId, r.handNo, `${r.idempotencyKey}:${id}`],
        );
      }
      return { ok: true as const, balances: await this.balances(c, r.userIds) };
    });
  }

  // ------------------------------------------------------------- hediyeler

  /** Kayit hediyesi. Yalnizca bir kez verilir. */
  async signupGift(playerId: string, amount: number): Promise<number> {
    return this.tx(async (c) => {
      const { rows: u } = await c.query<{ balance: string }>(
        `UPDATE wallets SET balance = balance + $2, updated_at = now()
          WHERE player_id = $1 RETURNING balance`,
        [playerId, amount],
      );
      await c.query(
        `INSERT INTO wallet_ledger
           (player_id, op, amount, balance_after, held_after, idempotency_key)
         VALUES ($1,'signup_gift',$2,$3,0,$4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [playerId, amount, Number(u[0].balance), `gift:${playerId}`],
      );
      return Number(u[0].balance);
    });
  }

  /**
   * Gunluk bonus. 20 saat gecmeden ikinci kez verilmez.
   * Bakiyesi dusuk oyuncuya daha cok verilir: masaya donebilsin.
   */
  async claimDailyBonus(
    playerId: string, base: number, floor: number,
  ): Promise<{ ok: boolean; amount: number; balance: number; nextAt: string | null }> {
    return this.tx(async (c) => {
      const { rows } = await c.query<{ balance: string; last_bonus_at: Date | null }>(
        `SELECT balance, last_bonus_at FROM wallets WHERE player_id = $1 FOR UPDATE`,
        [playerId],
      );
      if (rows.length === 0) {
        return { ok: false, amount: 0, balance: 0, nextAt: null };
      }
      const last = rows[0].last_bonus_at;
      const now = Date.now();
      if (last && now - new Date(last).getTime() < 20 * 3600 * 1000) {
        const next = new Date(new Date(last).getTime() + 20 * 3600 * 1000);
        return {
          ok: false, amount: 0, balance: Number(rows[0].balance),
          nextAt: next.toISOString(),
        };
      }

      const bal = Number(rows[0].balance);
      // Iflas korumasi: bakiye tabanin altindaysa tabana tamamla.
      const amount = bal < floor ? Math.max(base, floor - bal) : base;

      const { rows: u } = await c.query<{ balance: string; held: string }>(
        `UPDATE wallets SET balance = balance + $2, last_bonus_at = now(), updated_at = now()
          WHERE player_id = $1 RETURNING balance, held`,
        [playerId, amount],
      );
      await c.query(
        `INSERT INTO wallet_ledger
           (player_id, op, amount, balance_after, held_after)
         VALUES ($1,'daily_bonus',$2,$3,$4)`,
        [playerId, amount, Number(u[0].balance), Number(u[0].held)],
      );
      return { ok: true, amount, balance: Number(u[0].balance), nextAt: null };
    });
  }

  async get(playerId: string): Promise<{ balance: number; held: number; lastBonusAt: string | null } | null> {
    const { rows } = await this.pool.query<{ balance: string; held: string; last_bonus_at: Date | null }>(
      `SELECT balance, held, last_bonus_at FROM wallets WHERE player_id = $1`,
      [playerId],
    );
    if (rows.length === 0) return null;
    return {
      balance: Number(rows[0].balance),
      held: Number(rows[0].held),
      lastBonusAt: rows[0].last_bonus_at ? new Date(rows[0].last_bonus_at).toISOString() : null,
    };
  }

  // ------------------------------------------------------------- yardimci

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  private async alreadyDone(c: PoolClient, key: string): Promise<boolean> {
    const { rowCount } = await c.query(
      `SELECT 1 FROM wallet_ledger WHERE idempotency_key = $1 LIMIT 1`, [key],
    );
    return (rowCount ?? 0) > 0;
  }

  /** O elin hold tutari. settle bu kadar blokeyi acar. */
  private async heldAmount(c: PoolClient, tableId: string, handNo: number): Promise<number> {
    const { rows } = await c.query<{ amount: string }>(
      `SELECT amount FROM wallet_ledger
        WHERE table_id = $1 AND hand_no = $2 AND op = 'hold' LIMIT 1`,
      [tableId, handNo],
    );
    return rows.length ? Number(rows[0].amount) : 0;
  }

  private async balances(c: PoolClient, ids: string[]): Promise<Record<string, number>> {
    const { rows } = await c.query<{ player_id: string; balance: string }>(
      `SELECT player_id, balance FROM wallets WHERE player_id = ANY($1::uuid[])`, [ids],
    );
    return Object.fromEntries(rows.map((r) => [r.player_id, Number(r.balance)]));
  }

  private async mark(
    c: PoolClient, key: string, playerId: string, op: string,
    amount: number, tableId: string, handNo: number, _c: PoolClient,
  ): Promise<void> {
    await c.query(
      `INSERT INTO wallet_ledger
         (player_id, op, amount, balance_after, held_after, table_id, hand_no, idempotency_key)
       SELECT $1,$2,$3,balance,held,$4,$5,$6 FROM wallets WHERE player_id = $1
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [playerId, op, amount, tableId, handNo, key],
    );
  }
}
