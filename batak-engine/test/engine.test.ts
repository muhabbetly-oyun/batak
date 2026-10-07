import test from "node:test";
import assert from "node:assert/strict";

import {
  ESLI_BATAK, IHALELI_BATAK, KOZ_BATAK, GONUL_BATAGI,
  type VariantConfig,
} from "../src/variants.js";
import { deal, hashSeed, shuffle, newSeed } from "../src/deck.js";
import {
  applyMove, legalCards, startHand, trickWinner,
} from "../src/engine.js";
import { scoreHand } from "../src/scoring.js";
import {
  type Card, type HandState, type Seat, type Suit,
  makeCard, rankOf, suitOf,
} from "../src/types.js";

const SEED = "a".repeat(64);

// ------------------------------------------------------------- deste

test("ayni seed ayni dagitimi verir", () => {
  assert.deepEqual(deal(SEED), deal(SEED));
});

test("farkli seed farkli dagitim verir", () => {
  assert.notDeepEqual(deal(SEED), deal("b".repeat(64)));
});

test("dagitim 52 kartin tamamini kullanir, tekrar yok", () => {
  const hands = deal(SEED);
  assert.equal(hands.length, 4);
  for (const h of hands) assert.equal(h.length, 13);
  const all = hands.flat().sort((a, b) => a - b);
  assert.deepEqual(all, Array.from({ length: 52 }, (_, i) => i));
});

test("karistirma desteyi gercekten karistirir", () => {
  const s = shuffle(SEED);
  assert.notDeepEqual(s, Array.from({ length: 52 }, (_, i) => i));
  assert.equal(new Set(s).size, 52);
});

test("seedHash seed'den tureyip sabit kalir", () => {
  assert.equal(hashSeed(SEED), hashSeed(SEED));
  assert.equal(hashSeed(SEED).length, 64);
  assert.notEqual(hashSeed(SEED), hashSeed("b".repeat(64)));
});

// ------------------------------------------------------------- tur alma

const S = 0 as Suit, H = 1 as Suit, D = 2 as Suit, C = 3 as Suit;

test("koz yoksa acilan renkten en buyuk alir", () => {
  const trick = [
    { seat: 0 as Seat, card: makeCard(H, 10) },
    { seat: 1 as Seat, card: makeCard(H, 14) },
    { seat: 2 as Seat, card: makeCard(S, 14) }, // baska renk, kazanamaz
    { seat: 3 as Seat, card: makeCard(H, 3) },
  ];
  assert.equal(trickWinner(trick, null), 1);
});

test("koz oynandiysa en buyuk koz alir", () => {
  const trick = [
    { seat: 0 as Seat, card: makeCard(H, 14) },
    { seat: 1 as Seat, card: makeCard(S, 2) }, // kucuk koz
    { seat: 2 as Seat, card: makeCard(H, 13) },
    { seat: 3 as Seat, card: makeCard(S, 3) }, // daha buyuk koz
  ];
  assert.equal(trickWinner(trick, S), 3);
});

test("acilan renk disindaki kozsuz kartlar kazanamaz", () => {
  const trick = [
    { seat: 0 as Seat, card: makeCard(D, 5) },
    { seat: 1 as Seat, card: makeCard(C, 14) },
    { seat: 2 as Seat, card: makeCard(H, 14) },
    { seat: 3 as Seat, card: makeCard(D, 6) },
  ];
  assert.equal(trickWinner(trick, S), 3);
});

// ------------------------------------------------------------- ihale

function bidTo(v: VariantConfig, moves: Array<[Seat, number | "pass"]>) {
  let { state } = startHand(v, 3 as Seat, SEED);
  for (const [seat, m] of moves) {
    const move = m === "pass"
      ? { type: "pass" as const, seat }
      : { type: "bid" as const, seat, value: m };
    const r = applyMove(state, move, v, SEED);
    assert.equal(r.error, undefined, `reddedildi: ${JSON.stringify(r.error)}`);
    state = r.state;
  }
  return state;
}

test("ihale dagitanin solundan baslar", () => {
  const { state } = startHand(IHALELI_BATAK, 3 as Seat, SEED);
  assert.equal(state.turn, 0);
  assert.equal(state.phase, "bidding");
});

test("minimum teklifin altindaki teklif reddedilir", () => {
  const { state } = startHand(IHALELI_BATAK, 3 as Seat, SEED);
  const r = applyMove(state, { type: "bid", seat: 0, value: 4 }, IHALELI_BATAK, SEED);
  assert.equal(r.error?.code, "BID_TOO_LOW");
});

