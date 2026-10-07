import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Redis } from "ioredis";

import { EventStore } from "./effects/persist.js";
import { LocalWallet } from "./wallet/local.js";
import { PlayerService } from "./auth/players.js";
import { handleAuth } from "./auth/routes.js";
import { TableRegistry } from "./tables/registry.js";
import { ConfigStore, basicAuthAdmin, handleAdmin } from "./admin/routes.js";
import { attachWebSocket } from "./ws/server.js";

const here = dirname(fileURLToPath(import.meta.url));

function env(k: string, fallback?: string): string {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Eksik ortam degiskeni: ${k}`);
  return v;
}
const num = (k: string, d: number) => Number(env(k, String(d)));

const log = (level: "info" | "warn" | "error", msg: string, meta?: unknown): void => {
  const line = { t: new Date().toISOString(), level, msg, ...(meta ? { meta } : {}) };
  console[level === "error" ? "error" : "log"](JSON.stringify(line));
};

// ----------------------------------------------------------- bagimliliklar

const pool = new pg.Pool({
  host: env("PGHOST", "postgres"),
  database: env("PGDATABASE", "oyun"),
  user: env("PGUSER", "oyun"),
  password: env("PGPASSWORD", ""),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
pool.on("error", (e: Error) => log("error", "pg havuz hatasi", { e: e.message }));

const redis = new Redis(env("REDIS_URL", "redis://redis:6379"), {
  maxRetriesPerRequest: 3,
});
redis.on("error", (e: Error) => log("error", "redis hatasi", { e: e.message }));

const store = new EventStore(pool);
const config = new ConfigStore(pool);
const wallet = new LocalWallet(pool);

const players = new PlayerService(pool, wallet, {
  secret: env("SESSION_SECRET"),
  signupGift: num("SIGNUP_GIFT", 5000),
});

/**
 * Masa yayini. Reverb'in yerini aliyor: oyun artik bagimsiz bir urun,
 * masa olaylari kendi WebSocket'imizden gidiyor. Olaylar zaten her koltuga
 * `state` olarak ulasiyor; burasi seyirci ve sohbet icin ayrilmis durumda.
 */
const broadcast = {
  async publish(_channel: string, _event: string, _data: unknown): Promise<boolean> {
    return true;
  },
};

// ----------------------------------------------------------- masa kaydi

/** Baglanti kurulana kadar gorunum gonderimi bos gecer. */
let sendToSeat: (tableId: string, seat: 0 | 1 | 2 | 3, payload: unknown) => void =
  () => { /* ws hazir degil */ };

const registry = new TableRegistry(
  { wallet: wallet as never, reverb: broadcast as never, store, log,
    sendToSeat: (t, s, p) => sendToSeat(t, s, p) },
  () => config.current,
);

// Biten masalari bellekten dus.
const sweeper = setInterval(() => {
  const n = registry.sweep();
  if (n > 0) log("info", `${n} masa temizlendi`);
  void players.sweep().catch(() => {});
}, 60_000);
sweeper.unref();

// ----------------------------------------------------------- http

let panelHtml = "";
let clientHtml = "";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    const out = { pg: false, redis: false };
    try { await pool.query("SELECT 1"); out.pg = true; } catch { /* false kalir */ }
    try { out.redis = (await redis.ping()) === "PONG"; } catch { /* false kalir */ }
    const ok = out.pg && out.redis;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: ok ? "ok" : "degraded",
      stores: out,
      tables: registry.list().length,
      config: config.isLoaded,
    }));
    return;
  }

  if (await handleAuth(req, res, {
    players, wallet,
    // Oyun listesi: "off" olanlar gizlenir, "soon" olanlar yakinda diye gorunur.
    oyunlar: () => {
      const live = registry.list();
      return (config.current.games ?? [])
        .filter((g) => g.status !== "off")
        .map((g) => ({
          id: g.id, label: g.label, blurb: g.blurb, status: g.status,
          // Su an yalnizca batak masasi var; digerlerinde sayac sifir kalir.
          players: g.id === "batak"
            ? live.reduce((n, t) => n + t.players, 0)
            : 0,
        }));
    },
    // Salon listesi: ayardaki acik salonlar + canli oyuncu sayilari.
    salonlar: () => {
      const stats = registry.regionStats();
      return (config.current.regions ?? [])
        .filter((r) => r.enabled)
        .map((r) => ({
          id: r.id, label: r.label,
          players: stats[r.id]?.players ?? 0,
          waiting: stats[r.id]?.waiting ?? 0,
        }))
        // Kalabalik salon uste: insanlar insana gider, havuz kendiliginden
        // toplanir.
        .sort((a, b) => b.players - a.players || a.label.localeCompare(b.label, "tr"));
    },
    bonus: { amount: num("DAILY_BONUS", 1000), floor: num("BANKRUPT_FLOOR", 500) },
    secure: env("COOKIE_SECURE", "1") === "1",
  })) return;

  if (await handleAdmin(req, res, {
    config, registry, adminIdOf: basicAuthAdmin, panelHtml,
  })) return;

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(clientHtml);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const wss = attachWebSocket(server, {
  registry, store,
  verifyToken: (t) => players.verifyAccess(t),
  log,
});
sendToSeat = (wss as any).sendToSeat;

// ----------------------------------------------------------- acilis

async function boot(): Promise<void> {
  const read = (rel: string, fb: string) =>
    readFile(join(here, "..", rel), "utf8").catch(() => fb);
  panelHtml = await read("admin/index.html",
    "<!doctype html><title>Panel</title><p>admin/index.html eksik.");
  clientHtml = await read("client/index.html",
    "<!doctype html><title>Oyun</title><p>client/index.html eksik.");

  await config.load();
  log("info", "ayar yuklendi", {
    acik: Object.entries(config.current.enabled)
      .filter(([, v]) => v).map(([k]) => k),
  });

  const port = num("PORT", 3000);
  server.listen(port, "0.0.0.0", () => log("info", `${port} portunda dinleniyor`));
}

boot().catch((e) => {
  log("error", "acilis basarisiz", { e: String(e) });
  process.exit(1);
});

// ----------------------------------------------------------- kapanis

let closing = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    log("info", `${sig} alindi, kapaniyor`);

    // Oynanan masalara haber ver: el ortasinda kesme.
    for (const ws of wss.clients) {
      try { ws.close(1012, "server_restarting"); } catch { /* yoksay */ }
    }
    server.close(async () => {
      await Promise.allSettled([pool.end(), redis.quit()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}

process.on("unhandledRejection", (r) =>
  log("error", "yakalanmamis promise reddi", { r: String(r) }));
