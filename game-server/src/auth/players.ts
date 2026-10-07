import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { SignJWT, jwtVerify } from "jose";
import {
  type FieldIssue, hashPassword, normalizeUsername,
  validatePassword, validateUsername, verifyPassword,
} from "./password.js";
import type { LocalWallet } from "../wallet/local.js";

/**
 * Oyuncu hesaplari.
 *
 * Kimlik artik oyun sunucusunun kendisinde. Muhabbetly canli destek urunu;
 * oyunun kendi oyuncu sistemi var.
 *
 * Iki katmanli bilet:
 *  - Erisim bileti (JWT, 15 dk): her istekte tasinir, veritabanina sorulmaz.
 *  - Yenileme bileti (30 gun): veritabaninda ozeti durur, iptal edilebilir.
 * Boylece calinan bir bilet iptal edilebilirken her WebSocket mesajinda
 * veritabanina gidilmiyor.
 */

export interface Player {
  id: string;
  username: string;
  status: string;
}

export interface AuthOk {
  ok: true;
  player: Player;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
export interface AuthFail {
  ok: false;
  code: "VALIDATION" | "TAKEN" | "BAD_CREDENTIALS" | "LOCKED" | "SUSPENDED";
  message: string;
  issues?: FieldIssue[];
}
export type AuthResult = AuthOk | AuthFail;

const ACCESS_TTL = 15 * 60;              // saniye
const REFRESH_TTL_DAYS = 30;
const MAX_FAILS = 8;                     // 15 dakikada
const FAIL_WINDOW_MIN = 15;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface PlayerServiceOptions {
  /** JWT imzalama sirri. En az 32 bayt. */
  secret: string;
  signupGift: number;
}

export class PlayerService {
  private key: Uint8Array;

  constructor(
    private pool: Pool,
    private wallet: LocalWallet,
    private opts: PlayerServiceOptions,
  ) {
    if (!opts.secret || opts.secret.length < 32) {
      throw new Error("SESSION_SECRET en az 32 karakter olmali");
    }
    this.key = new TextEncoder().encode(opts.secret);
  }

  // ------------------------------------------------------------- kayit

  async register(
    rawUsername: string, password: string, meta: { ip?: string; ua?: string } = {},
  ): Promise<AuthResult> {
    const issues = [
      ...validateUsername(rawUsername),
      ...validatePassword(password, rawUsername),
    ];
    if (issues.length > 0) {
      return { ok: false, code: "VALIDATION", message: "Bilgileri kontrol edin.", issues };
    }

    const username = rawUsername.trim();
    const key = normalizeUsername(username);
    const hash = await hashPassword(password);

    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO players (username_key, username, password_hash)
         VALUES ($1,$2,$3)
         ON CONFLICT (username_key) DO NOTHING
         RETURNING id`,
        [key, username, hash],
      );
      if (rows.length === 0) {
        await c.query("ROLLBACK");
        return {
          ok: false, code: "TAKEN",
          message: "Bu kullanici adi alinmis.",
          issues: [{ field: "username", message: "Bu kullanici adi alinmis." }],
        };
      }
      const id = rows[0].id;
      await c.query(`INSERT INTO wallets (player_id) VALUES ($1)`, [id]);
      await c.query("COMMIT");

      await this.wallet.signupGift(id, this.opts.signupGift);
      return this.issue({ id, username, status: "active" }, meta);
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  // ------------------------------------------------------------- giris

  async login(
    rawUsername: string, password: string, meta: { ip?: string; ua?: string } = {},
  ): Promise<AuthResult> {
    const key = normalizeUsername(rawUsername || "");
    if (!key) {
      return { ok: false, code: "BAD_CREDENTIALS", message: "Kullanici adi veya parola hatali." };
    }

    if (await this.tooManyFails(key, meta.ip)) {
      return {
        ok: false, code: "LOCKED",
        message: "Cok fazla hatali deneme. 15 dakika sonra tekrar deneyin.",
      };
    }

    const { rows } = await this.pool.query<{
      id: string; username: string; password_hash: string;
      status: string; suspended_until: Date | null; suspend_reason: string | null;
    }>(
      `SELECT id, username, password_hash, status, suspended_until, suspend_reason
         FROM players WHERE username_key = $1`,
      [key],
    );

    // Kullanici yoksa da parola dogrulama maliyetini odeyelim: cevap suresi
    // "bu kullanici var mi" bilgisini sizdirmasin.
    const stored = rows.length
      ? rows[0].password_hash
      : "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    const good = await verifyPassword(password, stored);

    if (rows.length === 0 || !good) {
      await this.recordAttempt(key, meta.ip, false);
      return { ok: false, code: "BAD_CREDENTIALS", message: "Kullanici adi veya parola hatali." };
    }

    const p = rows[0];
    if (p.status === "closed") {
      return { ok: false, code: "SUSPENDED", message: "Bu hesap kapatilmis." };
    }
    if (p.status === "suspended" &&
        (!p.suspended_until || new Date(p.suspended_until) > new Date())) {
      return {
        ok: false, code: "SUSPENDED",
        message: p.suspend_reason || "Hesabiniz gecici olarak askiya alindi.",
      };
    }

    await this.recordAttempt(key, meta.ip, true);
    await this.pool.query(`UPDATE players SET last_seen_at = now() WHERE id = $1`, [p.id]);
    return this.issue({ id: p.id, username: p.username, status: p.status }, meta);
  }

  // ------------------------------------------------------------- biletler

  private async issue(
    player: Player, meta: { ip?: string; ua?: string },
  ): Promise<AuthOk> {
    const accessToken = await new SignJWT({ username: player.username })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(player.id)
      .setIssuer("oyun")
      .setAudience("game")
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL}s`)
      .sign(this.key);

