import test from "node:test";
import assert from "node:assert/strict";

import { createTable, step, viewFor } from "../src/table/actor.js";
import type { TableState } from "../src/table/types.js";
import { ESLI_BATAK, IHALELI_BATAK, KOZ_BATAK, GONUL_BATAGI } from "../src/variants.js";
import type { Seat } from "../src/types.js";

const SEED = "c".repeat(64);
const seedFn = () => SEED;

const T0 = 1_000_000;

function seated(variant = IHALELI_BATAK, handsToPlay = 4): TableState {
  let s = createTable({
    tableId: "t1",
    variant,
    endCondition: { kind: "fixedHands", value: handsToPlay },
    stake: 100,
  });
  for (const i of [0, 1, 2, 3] as Seat[]) {
    const r = step(s, {
      type: "join", seat: i, userId: `u${i}`, username: `oyuncu${i}`, now: T0,
    }, seedFn);
    assert.equal(r.error, undefined);
    s = r.state;
  }
  return s;
}

// ------------------------------------------------------------- oturma

test("dort koltuk dolunca el baslar", () => {
  const s = seated();
  assert.equal(s.phase, "playing");
  assert.equal(s.handNo, 1);
  assert.ok(s.hand !== null);
  assert.ok(s.deadline !== null);
});

test("dolu koltuga oturulamaz", () => {
  let s = createTable({
    tableId: "t", variant: IHALELI_BATAK,
    endCondition: { kind: "fixedHands", value: 4 }, stake: 100,
  });
  s = step(s, { type: "join", seat: 0, userId: "a", username: "A", now: T0 }, seedFn).state;
  const r = step(s, { type: "join", seat: 0, userId: "b", username: "B", now: T0 }, seedFn);
  assert.equal(r.error?.code, "SEAT_TAKEN");
});

test("ayni oyuncu iki koltuga oturamaz", () => {
  let s = createTable({
    tableId: "t", variant: IHALELI_BATAK,
    endCondition: { kind: "fixedHands", value: 4 }, stake: 100,
  });
  s = step(s, { type: "join", seat: 0, userId: "a", username: "A", now: T0 }, seedFn).state;
  const r = step(s, { type: "join", seat: 1, userId: "a", username: "A", now: T0 }, seedFn);
  assert.equal(r.error?.code, "ALREADY_SEATED");
});

test("el baslayinca cuzdan hold istenir", () => {
  let s = createTable({
    tableId: "t", variant: IHALELI_BATAK,
    endCondition: { kind: "fixedHands", value: 4 }, stake: 250,
  });
  let last;
  for (const i of [0, 1, 2, 3] as Seat[]) {
    last = step(s, { type: "join", seat: i, userId: `u${i}`, username: `o${i}`, now: T0 }, seedFn);
    s = last.state;
  }
  const hold = last!.effects.find((e) => e.kind === "wallet_hold");
  assert.ok(hold, "wallet_hold efekti yok");
  assert.equal((hold as any).amount, 250);
  assert.deepEqual((hold as any).userIds, ["u0", "u1", "u2", "u3"]);
});

// ------------------------------------------------------------- kopma

test("kopan oyuncunun yeri reconnect penceresi boyunca korunur", () => {
  let s = seated();
  const victim = s.hand!.turn;
  s = step(s, { type: "disconnect", seat: victim, now: T0 }, seedFn).state;
  assert.equal(s.seats[victim].disconnected, true);
  assert.equal(s.seats[victim].bot, false);

  // Pencere dolmadan tick
  s = step(s, { type: "tick", now: T0 + 89_000 }, seedFn).state;
  assert.equal(s.seats[victim].bot, false, "pencere dolmadan bot devraldi");
});

test("pencere dolunca bot devralir", () => {
  let s = seated();
  const victim = s.hand!.turn;
  s = step(s, { type: "disconnect", seat: victim, now: T0 }, seedFn).state;
  const r = step(s, { type: "tick", now: T0 + 91_000 }, seedFn);
  assert.equal(r.state.seats[victim].bot, true);
  assert.ok(r.events.some((e) => e.type === "bot_took_over"));
});

