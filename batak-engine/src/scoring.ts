import type { HandState, Seat } from "./types.js";
import type { VariantConfig } from "./variants.js";

/**
 * El sonu puanlamasi (spec: "Puanlama ve oyun sonu").
 * Donen dizi koltuk basinadir. Esli varyantta her iki es ayni takim puanini
 * tasir; masa toplaminda takim puani bir kez sayilir.
 */
export function scoreHand(state: HandState, v: VariantConfig): number[] {
  const t = state.tricksWon;

  // --- Gonul Batagi: tur almak ceza ---
  // neg(): -0 uretmemek icin. JSON'da zararsiz ama Object.is ve
  // deepStrictEqual karsilastirmalarinda tuzak kuruyor.
  const neg = (n: number): number => (n === 0 ? 0 : -n);

  if (v.inverted) {
    return t.map((n) => (v.slamBonus && n === 13 ? 13 : neg(n)));
  }

  // --- Koz Batak: sabit hedef, ihale yok ---
  if (!v.bidding) {
    const target = v.fixedTarget ?? 0;
    return t.map((n) => (n >= target ? n : neg(target)));
  }

  // --- Ihaleli / Esli: taahhut var ---
  const c = state.highBidder;
  const bid = state.highBid;
  if (c === null) return [0, 0, 0, 0]; // ihale olusmadi

  if (v.partnership) {
    const teamOf = (s: number) => (s % 2) as 0 | 1;
    const teamTricks = [t[0] + t[2], t[1] + t[3]];
    const cTeam = teamOf(c);
    const made = teamTricks[cTeam] >= bid;

    const cScore = made
      ? v.contractorScoresActualTricks
        ? teamTricks[cTeam]
        : bid
      : (bid === 0 ? 0 : -bid);
    const oScore = teamTricks[1 - cTeam];

    return [0, 1, 2, 3].map((s) => (teamOf(s) === cTeam ? cScore : oScore));
  }

  const made = t[c] >= bid;
  const cScore = made
    ? v.contractorScoresActualTricks ? t[c] : bid
    : (bid === 0 ? 0 : -bid);

  return [0, 1, 2, 3].map((s) => (s === c ? cScore : t[s]));
}

/**
 * Masa puanlarini el sonucuyla gunceller.
 * Esli varyantta koltuk puanlari zaten takim puanidir; cift sayma olmaz
 * cunku masa skoru koltuk bazinda tutulur ve takim skoru 0/2 koltugundan
 * okunur.
 */
export function addHandScores(table: number[], hand: number[]): number[] {
  return table.map((v, i) => v + hand[i]);
}

/** Oyun sonu: sabit el sayisi (lansman modu) veya puan hedefi. */
export interface EndCondition {
  kind: "fixedHands" | "targetScore";
  value: number;
}

export function isGameOver(
  cond: EndCondition,
  handsPlayed: number,
  scores: number[],
  v: VariantConfig,
): boolean {
  if (cond.kind === "fixedHands") return handsPlayed >= cond.value;
  const pool = v.partnership ? [scores[0], scores[1]] : scores;
  return pool.some((s) => s >= cond.value);
}

/** Beraberlikte daha az el batan kazanir; o da esitse null (beraberlik). */
export function winner(
  scores: number[],
  timesSet: number[],
  v: VariantConfig,
): Seat | 0 | 1 | null {
  const idx = v.partnership ? [0, 1] : [0, 1, 2, 3];
  const best = Math.max(...idx.map((i) => scores[i]));
  const tied = idx.filter((i) => scores[i] === best);
  if (tied.length === 1) return tied[0] as Seat;

  const fewest = Math.min(...tied.map((i) => timesSet[i]));
  const still = tied.filter((i) => timesSet[i] === fewest);
  return still.length === 1 ? (still[0] as Seat) : null;
}
