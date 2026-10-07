import type { Move, Seat, Suit } from "@muhabbetly/batak-engine";

/**
 * Istemci -> sunucu mesajlari.
 *
 * Istemci kural calistirmaz, yalnizca niyet bildirir. Sunucu dogrular.
 * Gelen her sey dusman kabul edilir: tip, aralik ve koltuk sahipligi
 * burada kontrol edilir.
 */

export type ClientMessage =
  | { type: "join"; variantId: string; roomId?: string | null; tableId?: string | null }
  | { type: "leave" }
  | { type: "bid"; value: number }
  | { type: "pass" }
  | { type: "trump"; suit: number }
  | { type: "play"; card: number }
  | { type: "ping" };

export type ParseResult =
  | { ok: true; msg: ClientMessage }
  | { ok: false; code: string; message: string };

const VARIANT_IDS = new Set(["esli", "ihaleli", "koz", "gonul"]);

export function parse(raw: string): ParseResult {
  if (raw.length > 4096) {
    return { ok: false, code: "TOO_LARGE", message: "Mesaj cok buyuk." };
  }
  let v: any;
  try { v = JSON.parse(raw); } catch {
    return { ok: false, code: "BAD_JSON", message: "Gecersiz JSON." };
  }
  if (typeof v !== "object" || v === null || typeof v.type !== "string") {
    return { ok: false, code: "BAD_SHAPE", message: "type alani eksik." };
  }

  switch (v.type) {
    case "ping":
    case "leave":
    case "pass":
      return { ok: true, msg: { type: v.type } };

    case "join": {
      if (typeof v.variantId !== "string" || !VARIANT_IDS.has(v.variantId)) {
        return { ok: false, code: "BAD_VARIANT", message: "Bilinmeyen oyun." };
      }
      const roomId = typeof v.roomId === "string" ? v.roomId.slice(0, 64) : null;
      const tableId = typeof v.tableId === "string" ? v.tableId.slice(0, 64) : null;
      return { ok: true, msg: { type: "join", variantId: v.variantId, roomId, tableId } };
    }

    case "bid": {
      if (!Number.isInteger(v.value) || v.value < 1 || v.value > 13) {
        return { ok: false, code: "BAD_BID", message: "Teklif 1 ile 13 arasinda olmali." };
      }
      return { ok: true, msg: { type: "bid", value: v.value } };
    }

    case "trump": {
      if (!Number.isInteger(v.suit) || v.suit < 0 || v.suit > 3) {
        return { ok: false, code: "BAD_SUIT", message: "Gecersiz renk." };
      }
      return { ok: true, msg: { type: "trump", suit: v.suit } };
    }

    case "play": {
      if (!Number.isInteger(v.card) || v.card < 0 || v.card > 51) {
        return { ok: false, code: "BAD_CARD", message: "Gecersiz kart." };
      }
      return { ok: true, msg: { type: "play", card: v.card } };
    }

    default:
      return { ok: false, code: "UNKNOWN_TYPE", message: `Bilinmeyen mesaj: ${v.type}` };
  }
}

/** Istemci mesajini motor hamlesine cevirir. Koltuk SUNUCUDAN gelir. */
export function toMove(msg: ClientMessage, seat: Seat): Move | null {
  switch (msg.type) {
    case "bid": return { type: "bid", seat, value: msg.value };
    case "pass": return { type: "pass", seat };
    case "trump": return { type: "chooseTrump", seat, suit: msg.suit as Suit };
    case "play": return { type: "play", seat, card: msg.card };
    default: return null;
  }
}

/**
 * Hiz siniri. Bir oyuncu saniyede birkac hamleden fazlasini yapamaz;
 * yapmaya calisan istemci ya bozuk ya kotu niyetlidir.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 20, private windowMs = 10_000) {}

  allow(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  forget(key: string): void { this.hits.delete(key); }
}
