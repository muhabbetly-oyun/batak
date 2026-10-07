import {
  type Applied, type Card, type GameEvent, type HandState, type Move,
  type PlayedCard, type Rejected, type Result, type RuleError, type Seat,
  type Suit, rankOf, suitOf,
} from "./types.js";
import type { VariantConfig } from "./variants.js";
import { deal, drawTrumpSuit, hashSeed } from "./deck.js";
import { scoreHand } from "./scoring.js";

const nextSeat = (s: Seat): Seat => ((s + 1) % 4) as Seat;

function reject(state: HandState, code: RuleError["code"], message: string): Rejected {
  return { state, events: [], error: { code, message } };
}

/** El baslatir. Saf degildir yalnizca seed disaridan verilmediginde. */
export function startHand(
  variant: VariantConfig,
  dealer: Seat,
  seed: string,
): { state: HandState; events: GameEvent[] } {
  const hands = deal(seed);
  const events: GameEvent[] = [
    { type: "hand_started", dealer, seedHash: hashSeed(seed) },
    { type: "cards_dealt", counts: hands.map((h) => h.length) },
  ];

  const state: HandState = {
    phase: variant.bidding ? "bidding" : "playing",
    variantId: variant.id,
    dealer,
    hands,
    turn: nextSeat(dealer),
    bids: [null, null, null, null],
    passed: [false, false, false, false],
    highBid: 0,
    highBidder: null,
    trump: null,
    leader: nextSeat(dealer),
    trick: [],
    trickNo: 0,
    tricksWon: [0, 0, 0, 0],
    seedHash: hashSeed(seed),
    seed: null,
    scores: null,
  };

  if (!variant.bidding) {
    // Koz Batak: koz seed'den turetilir. Gonul Batagi: koz yok.
    state.trump = variant.noTrump ? null : drawTrumpSuit(seed);
    events.push({ type: "trump_set", seat: null, suit: state.trump });
  }

  return { state, events };
}

/**
 * Motorun tek giris noktasi. Saf fonksiyon: ayni (state, move) ayni sonucu
 * verir. Yan etki yok, zaman yok, rastgelelik yok.
 */
export function applyMove(
  state: HandState,
  move: Move,
  variant: VariantConfig,
  seed: string,
): Result {
  switch (move.type) {
    case "bid":
    case "pass":
      return applyBid(state, move, variant, seed);
    case "chooseTrump":
      return applyTrump(state, move, variant);
    case "play":
      return applyPlay(state, move, variant, seed);
  }
}

// ---------------------------------------------------------------- ihale

function applyBid(
  state: HandState,
  move: Extract<Move, { type: "bid" | "pass" }>,
  variant: VariantConfig,
  seed: string,
): Result {
  if (!variant.bidding) {
    return reject(state, "BIDDING_DISABLED", "Bu varyantta ihale yok.");
  }
  if (state.phase !== "bidding") {
    return reject(state, "WRONG_PHASE", `Ihale asamasinda degil: ${state.phase}`);
  }
  if (move.seat !== state.turn) {
    return reject(state, "NOT_YOUR_TURN", `Sira ${state.turn} koltugunda.`);
  }
  if (state.passed[move.seat]) {
    return reject(state, "ALREADY_PASSED", "Pas gecen tekrar teklif veremez.");
  }

  const s: HandState = {
    ...state,
    bids: state.bids.slice(),
    passed: state.passed.slice(),
  };
  const events: GameEvent[] = [];

  if (move.type === "pass") {
    s.passed[move.seat] = true;
    events.push({ type: "pass", seat: move.seat });
  } else {
    const floor = Math.max(variant.minBid, state.highBid + 1);
    if (move.value < floor) {
      return reject(state, "BID_TOO_LOW", `Teklif en az ${floor} olmali.`);
    }
    if (move.value > variant.maxBid) {
      return reject(state, "BID_ABOVE_MAX", `Teklif en fazla ${variant.maxBid}.`);
    }
    s.bids[move.seat] = move.value;
    s.highBid = move.value;
    s.highBidder = move.seat;
    events.push({ type: "bid", seat: move.seat, value: move.value });
  }

  const active = s.passed.filter((p) => !p).length;

  if (active === 0) {
    // Dort oyuncu da pas gecti: el iptal, yeniden dagitilir.
    s.phase = "voided";
    events.push({ type: "hand_voided", reason: "all_passed" });
    return { state: s, events };
  }

  if (active === 1 && s.highBidder !== null) {
    s.phase = "trump";
    s.turn = s.highBidder;
    events.push({ type: "bid_won", seat: s.highBidder, value: s.highBid });
    return { state: s, events };
  }

  // Sirayi pas gecmemis bir sonraki koltuga tasi.
  let t = nextSeat(s.turn);
  while (s.passed[t]) t = nextSeat(t);
  s.turn = t;
  return { state: s, events };
}

