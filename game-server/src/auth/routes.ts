import type { IncomingMessage, ServerResponse } from "node:http";
import type { PlayerService } from "./players.js";
import type { LocalWallet } from "../wallet/local.js";

/**
 * Kayit, giris, profil ve bonus uclari.
 *
 * Yenileme bileti HttpOnly cerezde durur: tarayicidaki JavaScript onu
 * okuyamaz, dolayisiyla XSS ile calinamaz. Erisim bileti kisa omurlu
 * oldugu icin bellekte tutulur.
 */

export interface AuthRoutesDeps {
  players: PlayerService;
  wallet: LocalWallet;
  /** Salon listesi ve canlilik. Istemci giris sonrasi gosterir. */
  salonlar(): Array<{ id: string; label: string; players: number; waiting: number }>;
  /** Oyun listesi. "soon" olanlar da doner; istemci yakinda diye gosterir. */
  oyunlar(): Array<{ id: string; label: string; blurb: string; status: string; players: number }>;
  /** Gunluk bonus miktari ve iflas tabani. */
  bonus: { amount: number; floor: number };
  secure: boolean;   // https ise cerez Secure isaretli
}

const json = (res: ServerResponse, status: number, body: unknown, cookies?: string[]) => {
  const head: Record<string, string | string[]> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (cookies && cookies.length) head["set-cookie"] = cookies;
  res.writeHead(status, head);
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage, limit = 8 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("govde cok buyuk");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

const cookieOf = (req: IncomingMessage, name: string): string | null => {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return null;
};

const REFRESH_COOKIE = "oyun_yenileme";

function setRefresh(token: string, secure: boolean): string {
  const bits = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${30 * 24 * 3600}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}
const clearRefresh = (secure: boolean): string =>
  `${REFRESH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

const ipOf = (req: IncomingMessage): string | undefined =>
  (req.headers["x-real-ip"] as string) || req.socket.remoteAddress || undefined;

/** Authorization: Bearer <token> */
async function playerFrom(req: IncomingMessage, d: AuthRoutesDeps): Promise<string | null> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  try {
    return (await d.players.verifyAccess(h.slice(7).trim())).userId;
  } catch {
    return null;
  }
}

export async function handleAuth(
  req: IncomingMessage, res: ServerResponse, d: AuthRoutesDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const p = url.pathname;
  if (!p.startsWith("/api/")) return false;

  const meta = { ip: ipOf(req), ua: req.headers["user-agent"] as string | undefined };

  try {
    // --- kayit ---
    if (p === "/api/kayit" && req.method === "POST") {
      const b = await readJson(req);
      const r = await d.players.register(String(b.username ?? ""), String(b.password ?? ""), meta);
      if (!r.ok) {
        json(res, r.code === "TAKEN" ? 409 : 422, { code: r.code, message: r.message, issues: r.issues });
        return true;
      }
      json(res, 201, {
        player: r.player, accessToken: r.accessToken, expiresIn: r.expiresIn,
      }, [setRefresh(r.refreshToken, d.secure)]);
      return true;
    }

    // --- giris ---
    if (p === "/api/giris" && req.method === "POST") {
      const b = await readJson(req);
      const r = await d.players.login(String(b.username ?? ""), String(b.password ?? ""), meta);
      if (!r.ok) {
        const status = r.code === "LOCKED" ? 429 : r.code === "SUSPENDED" ? 403 : 401;
        json(res, status, { code: r.code, message: r.message });
        return true;
      }
      json(res, 200, {
        player: r.player, accessToken: r.accessToken, expiresIn: r.expiresIn,
      }, [setRefresh(r.refreshToken, d.secure)]);
      return true;
    }

    // --- bilet yenileme ---
    if (p === "/api/yenile" && req.method === "POST") {
      const token = cookieOf(req, REFRESH_COOKIE);
      if (!token) { json(res, 401, { code: "NO_SESSION", message: "Oturum yok." }); return true; }
      const r = await d.players.refresh(token, meta);
      if (!r.ok) {
        json(res, 401, { code: r.code, message: r.message }, [clearRefresh(d.secure)]);
        return true;
      }
      json(res, 200, {
        player: r.player, accessToken: r.accessToken, expiresIn: r.expiresIn,
      }, [setRefresh(r.refreshToken, d.secure)]);
      return true;
    }

    // --- cikis ---
    if (p === "/api/cikis" && req.method === "POST") {
      const token = cookieOf(req, REFRESH_COOKIE);
      if (token) await d.players.logout(token);
      json(res, 200, { ok: true }, [clearRefresh(d.secure)]);
      return true;
    }

    // --- profil ---
    if (p === "/api/ben" && req.method === "GET") {
      const id = await playerFrom(req, d);
      if (!id) { json(res, 401, { code: "UNAUTHORIZED" }); return true; }
      const me = await d.players.profile(id);
      if (!me) { json(res, 404, { code: "NOT_FOUND" }); return true; }
      json(res, 200, me);
      return true;
    }

    // --- oyunlar ---
    if (p === "/api/oyunlar" && req.method === "GET") {
      json(res, 200, d.oyunlar());
      return true;
    }

    // --- salonlar ---
    if (p === "/api/salonlar" && req.method === "GET") {
      json(res, 200, d.salonlar());
      return true;
    }

    // --- gunluk bonus ---
    if (p === "/api/bonus" && req.method === "POST") {
      const id = await playerFrom(req, d);
      if (!id) { json(res, 401, { code: "UNAUTHORIZED" }); return true; }
      const r = await d.wallet.claimDailyBonus(id, d.bonus.amount, d.bonus.floor);
      if (!r.ok) {
        json(res, 409, {
          code: "TOO_SOON",
          message: "Gunluk bonusu aldiniz. Daha sonra tekrar deneyin.",
          nextAt: r.nextAt, balance: r.balance,
        });
        return true;
      }
      json(res, 200, { amount: r.amount, balance: r.balance });
      return true;
    }

    json(res, 404, { code: "NOT_FOUND" });
    return true;
  } catch (err) {
    json(res, 400, { code: "BAD_REQUEST", message: (err as Error).message });
    return true;
  }
}

/** WebSocket el sikismasinda kullanilir. */
export { playerFrom };
