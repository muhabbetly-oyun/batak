import { createHash, randomBytes } from "node:crypto";
import type { Card, Suit } from "./types.js";

/**
 * Deterministik karistirma + commit-reveal.
 *
 * El basinda seedHash yayinlanir, el sonunda seed aciklanir. Oyuncu ayni
 * seed ile ayni dagitimi yeniden uretebilir. "Site hile yapiyor" iddiasina
 * karsi tek gercek savunma budur (spec: Ortak kurallar).
 */

export const newSeed = (): string => randomBytes(32).toString("hex");

export const hashSeed = (seed: string): string =>
  createHash("sha256").update(seed, "utf8").digest("hex");

/** sfc32 — kucuk, hizli, deterministik PRNG. Kripto amacli DEGILDIR. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return function next(): number {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function rngFromSeed(seed: string): () => number {
  const h = createHash("sha256").update(seed, "utf8").digest();
  const r = sfc32(
    h.readUInt32BE(0), h.readUInt32BE(4), h.readUInt32BE(8), h.readUInt32BE(12),
  );
  for (let i = 0; i < 12; i++) r(); // isinma
  return r;
}

export const freshDeck = (): Card[] =>
  Array.from({ length: 52 }, (_, i) => i);

/** Fisher-Yates, seed'den turetilmis RNG ile. Ayni seed -> ayni sira. */
export function shuffle(seed: string, deck: Card[] = freshDeck()): Card[] {
  const rng = rngFromSeed(seed);
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 4 oyuncuya 13'er kart. Koltuk 0'dan baslayarak sirayla. */
export function deal(seed: string): Card[][] {
  const deck = shuffle(seed);
  const hands: Card[][] = [[], [], [], []];
  for (let i = 0; i < 52; i++) hands[i % 4].push(deck[i]);
  return hands.map((h) => h.sort((a, b) => a - b));
}

/**
 * Koz Batak: dagitimdan ONCE desteden rastgele bir kart cekilir, rengi koz
 * olur, kart desteye geri karisir (spec: Koz Batak).
 * Ayni seed'den turetilir ki dogrulanabilir kalsin.
 */
export function drawTrumpSuit(seed: string): Suit {
  const rng = rngFromSeed(`${seed}:trump`);
  return Math.floor(rng() * 4) as Suit;
}
