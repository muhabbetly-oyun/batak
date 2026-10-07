import type { Pool } from "pg";

/**
 * Olay akisinin kalici yazimi.
 *
 * Her hamle `table_events` tablosuna duser. Sikayet geldiginde el birebir
 * yeniden oynatilir — destek ekibinin en cok kullanacagi arac budur.
 *
 * Oyuncu KARTLARI buraya yazilmaz. El sonunda seed aciklandigi icin dagitim
 * zaten yeniden uretilebilir; kartlari ayrica saklamak gereksiz bir sizinti
 * yuzeyidir (spec: "Gizlilik").
 */

export interface PersistedEvent {
  type: string;
  [k: string]: unknown;
}

export class EventStore {
  constructor(private pool: Pool) {}

  /** Tek transaction, artan seq. Ayni seq iki kez yazilamaz. */
  async append(tableId: string, events: PersistedEvent[], handId: number | null): Promise<void> {
    if (events.length === 0) return;
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const { rows } = await c.query<{ next: number }>(
        `SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM table_events WHERE table_id = $1`,
        [tableId],
      );
      let seq = Number(rows[0].next);

      const values: unknown[] = [];
      const tuples: string[] = [];
      for (const e of events) {
        const { type, ...payload } = e;
        const actor = typeof (e as any).seat === "number" ? String((e as any).seat) : "system";
        const i = values.length;
        tuples.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6})`);
        values.push(tableId, handId, seq++, actor, type, JSON.stringify(payload));
      }

      await c.query(
        `INSERT INTO table_events (table_id, hand_id, seq, actor, type, payload)
         VALUES ${tuples.join(",")}`,
        values,
      );
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** Masayi kaydeder veya gunceller. */
  async upsertTable(t: {
    id: string; game: string; variant: unknown; stake: number;
    roomId: string | null; status: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO tables (id, game, variant, stake, room_id, status)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE
         SET status = EXCLUDED.status,
             finished_at = CASE WHEN EXCLUDED.status IN ('finished','abandoned')
                                THEN now() ELSE tables.finished_at END`,
      [t.id, t.game, JSON.stringify(t.variant), t.stake, t.roomId, t.status],
    );
  }

  async startHand(tableId: string, handNo: number, seedHash: string): Promise<number> {
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO hands (table_id, hand_no, seed_hash) VALUES ($1,$2,$3)
       ON CONFLICT (table_id, hand_no) DO UPDATE SET seed_hash = EXCLUDED.seed_hash
       RETURNING id`,
      [tableId, handNo, seedHash],
    );
    return rows[0].id;
  }

  /** El bitince seed aciklanir ve puanlar yazilir. */
  async endHand(handId: number, seed: string, scores: number[]): Promise<void> {
    await this.pool.query(
      `UPDATE hands SET seed = $2, scores = $3, ended_at = now() WHERE id = $1`,
      [handId, seed, JSON.stringify(scores)],
    );
  }

  /** Cuzdan cagri izi. Uyusmazlikta iki taraf karsilastirilir. */
  async logWalletCall(r: {
    key: string; tableId: string; userId: string;
    op: "hold" | "settle" | "release"; amount: number;
    status: "pending" | "ok" | "failed"; response?: unknown;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO wallet_calls (idempotency_key, table_id, user_id, op, amount, status, response)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO UPDATE
         SET status = EXCLUDED.status, response = EXCLUDED.response`,
      [r.key, r.tableId, r.userId, r.op, r.amount, r.status,
       r.response === undefined ? null : JSON.stringify(r.response)],
    );
  }

  /**
   * Anlasmali oyun tespiti icin ham veri. Algoritma sonra yazilir ama veri
   * BUGUN birikmeye baslamali — gecmis veri sonradan uretilemez.
   */
  async logFingerprint(r: {
    userId: string; tableId: string | null;
    ip: string | null; userAgent: string | null; deviceHash: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO session_fingerprints (user_id, table_id, ip, user_agent, device_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [r.userId, r.tableId, r.ip, r.userAgent, r.deviceHash],
    );
  }
}
