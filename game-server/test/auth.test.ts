import test from "node:test";
import assert from "node:assert/strict";

import {
  hashPassword, normalizeUsername, validatePassword,
  validateUsername, verifyPassword,
} from "../src/auth/password.js";

// ------------------------------------------------------------- parola

test("dogru parola dogrulanir", async () => {
  const h = await hashPassword("KartMasasi2026");
  assert.equal(await verifyPassword("KartMasasi2026", h), true);
});

test("yanlis parola reddedilir", async () => {
  const h = await hashPassword("KartMasasi2026");
  assert.equal(await verifyPassword("KartMasasi2027", h), false);
});

test("ayni parola her seferinde farkli ozet uretir (tuz)", async () => {
  const a = await hashPassword("ayniParola123");
  const b = await hashPassword("ayniParola123");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("ayniParola123", a), true);
  assert.equal(await verifyPassword("ayniParola123", b), true);
});

test("ozet parolayi acik tasimaz", async () => {
  const h = await hashPassword("gizliParola99");
  assert.ok(!h.includes("gizliParola99"));
  assert.ok(h.startsWith("scrypt$"));
});

test("bozuk ozet cokertmez", async () => {
  for (const bad of ["", "scrypt$", "duz-metin", "scrypt$a$b$c$d$e", "$$$$$"]) {
    assert.equal(await verifyPassword("x", bad), false, `cokerdi: ${bad}`);
  }
});

test("Turkce karakterli parola calisir", async () => {
  const h = await hashPassword("çöğüşİıParola1");
  assert.equal(await verifyPassword("çöğüşİıParola1", h), true);
});

test("bos parola dogrulanamaz", async () => {
  const h = await hashPassword("gercekParola1");
  assert.equal(await verifyPassword("", h), false);
});

// ------------------------------------------------------------- kullanici adi

test("gecerli kullanici adlari kabul edilir", () => {
  for (const u of ["ahmet", "Zeynep_34", "kart.ustasi", "Çağrı", "oyuncu1"]) {
    assert.deepEqual(validateUsername(u), [], `reddedildi: ${u}`);
  }
});

test("cok kisa veya cok uzun ad reddedilir", () => {
  assert.ok(validateUsername("ab").length > 0);
  assert.ok(validateUsername("a".repeat(21)).length > 0);
});

test("bosluk ve ozel karakter reddedilir", () => {
  for (const u of ["ad soyad", "kullanıcı!", "a@b", "<script>", "emoji😀"]) {
    assert.ok(validateUsername(u).length > 0, `kabul edildi: ${u}`);
  }
});

test("nokta ve alt tire basta/sonda veya art arda olamaz", () => {
  for (const u of [".ahmet", "ahmet.", "_ahmet", "ah..met", "ah__met"]) {
    assert.ok(validateUsername(u).length > 0, `kabul edildi: ${u}`);
  }
});

test("ayrilmis adlar reddedilir", () => {
  for (const u of ["admin", "Admin", "YONETICI", "destek", "bot"]) {
    assert.ok(validateUsername(u).length > 0, `kabul edildi: ${u}`);
  }
});

test("Turkce I harfleri taklit acigi birakmaz", () => {
  // "ADMIN" ile "admin" AYNI hesaba dusmeli; yoksa destek taklidi mumkun olur.
  assert.equal(normalizeUsername("ADMIN"), normalizeUsername("admin"));
  assert.equal(normalizeUsername("IZMIR"), "izmir");
  assert.equal(normalizeUsername("İstanbul"), "istanbul");
  assert.equal(normalizeUsername("admın"), "admin");
});

test("buyuk/kucuk harf ayni hesaba isaret eder", () => {
  assert.equal(normalizeUsername("Ahmet"), normalizeUsername("AHMET"));
  assert.equal(normalizeUsername("  ahmet  "), "ahmet");
});

// ------------------------------------------------------------- parola kurallari

test("kisa parola reddedilir", () => {
  assert.ok(validatePassword("1234567").length > 0);
  assert.deepEqual(validatePassword("12345678abc"), []);
});

test("yaygin parolalar reddedilir", () => {
  for (const pw of ["12345678", "password", "sifre123", "qwerty", "PASSWORD"]) {
    assert.ok(validatePassword(pw).length > 0, `kabul edildi: ${pw}`);
  }
});

test("parola kullanici adini icermemeli", () => {
  assert.ok(validatePassword("ahmetahmet", "ahmet").length > 0);
  assert.deepEqual(validatePassword("bambaskaBirsey9", "ahmet"), []);
});

test("asiri uzun parola reddedilir", () => {
  assert.ok(validatePassword("a".repeat(201)).length > 0);
});
