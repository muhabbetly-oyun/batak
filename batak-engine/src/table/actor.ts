import { applyMove, legalCards, startHand } from "../engine.js";
import { newSeed } from "../deck.js";
import { addHandScores, isGameOver, winner } from "../scoring.js";
import type { EndCondition } from "../scoring.js";
import type { HandState, Move, Seat } from "../types.js";
import type { VariantConfig } from "../variants.js";
import { botMove, bidOrPass } from "./bot.js";
import {
  DEFAULT_TIMERS, type Deadline, type Effect, type SeatState,
  type StepResult, type TableEvent, type TableInput, type TableState,
  type Timers,
} from "./types.js";

const next = (s: Seat): Seat => ((s + 1) % 4) as Seat;
const emptySeat = (): SeatState => ({
  userId: null, username: null, disconnected: false,
  disconnectedAt: null, bot: false, abandons: 0,
});

export interface CreateTableOptions {
  tableId: string;
  variant: VariantConfig;
  endCondition: EndCondition;
  stake: number;
  roomId?: string | null;
  timers?: Partial<Timers>;
}

export function createTable(o: CreateTableOptions): TableState {
  return {
    tableId: o.tableId,
    // Ayarin KOPYASI. Panelden degisse bile bu masa kendi kurallariyla biter.
    variant: { ...o.variant },
    timers: { ...DEFAULT_TIMERS, ...o.timers },
    endCondition: { ...o.endCondition },
    stake: o.stake,
    roomId: o.roomId ?? null,
    phase: "waiting",
    seats: [emptySeat(), emptySeat(), emptySeat(), emptySeat()],
    dealer: 3,
    handNo: 0,
    scores: [0, 0, 0, 0],
    timesSet: [0, 0, 0, 0],
    hand: null,
    seed: null,
    deadline: null,
    consecutiveVoids: 0,
  };
}

/**
 * Masa aktorunun tek giris noktasi. SAF: zaman `input.now` ile disaridan
 * gelir, rastgelelik `seedFn` ile. Boylece "90 saniye gecti" senaryosu
 * testte milisaniye beklemeden kurulabilir.
 */
export function step(
  s0: TableState,
  input: TableInput,
  seedFn: () => string = newSeed,
): StepResult {
  const events: TableEvent[] = [];
  const effects: Effect[] = [];
  let s: TableState = { ...s0, seats: s0.seats.map((x) => ({ ...x })) };

  switch (input.type) {
    case "join": {
      if (s.seats[input.seat].userId !== null) {
        return fail(s0, "SEAT_TAKEN", "Koltuk dolu.");
      }
      if (s.seats.some((x) => x.userId === input.userId)) {
        return fail(s0, "ALREADY_SEATED", "Bu oyuncu zaten masada.");
      }
      s.seats[input.seat] = {
        ...emptySeat(), userId: input.userId, username: input.username,
      };
      events.push({
        type: "seat_taken", seat: input.seat,
        userId: input.userId, username: input.username,
      });
      if (s.phase === "waiting" && s.seats.every((x) => x.userId !== null)) {
        startNextHand(s, events, effects, input.now, seedFn);
      }
      break;
    }

    case "leave": {
      const seat = s.seats[input.seat];
      const abandoned = s.phase === "playing";
      if (abandoned) seat.abandons++;
      events.push({
        type: "seat_left", seat: input.seat, userId: seat.userId, abandoned,
      });
      if (abandoned) {
        // El ortasinda terk: yeri bot alir, el biter, bahsi kaybeder.
        seat.bot = true;
        events.push({ type: "bot_took_over", seat: input.seat });
      } else {
        s.seats[input.seat] = emptySeat();
      }
      break;
    }

    case "disconnect": {
      const seat = s.seats[input.seat];
      if (seat.userId === null || seat.disconnected) break;
      seat.disconnected = true;
      seat.disconnectedAt = input.now;
      events.push({ type: "player_disconnected", seat: input.seat });
      effects.push({ kind: "schedule", at: input.now + s.timers.reconnect });
      break;
    }

    case "reconnect": {
      const seat = s.seats[input.seat];
      if (seat.userId === null) break;
      seat.disconnected = false;
      seat.disconnectedAt = null;
      events.push({ type: "player_reconnected", seat: input.seat });
      if (seat.bot) {
        seat.bot = false;
        events.push({ type: "bot_released", seat: input.seat });
      }
      break;
    }

    case "move": {
      if (s.phase !== "playing" || s.hand === null) {
        return fail(s0, "NOT_PLAYING", "Masada suren bir el yok.");
      }
      if (s.seats[input.seat].bot) {
        return fail(s0, "SEAT_IS_BOT", "Bu koltugu bot oynuyor.");
      }
      const r = applyMove(s.hand, input.move, s.variant, s.seed!);
      if (r.error) return fail(s0, r.error.code, r.error.message);
      s.hand = r.state;
      events.push(...r.events);
      afterHandProgress(s, events, effects, input.now, seedFn);
      break;
    }

    case "tick": {
      applyTick(s, events, effects, input.now, seedFn);
      break;
    }
  }

  // Bot sirasi geldiyse oynat. Dongu: bot botu takip edebilir.
  runBots(s, events, effects, input.now, seedFn);

  if (events.length > 0) {
    effects.push({ kind: "persist_events", tableId: s.tableId, events });
    effects.push({ kind: "publish", channel: `table.${s.tableId}`, events });
  }
  if (s.deadline) effects.push({ kind: "schedule", at: s.deadline.at });

  return { state: s, events, effects };
}