test("oyuncu donunce bot birakilir", () => {
  let s = seated();
  const victim = s.hand!.turn;
  s = step(s, { type: "disconnect", seat: victim, now: T0 }, seedFn).state;
  s = step(s, { type: "tick", now: T0 + 91_000 }, seedFn).state;
  assert.equal(s.seats[victim].bot, true);

  const r = step(s, { type: "reconnect", seat: victim, now: T0 + 95_000 }, seedFn);
  assert.equal(r.state.seats[victim].disconnected, false);
  assert.equal(r.state.seats[victim].bot, false);
  assert.ok(r.events.some((e) => e.type === "bot_released"));
});

test("bot koltuguna oyuncu hamlesi gonderilemez", () => {
  let s = seated();
  const victim = s.hand!.turn;
  s = step(s, { type: "disconnect", seat: victim, now: T0 }, seedFn).state;
  s = step(s, { type: "tick", now: T0 + 91_000 }, seedFn).state;
  // bot devraldiktan sonra sira ilerlemis olabilir; yine de o koltuga dene
  const r = step(s, {
    type: "move", seat: victim, move: { type: "pass", seat: victim }, now: T0 + 92_000,
  }, seedFn);
  assert.ok(r.error, "bot koltugundan hamle kabul edildi");
});

// ------------------------------------------------------------- sureler

test("sure dolunca otomatik hamle yapilir", () => {
  const s = seated();
  const before = s.hand!.turn;
  const r = step(s, { type: "tick", now: s.deadline!.at + 1 }, seedFn);
  assert.ok(r.events.some((e) => e.type === "player_timeout"));
  assert.notEqual(r.state.hand!.turn, before, "sira ilerlemedi");
});

test("ihalede sure dolunca pas gecilir", () => {
  const s = seated(IHALELI_BATAK);
  assert.equal(s.hand!.phase, "bidding");
  const seat = s.hand!.turn;
  const r = step(s, { type: "tick", now: s.deadline!.at + 1 }, seedFn);
  assert.equal(r.state.hand!.passed[seat], true);
});

test("deadline her hamlede yenilenir", () => {
  const s = seated();
  const d1 = s.deadline!.at;
  const seat = s.hand!.turn;
  const r = step(s, {
    type: "move", seat, move: { type: "bid", seat, value: 5 }, now: T0 + 5_000,
  }, seedFn);
  assert.ok(r.state.deadline!.at > d1);
});

// ------------------------------------------------------------- el dongusu

/** Masayi sonuna kadar tick ve hamlelerle oynatir. */
function runTable(s0: TableState, maxSteps = 4000): TableState {
  let s = s0;
  let now = T0;
  for (let i = 0; i < maxSteps && s.phase !== "finished"; i++) {
    now += 1000;
    if (s.phase === "playing" && s.hand) {
      const seat = s.hand.turn;
      // Insan oyuncu: her zaman sureyi doldurup otomatik hamleye birak
      now = Math.max(now, s.deadline!.at + 1);
      s = step(s, { type: "tick", now }, seedFn).state;
    } else {
      if (s.deadline) now = Math.max(now, s.deadline.at + 1);
      s = step(s, { type: "tick", now }, seedFn).state;
    }
  }
  return s;
}

test("masa 4 el sonunda biter", () => {
  const s = runTable(seated(IHALELI_BATAK, 4));
  assert.equal(s.phase, "finished", `faz: ${s.phase}, el: ${s.handNo}`);
  assert.equal(s.handNo, 4);
});

test("dort varyantin masasi da sonuna kadar gider", () => {
  for (const v of [ESLI_BATAK, IHALELI_BATAK, KOZ_BATAK, GONUL_BATAGI]) {
    const s = runTable(seated(v, 2));
    assert.equal(s.phase, "finished", `${v.id} bitmedi (faz ${s.phase})`);
  }
});

