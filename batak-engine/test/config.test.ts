import test from "node:test";
import assert from "node:assert/strict";

import { defaultConfig, merge, validate } from "../src/config/store.js";

test("varsayilan ayar gecerlidir", () => {
  assert.deepEqual(validate(defaultConfig()), []);
});

test("lansmanda yalnizca esli acik", () => {
  const c = defaultConfig();
  assert.equal(c.enabled.esli, true);
  assert.equal(c.enabled.ihaleli, false);
  assert.equal(c.enabled.koz, false);
  assert.equal(c.enabled.gonul, false);
});

test("merge yalnizca izinli alanlari gecirir", () => {
  const c = defaultConfig();
  const n = merge(c, {
    variants: { esli: { minBid: 6, partnership: false, id: "hack" } },
  });
  assert.equal(n.variants.esli.minBid, 6);
  assert.equal(n.variants.esli.partnership, true, "partnership degistirilebildi");
  assert.equal(n.variants.esli.id, "esli", "id degistirilebildi");
});

test("merge girdiyi degistirmez", () => {
  const c = defaultConfig();
  const before = JSON.stringify(c);
  merge(c, { variants: { esli: { minBid: 9 } }, timers: { play: 30000 } });
  assert.equal(JSON.stringify(c), before);
});

test("gecersiz minBid yakalanir", () => {
  const c = merge(defaultConfig(), { variants: { esli: { minBid: 0 } } });
  const issues = validate(c);
  assert.ok(issues.some((i) => i.path === "variants.esli.minBid"));
});

test("maxBid minBid'in altinda olamaz", () => {
  const c = merge(defaultConfig(), { variants: { esli: { minBid: 8, maxBid: 6 } } });
  assert.ok(validate(c).some((i) => i.path === "variants.esli.maxBid"));
});

test("cok kisa sure reddedilir", () => {
  const c = merge(defaultConfig(), { timers: { play: 2000 } });
  assert.ok(validate(c).some((i) => i.path === "timers.play"));
});

test("reconnect penceresi sinirlari uygulanir", () => {
  assert.ok(validate(merge(defaultConfig(), { timers: { reconnect: 5000 } }))
    .some((i) => i.path === "timers.reconnect"));
  assert.ok(validate(merge(defaultConfig(), { timers: { reconnect: 400000 } }))
    .some((i) => i.path === "timers.reconnect"));
});

test("tum varyantlar kapatilamaz", () => {
  const c = merge(defaultConfig(), {
    enabled: { esli: false, ihaleli: false, koz: false, gonul: false },
  });
  assert.ok(validate(c).some((i) => i.path === "enabled"));
});

test("forceLastBidder kapatilirsa uyari verilir", () => {
  const c = merge(defaultConfig(), { variants: { esli: { forceLastBidder: false } } });
  assert.ok(validate(c).some((i) => i.path === "variants.esli.forceLastBidder"));
});

test("kozsuz varyantta koz zorunlulugu anlamsiz sayilir", () => {
  const c = merge(defaultConfig(), { variants: { gonul: { mustPlayTrumpWhenVoid: true } } });
  assert.ok(validate(c).some((i) => i.path === "variants.gonul.mustPlayTrumpWhenVoid"));
});

test("negatif bahis reddedilir", () => {
  const c = merge(defaultConfig(), { stakes: { esli: -5 } });
  assert.ok(validate(c).some((i) => i.path === "stakes.esli"));
});

test("bos veya bozuk govde ayari bozmaz", () => {
  const c = defaultConfig();
  assert.deepEqual(validate(merge(c, null)), []);
  assert.deepEqual(validate(merge(c, "merhaba")), []);
  assert.deepEqual(validate(merge(c, { variants: { yok: { minBid: 3 } } })), []);
});

// ------------------------------------------------------------- oyunlar

test("varsayilan oyun listesi gecerlidir", () => {
  const c = defaultConfig();
  assert.ok(c.games.length >= 4);
  assert.equal(c.games.find((g) => g.id === "batak")?.status, "live");
  assert.deepEqual(validate(c), []);
});

test("motoru olmayan oyun 'live' yapilamaz", () => {
  const c = merge(defaultConfig(), {
    games: [
      { id: "batak", label: "Batak", status: "live" },
      { id: "tavla", label: "Tavla", status: "live" },
    ],
  });
  const issues = validate(c);
  assert.ok(issues.some((i) => i.path === "games.tavla.status"),
    "motoru olmayan oyun acildi");
});

test("tum oyunlar kapatilamaz", () => {
  const c = merge(defaultConfig(), {
    games: [{ id: "batak", label: "Batak", status: "soon" }],
  });
  assert.ok(validate(c).some((i) => i.path === "games"));
});

test("gecersiz durum 'soon' sayilir", () => {
  const c = merge(defaultConfig(), {
    games: [{ id: "batak", label: "Batak", status: "hacked" }],
  });
  assert.equal(c.games[0].status, "soon");
});

test("oyun kimligi dogrulanir", () => {
  const c = merge(defaultConfig(), {
    games: [
      { id: "batak", label: "Batak", status: "live" },
      { id: "KÖTÜ ID", label: "X", status: "soon" },
    ],
  });
  // merge kucuk harfe cevirir; gecersiz karakter dogrulamada yakalanir
  assert.ok(validate(c).some((i) => i.path.startsWith("games.")));
});