function fail(state: TableState, code: string, message: string): StepResult {
  return { state, events: [], effects: [], error: { code, message } };
}

// ----------------------------------------------------------- zamanlayici

function applyTick(
  s: TableState, events: TableEvent[], effects: Effect[],
  now: number, seedFn: () => string,
): void {
  // 1) Yeniden baglanma penceresi dolanlari bota devret.
  for (const i of [0, 1, 2, 3] as Seat[]) {
    const seat = s.seats[i];
    if (
      seat.disconnected && !seat.bot && seat.disconnectedAt !== null &&
      now - seat.disconnectedAt >= s.timers.reconnect
    ) {
      seat.bot = true;
      events.push({ type: "bot_took_over", seat: i });
    }
  }

  // 2) El sonu beklemesi bittiyse sonraki eli bas.
  if (s.phase === "handEnd" && s.deadline && now >= s.deadline.at) {
    s.deadline = null;
    startNextHand(s, events, effects, now, seedFn);
    return;
  }

  // 3) Hamle suresi dolduysa otomatik hamle yap.
  if (s.phase === "playing" && s.deadline && now >= s.deadline.at && s.hand) {
    const seat = s.deadline.seat;
    events.push({ type: "player_timeout", seat, kind: s.deadline.kind });
    const auto = autoMove(s.hand, seat, s.variant);
    const r = applyMove(s.hand, auto, s.variant, s.seed!);
    if (!r.error) {
      s.hand = r.state;
      events.push(...r.events);
      afterHandProgress(s, events, effects, now, seedFn);
    }
  }
}

/** Sure dolunca yapilan hamle. Botla ayni degil: daha da muhafazakar. */
function autoMove(h: HandState, seat: Seat, v: VariantConfig): Move {
  if (h.phase === "bidding") return bidOrPass(h, seat, v);
  if (h.phase === "trump") {
    const counts = [0, 0, 0, 0];
    for (const c of h.hands[seat]) counts[Math.floor(c / 13)]++;
    return { type: "chooseTrump", seat, suit: counts.indexOf(Math.max(...counts)) as 0 | 1 | 2 | 3 };
  }
  const legal = legalCards(h, seat, v);
  return { type: "play", seat, card: legal[0] };
}

function runBots(
  s: TableState, events: TableEvent[], effects: Effect[],
  now: number, seedFn: () => string,
): void {
  let guard = 0;
  while (s.phase === "playing" && s.hand && s.seats[s.hand.turn].bot) {
    if (guard++ > 60) break;
    const seat = s.hand.turn;
    const r = applyMove(s.hand, botMove(s.hand, seat, s.variant), s.variant, s.seed!);
    if (r.error) break;
    s.hand = r.state;
    events.push(...r.events);
    afterHandProgress(s, events, effects, now, seedFn);
  }
}

// ----------------------------------------------------------- el dongusu

function startNextHand(
  s: TableState, events: TableEvent[], effects: Effect[],
  now: number, seedFn: () => string,
): void {
  if (s.seats.some((x) => x.userId === null)) {
    s.phase = "waiting";
    s.deadline = null;
    return;
  }

  if (s.handNo === 0) events.push({ type: "table_started" });

  s.handNo++;
  s.dealer = next(s.dealer);
  s.seed = seedFn();

  const { state: hand, events: he } = startHand(s.variant, s.dealer, s.seed);
  s.hand = hand;
  s.phase = "playing";
  events.push(...he);

  effects.push({
    kind: "wallet_hold",
    tableId: s.tableId, handNo: s.handNo,
    seats: [0, 1, 2, 3],
    userIds: s.seats.map((x) => x.userId!),
    amount: s.stake,
  });

  setDeadline(s, now);
}

