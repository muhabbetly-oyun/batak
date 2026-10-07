import test from "node:test";
import assert from "node:assert/strict";

import { sign, verify, walletKey } from "../src/effects/wallet.js";
import { publicEvents } from "../src/effects/reverb.js";
import { RateLimiter, parse, toMove } from "../src/ws/protocol.js";

const SECRET = "s".repeat(64);

// ------------------------------------------------------------- imza

test("ayni govde ayni imzayi uretir", () => {
  assert.equal(sign(SECRET, '{"a":1}', 100), sign(SECRET, '{"a":1}', 100));
});

test("govde degisince imza degisir", () => {
  assert.notEqual(sign(SECRET, '{"a":1}', 100), sign(SECRET, '{"a":2}', 100));
});

test("zaman damgasi degisince imza degisir", () => {
  assert.notEqual(sign(SECRET, '{"a":1}', 100), sign(SECRET, '{"a":1}', 101));
});

test("gecerli imza dogrulanir", () => {
  const body = '{"amount":100}';
  const ts = 1_700_000_000;
  assert.equal(verify(SECRET, body, ts, sign(SECRET, body, ts), ts), true);
});

test("yanlis sir ile imza reddedilir", () => {
  const body = '{"amount":100}';
  const ts = 1_700_000_000;
  const bad = sign("x".repeat(64), body, ts);
  assert.equal(verify(SECRET, body, ts, bad, ts), false);
});

test("eski zaman damgasi reddedilir (tekrar saldirisi)", () => {
  const body = '{"amount":100}';
  const ts = 1_700_000_000;
  const sig = sign(SECRET, body, ts);
  assert.equal(verify(SECRET, body, ts, sig, ts + 301), false);
  assert.equal(verify(SECRET, body, ts, sig, ts + 299), true);
});

test("gelecekteki zaman damgasi da reddedilir", () => {
  const body = "{}";
  const ts = 1_700_000_000;
  assert.equal(verify(SECRET, body, ts, sign(SECRET, body, ts), ts - 400), false);
});

test("bozuk imza cokertmez", () => {
  assert.equal(verify(SECRET, "{}", 1, "zzz", 1), false);
  assert.equal(verify(SECRET, "{}", 1, "", 1), false);
});

test("idempotans anahtari masa + el + islemden tureir", () => {
  assert.equal(walletKey("hold", "t1", 3), "hold:t1:3");
  assert.notEqual(walletKey("hold", "t1", 3), walletKey("settle", "t1", 3));
  assert.notEqual(walletKey("hold", "t1", 3), walletKey("hold", "t1", 4));
});

// ------------------------------------------------------------- yayin

test("kart dagitimi Reverb'e basilmaz", () => {
  const evts = [
    { type: "hand_started" }, { type: "cards_dealt" },
    { type: "card_played" }, { type: "trick_won" },
  ];
  const pub = publicEvents(evts).map((e) => e.type);
  assert.deepEqual(pub, ["hand_started", "card_played", "trick_won"]);
});

// ------------------------------------------------------------- protokol

test("gecerli mesajlar ayristirilir", () => {
  assert.deepEqual(parse('{"type":"pass"}'), { ok: true, msg: { type: "pass" } });
  const b = parse('{"type":"bid","value":7}');
  assert.equal(b.ok && b.msg.type, "bid");
});

test("bozuk JSON reddedilir", () => {
  const r = parse("{bozuk");
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, "BAD_JSON");
});

test("asiri buyuk mesaj reddedilir", () => {
  const r = parse(JSON.stringify({ type: "pass", pad: "x".repeat(5000) }));
  assert.equal(r.ok === false && r.code, "TOO_LARGE");
});

test("aralik disi teklif reddedilir", () => {
  for (const v of [0, 14, -3, 1.5, "5", null]) {
    const r = parse(JSON.stringify({ type: "bid", value: v }));
    assert.equal(r.ok, false, `kabul edildi: ${v}`);
  }
});

test("aralik disi kart reddedilir", () => {
  for (const c of [-1, 52, 99, 2.5, "10"]) {
    const r = parse(JSON.stringify({ type: "play", card: c }));
    assert.equal(r.ok, false, `kabul edildi: ${c}`);
  }
});

test("gecerli kart araligi kabul edilir", () => {
  for (const c of [0, 25, 51]) {
    assert.equal(parse(JSON.stringify({ type: "play", card: c })).ok, true);
  }
});

test("bilinmeyen varyant reddedilir", () => {
  assert.equal(parse('{"type":"join","variantId":"poker"}').ok, false);
  assert.equal(parse('{"type":"join","variantId":"esli"}').ok, true);
});

test("gecersiz renk reddedilir", () => {
  assert.equal(parse('{"type":"trump","suit":4}').ok, false);
  assert.equal(parse('{"type":"trump","suit":-1}').ok, false);
  assert.equal(parse('{"type":"trump","suit":2}').ok, true);
});

test("bilinmeyen mesaj tipi reddedilir", () => {
  assert.equal(parse('{"type":"admin_payout"}').ok, false);
});