test("el bitince cuzdan settle istenir", () => {
  let s = seated(KOZ_BATAK, 1);
  let now = T0;
  let settle;
  for (let i = 0; i < 400 && s.phase !== "finished"; i++) {
    now = s.deadline ? s.deadline.at + 1 : now + 1000;
    const r = step(s, { type: "tick", now }, seedFn);
    s = r.state;
    const f = r.effects.find((e) => e.kind === "wallet_settle");
    if (f) settle = f;
  }
  assert.ok(settle, "wallet_settle efekti uretilmedi");
  assert.equal((settle as any).deltas.length, 4);
});

test("tum koltuklar bot olsa bile masa biter", () => {
  let s = seated(IHALELI_BATAK, 2);
  for (const i of [0, 1, 2, 3] as Seat[]) {
    s = step(s, { type: "disconnect", seat: i, now: T0 }, seedFn).state;
  }
  s = step(s, { type: "tick", now: T0 + 91_000 }, seedFn).state;
  assert.ok(s.seats.every((x) => x.bot), "hepsi bot olmadi");
  const done = runTable(s, 2000);
  assert.equal(done.phase, "finished");
});

// ------------------------------------------------------------- gorunum

test("viewFor rakip kartlarini sizdirmaz", () => {
  const s = seated();
  const v = viewFor(s, 0 as Seat) as any;
  const json = JSON.stringify(v);
  // Koltuk 1'in kartlarindan hicbiri gorunumde olmamali
  for (const c of s.hand!.hands[1]) {
    assert.ok(
      !v.hand.myCards.includes(c),
      `koltuk 1'in karti ${c} koltuk 0'in gorunumunde`,
    );
  }
  assert.equal(v.hand.myCards.length, 13);
  assert.ok(!json.includes('"hands"'), "ham el dizisi gorunume sizdi");
});

test("viewFor el bitmeden seed'i aciklamaz", () => {
  const s = seated();
  const v = viewFor(s, 0 as Seat) as any;
  assert.equal(v.hand.seed, null);
  assert.equal(typeof v.hand.seedHash, "string");
});

test("viewFor seyirciye hic kart vermez", () => {
  const s = seated();
  const v = viewFor(s, null) as any;
  assert.deepEqual(v.hand.myCards, []);
});

// ------------------------------------------------------------- ayar kopyasi

test("masa, varyant ayarinin kopyasini tutar", () => {
  const cfg = { ...IHALELI_BATAK };
  const s = createTable({
    tableId: "t", variant: cfg,
    endCondition: { kind: "fixedHands", value: 4 }, stake: 100,
  });
  cfg.minBid = 99; // panelden ayar degisti
  assert.equal(s.variant.minBid, 5, "oynanan masa ayar degisikliginden etkilendi");
});

test("step girdiyi degistirmez", () => {
  const s = seated();
  const before = JSON.stringify(s);
  step(s, { type: "tick", now: T0 + 1 }, seedFn);
  assert.equal(JSON.stringify(s), before);
});

// ------------------------------------------------------------- bot masasi

const practice = (secs = 30) => createTable({
  tableId: "p1", variant: IHALELI_BATAK,
  endCondition: { kind: "fixedHands", value: 2 },
  stake: 0, botFillSeconds: secs,
});

test("bahissiz masa alistirma olarak isaretlenir", () => {
  assert.equal(practice().practice, true);
  const paid = createTable({
    tableId: "x", variant: IHALELI_BATAK,
    endCondition: { kind: "fixedHands", value: 2 }, stake: 100,
  });
  assert.equal(paid.practice, false);
});

test("ilk oyuncu oturunca bot sayaci baslar", () => {
  const r = step(practice(30), {
    type: "join", seat: 0, userId: "u0", username: "Siz", now: T0,
  }, seedFn);
  assert.equal(r.state.botFillAt, T0 + 30_000);
  assert.ok(r.effects.some((e) => e.kind === "schedule"));
});