test("teklif bir oncekinin ustune cikmali", () => {
  const s = bidTo(IHALELI_BATAK, [[0, 6]]);
  const r = applyMove(s, { type: "bid", seat: 1, value: 6 }, IHALELI_BATAK, SEED);
  assert.equal(r.error?.code, "BID_TOO_LOW");
});

test("pas gecen tekrar teklif veremez", () => {
  const s = bidTo(IHALELI_BATAK, [[0, "pass"]]);
  const r = applyMove(s, { type: "bid", seat: 0, value: 7 }, IHALELI_BATAK, SEED);
  // sira zaten onda degil
  assert.ok(r.error?.code === "NOT_YOUR_TURN" || r.error?.code === "ALREADY_PASSED");
});

test("uc pas sonrasi ihale kapanir ve koz asamasina gecer", () => {
  const s = bidTo(IHALELI_BATAK, [[0, 5], [1, "pass"], [2, "pass"], [3, "pass"]]);
  assert.equal(s.phase, "trump");
  assert.equal(s.highBidder, 0);
  assert.equal(s.highBid, 5);
  assert.equal(s.turn, 0);
});

test("dort pas eli iptal eder", () => {
  const s = bidTo(IHALELI_BATAK, [
    [0, "pass"], [1, "pass"], [2, "pass"], [3, "pass"],
  ]);
  assert.equal(s.phase, "voided");
});

test("sira pas gecenleri atlar", () => {
  let s = bidTo(IHALELI_BATAK, [[0, 5], [1, "pass"]]);
  assert.equal(s.turn, 2);
  s = bidTo(IHALELI_BATAK, [[0, 5], [1, "pass"], [2, 6]]);
  assert.equal(s.turn, 3); // 1 atlandi degil, 3'e gecti
});

test("kozu yalnizca ihaleyi alan secer", () => {
  const s = bidTo(IHALELI_BATAK, [[0, 5], [1, "pass"], [2, "pass"], [3, "pass"]]);
  const bad = applyMove(s, { type: "chooseTrump", seat: 1, suit: S }, IHALELI_BATAK, SEED);
  assert.equal(bad.error?.code, "NOT_CONTRACTOR");
  const ok = applyMove(s, { type: "chooseTrump", seat: 0, suit: S }, IHALELI_BATAK, SEED);
  assert.equal(ok.error, undefined);
  assert.equal(ok.state.phase, "playing");
  assert.equal(ok.state.trump, S);
  assert.equal(ok.state.turn, 0);
});

test("ihalesiz varyantta teklif reddedilir", () => {
  const { state } = startHand(KOZ_BATAK, 3 as Seat, SEED);
  const r = applyMove(state, { type: "bid", seat: 0, value: 5 }, KOZ_BATAK, SEED);
  assert.equal(r.error?.code, "BIDDING_DISABLED");
});

// ------------------------------------------------------------- oyun

function toPlaying(v: VariantConfig, trump: Suit = S): HandState {
  if (!v.bidding) return startHand(v, 3 as Seat, SEED).state;
  const s = bidTo(v, [[0, 5], [1, "pass"], [2, "pass"], [3, "pass"]]);
  const r = applyMove(s, { type: "chooseTrump", seat: 0, suit: trump }, v, SEED);
  return r.state;
}

test("renk uyma zorunlulugu uygulanir", () => {
  const s = toPlaying(IHALELI_BATAK);
  const lead = s.hands[0][0];
  const led = suitOf(lead);
  const r1 = applyMove(s, { type: "play", seat: 0, card: lead }, IHALELI_BATAK, SEED);
  assert.equal(r1.error, undefined);
  const s2 = r1.state;

  const offSuit = s2.hands[1].find((c) => suitOf(c) !== led);
  const hasLed = s2.hands[1].some((c) => suitOf(c) === led);
  if (hasLed && offSuit !== undefined) {
    const bad = applyMove(s2, { type: "play", seat: 1, card: offSuit }, IHALELI_BATAK, SEED);
    assert.equal(bad.error?.code, "MUST_FOLLOW_SUIT");
  }
});

test("elde olmayan kart oynanamaz", () => {
  const s = toPlaying(IHALELI_BATAK);
  const notMine = s.hands[1][0];
  const r = applyMove(s, { type: "play", seat: 0, card: notMine }, IHALELI_BATAK, SEED);
  assert.equal(r.error?.code, "CARD_NOT_IN_HAND");
});

test("sirasi gelmeyen oynayamaz", () => {
  const s = toPlaying(IHALELI_BATAK);
  const r = applyMove(s, { type: "play", seat: 2, card: s.hands[2][0] }, IHALELI_BATAK, SEED);
  assert.equal(r.error?.code, "NOT_YOUR_TURN");
});

