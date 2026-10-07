import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Cuzdan istemcisi.
 *
 * Jeton defteri Laravel tarafinda, MySQL'de. Oyun sunucusu bakiyeye asla
 * dogrudan yazmaz; tunel uzerinden (10.8.0.1) imzali ic API cagirir.
 *
 * Her cagri idempotent anahtar tasir: ag koparsa ayni cagri tekrar
 * gonderilir ve ikinci kez para hareketi YARATMAZ. Laravel tarafinda bu
 * anahtar tekil indeks olmali.
 */

export interface WalletConfig {
  baseUrl: string;      // http://10.8.0.1
  secret: string;       // INTERNAL_API_SECRET
  timeoutMs: number;
}

export interface HoldRequest {
  idempotencyKey: string;
  tableId: string;
  handNo: number;
  userIds: string[];
  amount: number;
}

export interface SettleRequest {
  idempotencyKey: string;
  tableId: string;
  handNo: number;
  userIds: string[];
  /** Jeton cinsinden net degisim; toplami 0 olmak zorunda DEGIL (rake yok). */
  deltas: number[];
}

export interface ReleaseRequest {
  idempotencyKey: string;
  tableId: string;
  handNo: number;
  userIds: string[];
  amount: number;
}

export type WalletResult =
  | { ok: true; balances: Record<string, number> }
  | { ok: false; code: "INSUFFICIENT_FUNDS"; userIds: string[] }
  | { ok: false; code: "UNAVAILABLE" | "REJECTED"; message: string };

/** Govdeyi imzalar. Laravel ayni sekilde dogrular. */
export function sign(secret: string, body: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Laravel tarafindan gelen imzayi dogrular (zamanlama saldirisina kapali). */
export function verify(
  secret: string, body: string, timestamp: number, signature: string,
  nowSec: number, toleranceSec = 300,
): boolean {
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;
  const expected = sign(secret, body, timestamp);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class WalletClient {
  constructor(private cfg: WalletConfig) {}

  hold(r: HoldRequest): Promise<WalletResult> {
    return this.post("/internal/wallet/hold", r);
  }
  settle(r: SettleRequest): Promise<WalletResult> {
    return this.post("/internal/wallet/settle", r);
  }
  release(r: ReleaseRequest): Promise<WalletResult> {
    return this.post("/internal/wallet/release", r);
  }

  private async post(path: string, payload: unknown): Promise<WalletResult> {
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);

    try {
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "content-type": "application/json",
          "x-oyun-timestamp": String(ts),
          "x-oyun-signature": sign(this.cfg.secret, body, ts),
        },
        body,
      });

      const text = await res.text();
      let parsed: any = {};
      try { parsed = text ? JSON.parse(text) : {}; } catch { /* asagida ele alinir */ }

      if (res.status === 409 || parsed.code === "INSUFFICIENT_FUNDS") {
        return { ok: false, code: "INSUFFICIENT_FUNDS", userIds: parsed.userIds ?? [] };
      }
      if (!res.ok) {
        return { ok: false, code: "REJECTED", message: parsed.message ?? `HTTP ${res.status}` };
      }
      return { ok: true, balances: parsed.balances ?? {} };
    } catch (err) {
      // Zaman asimi veya ag hatasi. Cagri KARSI TARAFTA islenmis olabilir;
      // idempotent anahtar sayesinde tekrar denemek guvenlidir.
      return { ok: false, code: "UNAVAILABLE", message: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Idempotent anahtar. Ayni masa + ayni el + ayni islem = ayni anahtar.
 * Tekrar gonderilen cagri yeni para hareketi yaratmaz.
 */
export const walletKey = (
  op: "hold" | "settle" | "release",
  tableId: string, handNo: number,
): string => `${op}:${tableId}:${handNo}`;