test("oda ve masa kimligi kirpilir", () => {
  const r = parse(JSON.stringify({
    type: "join", variantId: "esli", roomId: "r".repeat(200),
  }));
  assert.ok(r.ok && (r.msg as any).roomId.length === 64);
});

test("koltuk istemciden DEGIL sunucudan gelir", () => {
  // Istemci koltuk gondermeye calissa bile toMove kendi koltugunu kullanir.
  const p = parse('{"type":"play","card":10,"seat":3}');
  assert.ok(p.ok);
  const m = toMove(p.ok ? p.msg : ({} as any), 1 as any);
  assert.equal((m as any).seat, 1);
});

// ------------------------------------------------------------- hiz siniri

test("hiz siniri asildiginda reddeder", () => {
  const rl = new RateLimiter(3, 1000);
  assert.equal(rl.allow("u1", 0), true);
  assert.equal(rl.allow("u1", 10), true);
  assert.equal(rl.allow("u1", 20), true);
  assert.equal(rl.allow("u1", 30), false);
});

test("pencere kayinca yeniden izin verir", () => {
  const rl = new RateLimiter(2, 1000);
  rl.allow("u1", 0); rl.allow("u1", 10);
  assert.equal(rl.allow("u1", 20), false);
  assert.equal(rl.allow("u1", 1100), true);
});

test("hiz siniri kullanicilari ayirir", () => {
  const rl = new RateLimiter(1, 1000);
  assert.equal(rl.allow("a", 0), true);
  assert.equal(rl.allow("a", 1), false);
  assert.equal(rl.allow("b", 1), true);
});

// ------------------------------------------------------------- oturum

import { TableRegistry } from "../src/tables/registry.js";

const fakeDeps = () => {
  const sent: Array<{ seat: number; payload: any }> = [];
  return {
    sent,
    deps: {
      wallet: { hold: async () => ({ ok: true, balances: {} }),
                settle: async () => ({ ok: true, balances: {} }),
                release: async () => ({ ok: true, balances: {} }) } as any,
      reverb: { publish: async () => true } as any,
      store: {
        append: async () => {}, upsertTable: async () => {},
        startHand: async () => 1, endHand: async () => {},
        logWalletCall: async () => {}, logFingerprint: async () => {},
      } as any,
      sendToSeat: (_t: string, seat: any, payload: any) => sent.push({ seat, payload }),
      log: () => {},
    },
  };
};

const cfg = () => ({
  variants: {
    esli: { id: "esli", label: "E", partnership: true, bidding: true, minBid: 5,
            maxBid: 13, fixedTarget: null, noTrump: false, inverted: false,
            slamBonus: false, mustPlayTrumpWhenVoid: false,
            contractorScoresActualTricks: true, forceLastBidder: true },
  },
  timers: { bid: 20000, trump: 15000, play: 20000, handEnd: 5000, reconnect: 90000 },
  enabled: { esli: true },
  stakes: { esli: 100 },
  updatedAt: null, updatedBy: null,
}) as any;

test("kapali varyanta oturulamaz", async () => {
  const { deps } = fakeDeps();
  const c = cfg(); c.enabled.esli = false;
  const r = new TableRegistry(deps as any, () => c);
  const res = await r.join({ userId: "u1", username: "A", variantId: "esli" });
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, "VARIANT_CLOSED");
});

test("ayni oyuncu iki masaya oturamaz", async () => {
  const { deps } = fakeDeps();
  const r = new TableRegistry(deps as any, cfg);
  const a = await r.join({ userId: "u1", username: "A", variantId: "esli" });
  assert.equal(a.ok, true);
  const b = await r.join({ userId: "u1", username: "A", variantId: "esli" });
  assert.equal(b.ok === false && b.code, "ALREADY_SEATED");
});

test("dort oyuncu ayni masaya dolar", async () => {
  const { deps } = fakeDeps();
  const r = new TableRegistry(deps as any, cfg);
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await r.join({ userId: `u${i}`, username: `O${i}`, variantId: "esli" });
    assert.equal(res.ok, true);
    if (res.ok) ids.push(res.tableId);
  }
  assert.equal(new Set(ids).size, 1, "oyuncular farkli masalara dagildi");
  assert.equal(r.list().length, 1);
});

test("besinci oyuncu yeni masa acar", async () => {
  const { deps } = fakeDeps();
  const r = new TableRegistry(deps as any, cfg);
  for (let i = 0; i < 5; i++) {
    await r.join({ userId: `u${i}`, username: `O${i}`, variantId: "esli" });
  }
  assert.equal(r.list().length, 2);
});

test("ayni odadaki masa tercih edilir", async () => {
  const { deps } = fakeDeps();
  const r = new TableRegistry(deps as any, cfg);
  await r.join({ userId: "a", username: "A", variantId: "esli", roomId: "oda1" });
  await r.join({ userId: "b", username: "B", variantId: "esli", roomId: "oda1" });
  const list = r.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].roomId, "oda1");
  assert.equal(list[0].players, 2);
});