test("mustPlayTrumpWhenVoid bayragi koz oynamayi zorunlu kilar", () => {
  const v: VariantConfig = { ...IHALELI_BATAK, mustPlayTrumpWhenVoid: true };
  // Elde acilan renk yok, koz var -> yalnizca kozlar legal
  const state: HandState = {
    ...toPlaying(v),
    hands: [
      [makeCard(H, 5)],
      [makeCard(S, 2), makeCard(D, 9)], // kupa yok; maca koz
      [makeCard(H, 6)],
      [makeCard(H, 7)],
    ],
    trump: S,
    trick: [{ seat: 0 as Seat, card: makeCard(H, 5) }],
    turn: 1 as Seat,
  };
  const legal = legalCards(state, 1 as Seat, v);
  assert.deepEqual(legal, [makeCard(S, 2)]);

  const bad = applyMove(state, { type: "play", seat: 1, card: makeCard(D, 9) }, v, SEED);
  assert.equal(bad.error?.code, "MUST_PLAY_TRUMP");
});

test("bayrak kapaliyken koz oynamak serbesttir", () => {
  const v = IHALELI_BATAK; // mustPlayTrumpWhenVoid: false
  const state: HandState = {
    ...toPlaying(v),
    hands: [[makeCard(H, 5)], [makeCard(S, 2), makeCard(D, 9)], [makeCard(H, 6)], [makeCard(H, 7)]],
    trump: S,
    trick: [{ seat: 0 as Seat, card: makeCard(H, 5) }],
    turn: 1 as Seat,
  };
  const legal = legalCards(state, 1 as Seat, v).sort((a, b) => a - b);
  assert.deepEqual(legal, [makeCard(S, 2), makeCard(D, 9)].sort((a, b) => a - b));
});

/** Rastgele ama HER ZAMAN legal oynayan bot ile eli sonuna kadar oynatir. */
function playOutHand(v: VariantConfig, state: HandState, seed = SEED): HandState {
  let s = state;
  let guard = 0;
  while (s.phase === "playing") {
    if (guard++ > 200) throw new Error("el bitmedi, sonsuz dongu");
    const legal = legalCards(s, s.turn, v);
    assert.ok(legal.length > 0, "legal hamle kalmadi");
    const r = applyMove(s, { type: "play", seat: s.turn, card: legal[0] }, v, seed);
    assert.equal(r.error, undefined, `reddedildi: ${JSON.stringify(r.error)}`);
    s = r.state;
  }
  return s;
}

test("tam el 13 tur oynanir ve biter", () => {
  const s = playOutHand(IHALELI_BATAK, toPlaying(IHALELI_BATAK));
  assert.equal(s.phase, "ended");
  assert.equal(s.trickNo, 13);
  assert.equal(s.tricksWon.reduce((a, b) => a + b, 0), 13);
  for (const h of s.hands) assert.equal(h.length, 0);
});

test("el bitince seed aciklanir ve hash ile dogrulanir", () => {
  const s = playOutHand(IHALELI_BATAK, toPlaying(IHALELI_BATAK));
  assert.equal(s.seed, SEED);
  assert.equal(hashSeed(s.seed!), s.seedHash);
});

test("dort varyantin hepsi sonuna kadar oynanabilir", () => {
  for (const v of [ESLI_BATAK, IHALELI_BATAK, KOZ_BATAK, GONUL_BATAGI]) {
    const s = playOutHand(v, toPlaying(v));
    assert.equal(s.phase, "ended", `${v.id} bitmedi`);
    assert.equal(s.tricksWon.reduce((a, b) => a + b, 0), 13, `${v.id} tur sayisi yanlis`);
    assert.ok(s.scores !== null, `${v.id} puanlanmadi`);
  }
});

test("farkli seed'lerle 200 el hatasiz oynanir", () => {
  for (let i = 0; i < 200; i++) {
    const seed = newSeed();
    const v = [ESLI_BATAK, IHALELI_BATAK, KOZ_BATAK, GONUL_BATAGI][i % 4];
    let st = startHand(v, (i % 4) as Seat, seed).state;
    if (v.bidding) {
      const order: Seat[] = [st.turn, ((st.turn + 1) % 4) as Seat,
        ((st.turn + 2) % 4) as Seat, ((st.turn + 3) % 4) as Seat];
      st = applyMove(st, { type: "bid", seat: order[0], value: 5 }, v, seed).state;
      for (const seat of order.slice(1)) {
        st = applyMove(st, { type: "pass", seat }, v, seed).state;
      }
      st = applyMove(st, { type: "chooseTrump", seat: st.highBidder!, suit: S }, v, seed).state;
    }
    const done = playOutHand(v, st, seed);
    assert.equal(done.phase, "ended");
  }
});

