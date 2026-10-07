import type { Move, Seat, Suit } from "@muhabbetly/batak-engine";

/**
 * Istemci -> sunucu mesajlari.
 *
 * Istemci kural calistirmaz, yalnizca niyet bildirir. Sunucu dogrular.
 * Gelen her sey dusman kabul edilir: tip, aralik ve koltuk sahipligi
 * burada kontrol edilir.
 */

export type ClientMessage =
  | { type: "join"; variantId: string; practice?: boolean; region?: string | null; roomId?: string | null; tableId?: string | null }
  | { type: "leave" }
  | { type: "bid"; value: number }
  | { type: "pass" }
  | { type: "trump"; suit: number }
  | { type: "play"; card: number }
  | { type: "chat"; text: string }
  | { type: "quick"; id: string }
  | { type: "ping" };

/**
 * Hazir ifadeler. Esli masada el surerken YALNIZCA bunlar kullanilabilir:
 * serbest metin, eslerin birbirini beslemesine kapi acar.
 */
export const QUICK_PHRASES: Record<string, string> = {
  iyi_oyun:   "İyi oyunlar",
  tebrikler:  "Tebrikler",
  tesekkur:   "Teşekkürler",
  sira_sende: "Sıra sende",
  acele_yok:  "Acele yok",
  guzel:      "Güzel oynadın",
  afiyet:     "Afiyet olsun",
  gorusuruz:  "Görüşürüz",
};

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

    case "chat": {
      if (typeof v.text !== "string") {
        return { ok: false, code: "BAD_TEXT", message: "Metin gerekli." };
      }
      // Kontrol karakterleri temizlenir, bosluklar tek bosluga indirgenir.
      const text = v.text
        .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      if (!text) {
        return { ok: false, code: "EMPTY_TEXT", message: "Boş mesaj." };
      }
      return { ok: true, msg: { type: "chat", text } };
    }

    case "quick": {
      if (typeof v.id !== "string" || !(v.id in QUICK_PHRASES)) {
        return { ok: false, code: "BAD_QUICK", message: "Bilinmeyen ifade." };
      }
      return { ok: true, msg: { type: "quick", id: v.id } };
    }

    case "join": {
      if (typeof v.variantId !== "string" || !VARIANT_IDS.has(v.variantId)) {
        return { ok: false, code: "BAD_VARIANT", message: "Bilinmeyen oyun." };
      }
      const region = typeof v.region === "string" && /^[a-z0-9-]{2,24}$/.test(v.region)
        ? v.region : null;
      const roomId = typeof v.roomId === "string" ? v.roomId.slice(0, 64) : null;
      const tableId = typeof v.tableId === "string" ? v.tableId.slice(0, 64) : null;
      return {
        ok: true,
        msg: {
          type: "join", variantId: v.variantId,
          practice: v.practice === true, region, roomId, tableId,
        },
      };
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