function applyTrump(
  state: HandState,
  move: Extract<Move, { type: "chooseTrump" }>,
  variant: VariantConfig,
): Result {
  if (state.phase !== "trump") {
    return reject(state, "WRONG_PHASE", `Koz secimi asamasinda degil: ${state.phase}`);
  }
  if (move.seat !== state.highBidder) {
    return reject(state, "NOT_CONTRACTOR", "Kozu yalnizca ihaleyi alan secer.");
  }
  if (variant.noTrump) {
    return reject(state, "WRONG_PHASE", "Bu varyantta koz yok.");
  }

  const s: HandState = {
    ...state,
    trump: move.suit,
    phase: "playing",
    leader: move.seat,
    turn: move.seat,
  };
  return {
    state: s,
    events: [{ type: "trump_set", seat: move.seat, suit: move.suit }],
  };
}

// ---------------------------------------------------------------- oyun

/** Oynanabilir kartlar. Istemci bunu kendi hesaplamaz; sunucu gonderir. */
export function legalCards(state: HandState, seat: Seat, variant: VariantConfig): Card[] {
  const hand = state.hands[seat];
  if (state.trick.length === 0) return hand.slice();

  const led = suitOf(state.trick[0].card);
  const sameSuit = hand.filter((c) => suitOf(c) === led);
  if (sameSuit.length > 0) return sameSuit;

  // Acilan renk elde yok.
  if (variant.mustPlayTrumpWhenVoid && state.trump !== null) {
    const trumps = hand.filter((c) => suitOf(c) === state.trump);
    if (trumps.length > 0) return trumps;
  }
  return hand.slice();
}

function applyPlay(
  state: HandState,
  move: Extract<Move, { type: "play" }>,
  variant: VariantConfig,
  seed: string,
): Result {
  if (state.phase !== "playing") {
    return reject(state, "WRONG_PHASE", `Oyun asamasinda degil: ${state.phase}`);
  }
  if (move.seat !== state.turn) {
    return reject(state, "NOT_YOUR_TURN", `Sira ${state.turn} koltugunda.`);
  }

  const hand = state.hands[move.seat];
  if (!hand.includes(move.card)) {
    return reject(state, "CARD_NOT_IN_HAND", "Bu kart elinde yok.");
  }

  const allowed = legalCards(state, move.seat, variant);
  if (!allowed.includes(move.card)) {
    const led = suitOf(state.trick[0].card);
    const hasLed = hand.some((c) => suitOf(c) === led);
    return hasLed
      ? reject(state, "MUST_FOLLOW_SUIT", "Acilan renkten oynamak zorunlusun.")
      : reject(state, "MUST_PLAY_TRUMP", "Koz oynamak zorunlusun.");
  }

  const s: HandState = {
    ...state,
    hands: state.hands.map((h, i) =>
      i === move.seat ? h.filter((c) => c !== move.card) : h,
    ),
    trick: [...state.trick, { seat: move.seat, card: move.card }],
    tricksWon: state.tricksWon.slice(),
  };
  const events: GameEvent[] = [
    { type: "card_played", seat: move.seat, card: move.card, trickNo: s.trickNo },
  ];

  if (s.trick.length < 4) {
    s.turn = nextSeat(move.seat);
    return { state: s, events };
  }

  // Tur tamamlandi.
  const winner = trickWinner(s.trick, s.trump);
  s.tricksWon[winner]++;
  events.push({ type: "trick_won", seat: winner, trickNo: s.trickNo, cards: s.trick });

  s.trick = [];
  s.trickNo++;
  s.leader = winner;
  s.turn = winner;

  if (s.trickNo === 13) {
    s.phase = "ended";
    s.seed = seed;
    s.scores = scoreHand(s, variant);
    events.push({
      type: "hand_ended",
      scores: s.scores,
      tricksWon: s.tricksWon,
      seed,
    });
  }

  return { state: s, events };
}

/** Koz varsa en buyuk koz; yoksa acilan renkten en buyuk kart alir. */
export function trickWinner(trick: PlayedCard[], trump: Suit | null): Seat {
  const led = suitOf(trick[0].card);
  const trumps = trump === null ? [] : trick.filter((p) => suitOf(p.card) === trump);
  const pool = trumps.length > 0 ? trumps : trick.filter((p) => suitOf(p.card) === led);
  return pool.reduce((best, p) => (rankOf(p.card) > rankOf(best.card) ? p : best)).seat;
}