test("masadan ayrilan oyuncu yeniden oturabilir", async () => {
  const { deps } = fakeDeps();
  const r = new TableRegistry(deps as any, cfg);
  await r.join({ userId: "u1", username: "A", variantId: "esli" });
  await r.leave("u1");
  const again = await r.join({ userId: "u1", username: "A", variantId: "esli" });
  assert.equal(again.ok, true);
});

test("bulunmayan masaya davet reddedilir", async () => {
  const { deps } = fakeDeps();
  const r = new TableRegistry(deps as any, cfg);
  const res = await r.join({
    userId: "u1", username: "A", variantId: "esli", tableId: "yok-boyle",
  });
  assert.equal(res.ok === false && res.code, "TABLE_NOT_FOUND");
});

// ------------------------------------------------------------- salonlar

const cfgR = () => {
  const c = cfg();
  c.regions = [
    { id: "genel", label: "Genel salon", enabled: true },
    { id: "ege", label: "Ege", enabled: true },
  ];
  return c;
};

test("ayni salondan bekleyen masa tercih edilir", async () => {
  const { deps } = fakeDeps();
  const r = new TableRegistry(deps as any, cfgR);
  await r.join({ userId: "a", username: "A", variantId: "esli", region: "ege" });
  await r.join({ userId: "b", username: "B", variantId: "esli", region: "ege" });
  const list = r.list();
  assert.equal(list.length, 1, "ayni salondakiler ayrildi");
  assert.equal(list[0].region, "ege");
});

test("salon bos ise baska salondaki masaya oturulur", async () => {
  const { deps } = fakeDeps();
  const r = new TableRegistry(deps as any, cfgR);
  await r.join({ userId: "a", username: "A", variantId: "esli", region: "ege" });
  // Marmara'dan gelen oyuncu, bekleyen tek masa Ege'de olsa da oraya oturur.
  const res = await r.join({ userId: "b", username: "B", variantId: "esli", region: "marmara" });
  assert.equal(res.ok, true);
  assert.equal(r.list().length, 1, "havuz bolundu — masa dolulugu duser");
});

test("salon istatistigi insan oyuncuyu sayar, botu saymaz", async () => {
  const { deps } = fakeDeps();
  const r = new TableRegistry(deps as any, cfgR);
  await r.join({ userId: "a", username: "A", variantId: "esli", region: "ege" });
  await r.join({ userId: "b", username: "B", variantId: "esli", region: "ege" });
  const st = r.regionStats();
  assert.equal(st.ege.players, 2);
  assert.equal(st.ege.waiting, 1);
});

test("salonsuz katilim genel sayilir", async () => {
  const { deps } = fakeDeps();
  const r = new TableRegistry(deps as any, cfgR);
  await r.join({ userId: "a", username: "A", variantId: "esli" });
  assert.equal(r.regionStats().genel.players, 1);
});

test("gecersiz salon kimligi protokolde dusurulur", () => {
  const bad = parse(JSON.stringify({ type: "join", variantId: "esli", region: "ÇOK UZUN SALON ADI!" }));
  assert.ok(bad.ok);
  assert.equal(bad.ok && (bad.msg as any).region, null);
  const good = parse(JSON.stringify({ type: "join", variantId: "esli", region: "ege" }));
  assert.equal(good.ok && (good.msg as any).region, "ege");
});

// ------------------------------------------------------------- sohbet

import { QUICK_PHRASES } from "../src/ws/protocol.js";

test("sohbet mesaji ayristirilir ve kirpilir", () => {
  const r = parse(JSON.stringify({ type: "chat", text: "  merhaba   dostlar  " }));
  assert.ok(r.ok);
  assert.equal(r.ok && (r.msg as any).text, "merhaba dostlar");
});

test("bos sohbet reddedilir", () => {
  assert.equal(parse('{"type":"chat","text":"   "}').ok, false);
  assert.equal(parse('{"type":"chat","text":""}').ok, false);
  assert.equal(parse('{"type":"chat"}').ok, false);
});

test("sohbet 200 karaktere kirpilir", () => {
  const r = parse(JSON.stringify({ type: "chat", text: "a".repeat(500) }));
  assert.ok(r.ok);
  assert.equal(r.ok && (r.msg as any).text.length, 200);
});

test("kontrol karakterleri temizlenir", () => {
  const r = parse(JSON.stringify({ type: "chat", text: "iyi\u0000oyun\u200b\u2028lar" }));
  assert.ok(r.ok);
  const t = r.ok ? (r.msg as any).text : "";
  assert.ok(!/[\u0000\u200b\u2028]/.test(t), `temizlenmedi: ${JSON.stringify(t)}`);
});

test("bilinmeyen hazir ifade reddedilir", () => {
  assert.equal(parse('{"type":"quick","id":"yok_boyle"}').ok, false);
  assert.equal(parse('{"type":"quick","id":"iyi_oyun"}').ok, true);
});

test("hazir ifadeler tanimli ve bos degil", () => {
  const vals = Object.values(QUICK_PHRASES);
  assert.ok(vals.length >= 6);
  for (const v of vals) assert.ok(v.trim().length > 0);
});
