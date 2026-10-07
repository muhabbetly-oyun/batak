import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  pw: string | Buffer, salt: Buffer, len: number, opts: Record<string, number>,
) => Promise<Buffer>;

/**
 * Parola ozetleme — scrypt, Node'un kendi kriptosunda. Harici bagimlilik yok.
 *
 * Parametreler OWASP'in scrypt onerisine yakin: N=2^16, r=8, p=1.
 * Ozet formati:  scrypt$N$r$p$<tuz-b64>$<ozet-b64>
 * Parametreler ozetin icinde durur, boylece ileride maliyeti artirsak bile
 * eski parolalar dogrulanmaya devam eder.
 */

const N = 1 << 16;   // 65536
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEYLEN, {
    N, r: R, p: P, maxmem: MAXMEM,
  });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch { return false; }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
      N: n, r, p, maxmem: 128 * n * r * 2,
    });
  } catch { return false; }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// --------------------------------------------------------------- dogrulama

export interface FieldIssue { field: string; message: string }

/**
 * Kullanici adi kurallari. Turkce karakter SERBEST — oyuncu kendi adiyla
 * oynayabilmeli. Ama gorunurde ayni, aslinda farkli adlari engelliyoruz.
 */
const RESERVED = new Set([
  "admin", "administrator", "yonetici", "sistem", "system", "muhabbetly",
  "destek", "support", "moderator", "bot", "root", "null", "undefined",
]);

/**
 * Hesap anahtari uretir.
 *
 * Turkce'de "I".toLowerCase() -> "ı" olur. Bu, "ADMIN" ile "admin"i FARKLI
 * hesaplar yapardi: biri cikip destek gorevlisi taklidi yapabilirdi.
 * Bu yuzden kucultmenin ardindan karistirilabilir harfleri katlıyoruz.
 *
 * Bedeli: "ışık" ile "işık" ayni anahtara duser, ikisi birden alinamaz.
 * Taklit riskini bu bedele tercih ediyoruz — jeton donen bir oyunda birinin
 * "destek" veya "admın" olmasi, birinin ikinci tercih bir ad secmesinden
 * cok daha pahaliya patlar.
 */
export function normalizeUsername(raw: string): string {
  return raw
    .trim()
    .toLocaleLowerCase("tr-TR")
    .normalize("NFKC")
    .replace(/[ıİI]/g, "i")
    .replace(/[\u0131\u0130]/g, "i");
}

export function validateUsername(raw: string): FieldIssue[] {
  const out: FieldIssue[] = [];
  const u = raw.trim();

  if (u.length < 3) out.push({ field: "username", message: "En az 3 karakter olmali." });
  if (u.length > 20) out.push({ field: "username", message: "En fazla 20 karakter olabilir." });

  // Harf, rakam, alt tire ve nokta. Bosluk ve emoji yok.
  if (!/^[\p{L}\p{N}_.]+$/u.test(u)) {
    out.push({ field: "username", message: "Harf, rakam, alt tire ve nokta kullanabilirsiniz." });
  }
  if (/^[._]|[._]$/.test(u)) {
    out.push({ field: "username", message: "Nokta veya alt tire ile baslayip bitemez." });
  }
  if (/[._]{2}/.test(u)) {
    out.push({ field: "username", message: "Art arda nokta veya alt tire olamaz." });
  }
  if (RESERVED.has(normalizeUsername(u))) {
    out.push({ field: "username", message: "Bu kullanici adi ayrilmis." });
  }
  return out;
}

/** Yaygin parolalar. Kisa bir liste bile en kotu secimleri eler. */
const WEAK = new Set([
  "123456", "1234567", "12345678", "123456789", "1234567890",
  "password", "parola", "sifre", "sifre123", "qwerty", "asdasd",
  "111111", "000000", "abc123", "iloveyou", "admin123", "muhabbetly",
]);

export function validatePassword(pw: string, username?: string): FieldIssue[] {
  const out: FieldIssue[] = [];
  if (pw.length < 8) out.push({ field: "password", message: "En az 8 karakter olmali." });
  if (pw.length > 200) out.push({ field: "password", message: "Cok uzun." });
  if (WEAK.has(pw.toLowerCase())) {
    out.push({ field: "password", message: "Bu parola cok yaygin, baskasini secin." });
  }
  if (username && pw.toLocaleLowerCase("tr-TR").includes(normalizeUsername(username))) {
    out.push({ field: "password", message: "Parola kullanici adinizi icermemeli." });
  }
  return out;
}