// ------------------------------------------------------------- puanlama

const mkState = (over: Partial<HandState>): HandState => ({
  phase: "ended", variantId: "x", dealer: 3, hands: [[], [], [], []], turn: 0,
  bids: [null, null, null, null], passed: [false, false, false, false],
  highBid: 0, highBidder: null, trump: S, leader: 0, trick: [], trickNo: 13,
  tricksWon: [0, 0, 0, 0], seedHash: "", seed: null, scores: null, ...over,
});

test("ihaleli: tutturan aldigi tur kadar puan alir", () => {
  const s = mkState({ highBidder: 0, highBid: 8, tricksWon: [9, 2, 1, 1] });
  assert.deepEqual(scoreHand(s, IHALELI_BATAK), [9, 2, 1, 1]);
});

test("ihaleli: batan taahhut degeri kadar kaybeder", () => {
  const s = mkState({ highBidder: 0, highBid: 8, tricksWon: [7, 3, 2, 1] });
  assert.deepEqual(scoreHand(s, IHALELI_BATAK), [-8, 3, 2, 1]);
});

test("ihaleli: tam taahhut kadar alirsa tutturmus sayilir", () => {
  const s = mkState({ highBidder: 2, highBid: 6, tricksWon: [3, 2, 6, 2] });
  assert.deepEqual(scoreHand(s, IHALELI_BATAK), [3, 2, 6, 2]);
});

test("contractorScoresActualTricks kapaliyken yalnizca taahhut kadar", () => {
  const v: VariantConfig = { ...IHALELI_BATAK, contractorScoresActualTricks: false };
  const s = mkState({ highBidder: 0, highBid: 8, tricksWon: [10, 1, 1, 1] });
  assert.deepEqual(scoreHand(s, v), [8, 1, 1, 1]);
});

test("esli: takim turlari toplanir, puan iki ese de yazilir", () => {
  const s = mkState({ highBidder: 0, highBid: 8, tricksWon: [5, 2, 4, 2] });
  // takim 0-2 = 9 tur, taahhut 8 -> tuttu
  assert.deepEqual(scoreHand(s, ESLI_BATAK), [9, 4, 9, 4]);
});

test("esli: takim batarsa iki es de taahhut kadar kaybeder", () => {
  const s = mkState({ highBidder: 1, highBid: 9, tricksWon: [4, 5, 1, 3] });
  // takim 1-3 = 8 tur, taahhut 9 -> batti
  assert.deepEqual(scoreHand(s, ESLI_BATAK), [5, -9, 5, -9]);
});

test("koz batak: hedefi tutturan tur kadar, tutturamayan -3", () => {
  const s = mkState({ tricksWon: [5, 3, 2, 3] });
  assert.deepEqual(scoreHand(s, KOZ_BATAK), [5, 3, -3, 3]);
});

test("gonul: her tur -1", () => {
  const s = mkState({ tricksWon: [0, 4, 6, 3] });
  assert.deepEqual(scoreHand(s, GONUL_BATAGI), [0, -4, -6, -3]);
});

test("gonul: 13 turun hepsini alan +13", () => {
  const s = mkState({ tricksWon: [13, 0, 0, 0] });
  assert.deepEqual(scoreHand(s, GONUL_BATAGI), [13, 0, 0, 0]);
});

test("gonul: slamBonus kapaliyken 13 tur -13", () => {
  const v: VariantConfig = { ...GONUL_BATAGI, slamBonus: false };
  const s = mkState({ tricksWon: [13, 0, 0, 0] });
  assert.deepEqual(scoreHand(s, v), [-13, 0, 0, 0]);
});

// ------------------------------------------------------------- saflik

test("applyMove girdiyi degistirmez", () => {
  const s = toPlaying(IHALELI_BATAK);
  const before = JSON.stringify(s);
  applyMove(s, { type: "play", seat: 0, card: s.hands[0][0] }, IHALELI_BATAK, SEED);
  assert.equal(JSON.stringify(s), before);
});

test("reddedilen hamle state'i degistirmez ve olay uretmez", () => {
  const s = toPlaying(IHALELI_BATAK);
  const r = applyMove(s, { type: "play", seat: 2, card: s.hands[2][0] }, IHALELI_BATAK, SEED);
  assert.equal(r.state, s);
  assert.deepEqual(r.events, []);
});