    const refreshToken = randomBytes(32).toString("base64url");
    await this.pool.query(
      `INSERT INTO sessions (player_id, token_hash, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval)`,
      [player.id, sha256(refreshToken), meta.ip ?? null,
       (meta.ua ?? "").slice(0, 400) || null, String(REFRESH_TTL_DAYS)],
    );

    return { ok: true, player, accessToken, refreshToken, expiresIn: ACCESS_TTL };
  }

  /** Erisim bileti dogrulama. Veritabanina GITMEZ — her mesajda cagrilabilir. */
  async verifyAccess(token: string): Promise<{ userId: string; username: string }> {
    const { payload } = await jwtVerify(token, this.key, {
      issuer: "oyun", audience: "game", algorithms: ["HS256"], clockTolerance: 30,
    });
    const userId = payload.sub;
    if (typeof userId !== "string" || !userId) throw new Error("Bilet gecersiz");
    return {
      userId,
      username: typeof payload.username === "string" ? payload.username : userId,
    };
  }

  /** Yenileme bileti ile yeni erisim bileti. Eski yenileme bileti doner. */
  async refresh(refreshToken: string, meta: { ip?: string; ua?: string } = {}): Promise<AuthResult> {
    const { rows } = await this.pool.query<{
      id: string; player_id: string; username: string; status: string;
    }>(
      `SELECT s.id, s.player_id, p.username, p.status
         FROM sessions s JOIN players p ON p.id = s.player_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256(refreshToken)],
    );
    if (rows.length === 0) {
      return { ok: false, code: "BAD_CREDENTIALS", message: "Oturum suresi doldu, tekrar girin." };
    }
    if (rows[0].status !== "active") {
      return { ok: false, code: "SUSPENDED", message: "Hesap etkin degil." };
    }

    // Donusumlu bilet: eskisi iptal, yenisi verilir. Calinan bilet bir kez
    // kullanilabilir ve sahibi fark eder.
    await this.pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [rows[0].id]);
    return this.issue(
      { id: rows[0].player_id, username: rows[0].username, status: rows[0].status }, meta,
    );
  }

  async logout(refreshToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1`, [sha256(refreshToken)],
    );
  }

  async logoutEverywhere(playerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE player_id = $1 AND revoked_at IS NULL`, [playerId],
    );
  }

  // ------------------------------------------------------------- koruma

  private async tooManyFails(key: string, ip?: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM login_attempts
        WHERE ok = false
          AND created_at > now() - ($3 || ' minutes')::interval
          AND (username_key = $1 OR ($2::inet IS NOT NULL AND ip = $2::inet))`,
      [key, ip ?? null, String(FAIL_WINDOW_MIN)],
    );
    return Number(rows[0].n) >= MAX_FAILS;
  }

  private async recordAttempt(key: string, ip: string | undefined, ok: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO login_attempts (username_key, ip, ok) VALUES ($1,$2,$3)`,
      [key, ip ?? null, ok],
    ).catch(() => { /* kayit tutulamadi, giris engellenmesin */ });
  }

  /** Eski kayitlari temizler. Gunluk cagrilir. */
  async sweep(): Promise<void> {
    await this.pool.query(`DELETE FROM login_attempts WHERE created_at < now() - interval '7 days'`);
    await this.pool.query(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
  }

  async profile(playerId: string): Promise<(Player & { balance: number; held: number }) | null> {
    const { rows } = await this.pool.query<{
      id: string; username: string; status: string; balance: string; held: string;
    }>(
      `SELECT p.id, p.username, p.status, w.balance, w.held
         FROM players p JOIN wallets w ON w.player_id = p.id
        WHERE p.id = $1`,
      [playerId],
    );
    if (rows.length === 0) return null;
    return {
      id: rows[0].id, username: rows[0].username, status: rows[0].status,
      balance: Number(rows[0].balance), held: Number(rows[0].held),
    };
  }
}