/** El ilerledikce faz, deadline ve el sonu islerini yurutur. */
function afterHandProgress(
  s: TableState, events: TableEvent[], effects: Effect[],
  now: number, seedFn: () => string,
): void {
  if (!s.hand) return;

  if (s.hand.phase === "voided") {
    // Dort pas: bahis iade, yeniden dagit.
    effects.push({
      kind: "wallet_release",
      tableId: s.tableId, handNo: s.handNo,
      userIds: s.seats.map((x) => x.userId!), amount: s.stake,
    });
    events.push({ type: "hand_voided_redeal", handNo: s.handNo });
    s.consecutiveVoids++;
    s.handNo--; // ayni el numarasi yeniden denenir
    // Spec: ust uste 3 iptalden sonra dagitan degisir.
    if (s.consecutiveVoids < 3) {
      s.dealer = ((s.dealer + 3) % 4) as Seat;
    }
    // Guvenlik kemeri: forceLastBidder kapaliysa sonsuz dongu olusabilir.
    if (s.consecutiveVoids > 10) {
      s.phase = "finished";
      s.deadline = null;
      events.push({ type: "table_finished", scores: s.scores, winner: null });
      return;
    }
    startNextHand(s, events, effects, now, seedFn);
    return;
  }

  if (s.hand.phase === "ended") {
    const hs = s.hand.scores ?? [0, 0, 0, 0];
    s.scores = addHandScores(s.scores, hs);
    for (const i of [0, 1, 2, 3] as Seat[]) if (hs[i] < 0) s.timesSet[i]++;

    effects.push({
      kind: "wallet_settle",
      tableId: s.tableId, handNo: s.handNo,
      userIds: s.seats.map((x) => x.userId!),
      deltas: hs.map((p) => p * s.stake),
    });

    s.consecutiveVoids = 0;

    if (isGameOver(s.endCondition, s.handNo, s.scores, s.variant)) {
      s.phase = "finished";
      s.deadline = null;
      const w = winner(s.scores, s.timesSet, s.variant);
      events.push({ type: "table_finished", scores: s.scores, winner: w });
      return;
    }

    s.phase = "handEnd";
    s.deadline = { at: now + s.timers.handEnd, seat: s.dealer, kind: "handEnd" };
    return;
  }

  setDeadline(s, now);
}

function setDeadline(s: TableState, now: number): void {
  if (!s.hand || s.phase !== "playing") { s.deadline = null; return; }
  const kind: Deadline["kind"] =
    s.hand.phase === "bidding" ? "bid" :
    s.hand.phase === "trump" ? "trump" : "play";
  const ms = kind === "bid" ? s.timers.bid
    : kind === "trump" ? s.timers.trump
    : s.timers.play;
  s.deadline = { at: now + ms, seat: s.hand.turn, kind };
}

/** Istemciye gidecek gorunum. Rakip kartlari ASLA burada degildir. */
export function viewFor(s: TableState, seat: Seat | null): unknown {
  return {
    tableId: s.tableId,
    variant: s.variant.id,
    phase: s.phase,
    handNo: s.handNo,
    scores: s.scores,
    dealer: s.dealer,
    deadline: s.deadline,
    seats: s.seats.map((x, i) => ({
      seat: i, username: x.username,
      disconnected: x.disconnected, bot: x.bot,
      cardCount: s.hand ? s.hand.hands[i].length : 0,
    })),
    hand: s.hand && {
      phase: s.hand.phase,
      turn: s.hand.turn,
      trump: s.hand.trump,
      trick: s.hand.trick,
      trickNo: s.hand.trickNo,
      tricksWon: s.hand.tricksWon,
      highBid: s.hand.highBid,
      highBidder: s.hand.highBidder,
      bids: s.hand.bids,
      seedHash: s.hand.seedHash,
      seed: s.hand.seed,
      // Yalnizca KENDI kartlari.
      myCards: seat === null ? [] : s.hand.hands[seat],
      myLegalCards:
        seat !== null && s.hand.phase === "playing" && s.hand.turn === seat
          ? legalCards(s.hand, seat, s.variant)
          : [],
    },
  };
}
