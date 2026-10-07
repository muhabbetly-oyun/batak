import { legalCards } from "../engine.js";
import { type Card, type HandState, type Move, type Seat, rankOf, suitOf } from "../types.js";
import type { VariantConfig } from "../variants.js";

/**
 * Bot kazanmak icin degil, masayi ayakta tutmak icin var (spec: "Bot davranisi").
 * Kurallara uygun, makul ama iddiasiz oynar. Oyuncular bota karsi oynadiklarini
 * masada gorebilmelidir.
 */
export function botMove(
  state: HandState,
  seat: Seat,
  v: VariantConfig,
): Move {
  if (state.phase === "bidding") return bidOrPass(state, seat, v);

  if (state.phase === "trump") {
    // Elinde en cok kart bulunan rengi koz yapar.
    const counts = [0, 0, 0, 0];
    for (const c of state.hands[seat]) counts[suitOf(c)]++;
    const best = counts.indexOf(Math.max(...counts));
    return { type: "chooseTrump", seat, suit: best as 0 | 1 | 2 | 3 };
  }

  const legal = legalCards(state, seat, v);
  return { type: "play", seat, card: pick(legal, state, v) };
}

/**
 * Son aktif teklifci ve kimse teklif vermemisse: pas gecmek eli iptal eder
 * ve ayni durum tekrarlanirsa masa ilerlemez. minBid ile acar.
 */
export function bidOrPass(state: HandState, seat: Seat, v: VariantConfig): Move {
  const active = state.passed.filter((p) => !p).length;
  if (v.forceLastBidder && active === 1 && state.highBidder === null) {
    return { type: "bid", seat, value: Math.max(v.minBid, 1) };
  }
  return { type: "pass", seat };
}

function pick(legal: Card[], state: HandState, v: VariantConfig): Card {
  const low = (cards: Card[]) =>
    cards.reduce((a, b) => (rankOf(a) <= rankOf(b) ? a : b));
  const high = (cards: Card[]) =>
    cards.reduce((a, b) => (rankOf(a) >= rankOf(b) ? a : b));

  // Ters oyunda amac tur almamak: daima en kucugu.
  if (v.inverted) return low(legal);

  // Turu aciyorsa: ortalama bir kart. En buyugu harcamaz, en kucugu de atmaz.
  if (state.trick.length === 0) {
    const sorted = legal.slice().sort((a, b) => rankOf(a) - rankOf(b));
    return sorted[Math.floor(sorted.length / 2)];
  }

  // Tur suruyorsa: alabiliyorsa en ucuz alisi yapar, alamiyorsa en kucugu atar.
  const led = suitOf(state.trick[0].card);
  const best = currentBest(state, led);
  const winners = legal.filter((c) => beats(c, best, led, state.trump));
  return winners.length > 0 ? low(winners) : low(legal);
}

function currentBest(state: HandState, led: number): Card {
  const trumps = state.trump === null
    ? []
    : state.trick.filter((p) => suitOf(p.card) === state.trump);
  const pool = trumps.length > 0
    ? trumps
    : state.trick.filter((p) => suitOf(p.card) === led);
  return pool.reduce((a, b) => (rankOf(a.card) >= rankOf(b.card) ? a : b)).card;
}

function beats(c: Card, best: Card, led: number, trump: number | null): boolean {
  const cs = suitOf(c), bs = suitOf(best);
  if (trump !== null) {
    if (cs === trump && bs !== trump) return true;
    if (cs !== trump && bs === trump) return false;
  }
  if (cs !== bs) return false;
  if (cs !== led && cs !== trump) return false;
  return rankOf(c) > rankOf(best);
}