test("sayac dolunca bos koltuklari bot alir ve el baslar", () => {
  let s = step(practice(30), {
    type: "join", seat: 0, userId: "u0", username: "Siz", now: T0,
  }, seedFn).state;
  assert.equal(s.phase, "waiting");

  const r = step(s, { type: "tick", now: T0 + 31_000 }, seedFn);
  assert.equal(r.state.phase, "playing", "el baslamadi");
  assert.equal(r.state.seats.filter((x) => x.bot).length, 3);
  assert.equal(r.state.seats[0].bot, false, "insan oyuncu bota cevrildi");
  assert.equal(r.state.botFillAt, null);
});

test("sayac dolmadan bot oturmaz", () => {
  let s = step(practice(30), {
    type: "join", seat: 0, userId: "u0", username: "Siz", now: T0,
  }, seedFn).state;
  const r = step(s, { type: "tick", now: T0 + 29_000 }, seedFn);
  assert.equal(r.state.phase, "waiting");
  assert.equal(r.state.seats.filter((x) => x.bot).length, 0);
});

test("masa insanlarla dolarsa bot beklenmez", () => {
  let s = practice(30);
  for (const i of [0, 1, 2, 3] as Seat[]) {
    s = step(s, {
      type: "join", seat: i, userId: `u${i}`, username: `O${i}`, now: T0,
    }, seedFn).state;
  }
  assert.equal(s.phase, "playing");
  assert.equal(s.botFillAt, null);
  assert.equal(s.seats.filter((x) => x.bot).length, 0);
});

test("alistirma masasi cuzdana HIC dokunmaz", () => {
  let s = practice(30);
  let all: string[] = [];
  const push = (r: ReturnType<typeof step>) => {
    all.push(...r.effects.map((e) => e.kind));
    return r.state;
  };
  s = push(step(s, { type: "join", seat: 0, userId: "u0", username: "Siz", now: T0 }, seedFn));
  s = push(step(s, { type: "tick", now: T0 + 31_000 }, seedFn));

  let now = T0 + 31_000;
  for (let i = 0; i < 600 && s.phase !== "finished"; i++) {
    now = s.deadline ? s.deadline.at + 1 : now + 1000;
    s = push(step(s, { type: "tick", now }, seedFn));
  }
  assert.equal(s.phase, "finished", "masa bitmedi");
  const wallet = all.filter((k) => k.startsWith("wallet_"));
  assert.deepEqual(wallet, [], `cuzdan cagrildi: ${wallet.join(",")}`);
});

test("bahisli masada bot doldurma calismaz", () => {
  const paid = createTable({
    tableId: "x", variant: IHALELI_BATAK,
    endCondition: { kind: "fixedHands", value: 2 },
    stake: 100, botFillSeconds: 30,
  });
  const s = step(paid, {
    type: "join", seat: 0, userId: "u0", username: "Siz", now: T0,
  }, seedFn).state;
  assert.equal(s.botFillAt, null, "bahisli masada bot sayaci baslatildi");

  const r = step(s, { type: "tick", now: T0 + 60_000 }, seedFn);
  assert.equal(r.state.phase, "waiting");
  assert.equal(r.state.seats.filter((x) => x.bot).length, 0);
});

test("botlarla dolan masa sonuna kadar oynanir", () => {
  let s = step(practice(30), {
    type: "join", seat: 0, userId: "u0", username: "Siz", now: T0,
  }, seedFn).state;
  s = step(s, { type: "tick", now: T0 + 31_000 }, seedFn).state;
  const done = runTable(s, 2000);
  assert.equal(done.phase, "finished");
  assert.equal(done.handNo, 2);
});

test("masa bolgesini saklar", () => {
  const s = createTable({
    tableId: "r1", variant: IHALELI_BATAK,
    endCondition: { kind: "fixedHands", value: 2 },
    stake: 0, region: "ege",
  });
  assert.equal(s.region, "ege");
});
