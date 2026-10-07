import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Redis } from "ioredis";
import { importSPKI, jwtVerify, type KeyLike } from "jose";

import { EventStore } from "./effects/persist.js";
import { ReverbClient } from "./effects/reverb.js";
import { WalletClient } from "./effects/wallet.js";
import { TableRegistry } from "./tables/registry.js";
import { ConfigStore, basicAuthAdmin, handleAdmin } from "./admin/routes.js";
import { attachWebSocket } from "./ws/server.js";

const here = dirname(fileURLToPath(import.meta.url));

function env(k: string, fallback?: string): string {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Eksik ortam degiskeni: ${k}`);
  return v;
}

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

const wallet = new WalletClient({
  baseUrl: env("PLATFORM_BASE_URL", "http://10.8.0.1"),
  secret: env("INTERNAL_API_SECRET"),
  timeoutMs: 4_000,
});

const reverb = new ReverbClient({
  host: env("REVERB_HOST", "10.8.0.1"),
  port: Number(env("REVERB_PORT", "8080")),
  appId: env("REVERB_APP_ID"),
  key: env("REVERB_APP_KEY"),
  secret: env("REVERB_APP_SECRET"),
  timeoutMs: 3_000,
});

// ----------------------------------------------------------- kimlik

let jwtKey: KeyLike | null = null;
async function publicKey(): Promise<KeyLike> {
  if (jwtKey) return jwtKey;
  const pem = env("JWT_PUBLIC_KEY", "").replace(/\\n/g, "\n");
  if (!pem) throw new Error("JWT_PUBLIC_KEY tanimli degil");
  jwtKey = await importSPKI(pem, "RS256");
  return jwtKey;
}

async function verifyToken(token: string): Promise<{ userId: string; username: string }> {
  const { payload } = await jwtVerify(token, await publicKey(), {
    issuer: env("JWT_ISSUER", "muhabbetly"),
    audience: env("JWT_AUDIENCE", "game"),
    algorithms: ["RS256"],
    clockTolerance: 30,
  });
  const userId = payload.sub;
  if (typeof userId !== "string" || !userId) throw new Error("Token icinde sub yok");
  return {
    userId,
    username: typeof payload.username === "string" ? payload.username : userId,
  };
}

// ----------------------------------------------------------- masa kaydi

/** Baglanti kurulana kadar gorunum gonderimi bos gecer. */
let sendToSeat: (tableId: string, seat: 0 | 1 | 2 | 3, payload: unknown) => void =
  () => { /* ws hazir degil */ };

const registry = new TableRegistry(
  {
    wallet, reverb, store, log,
    sendToSeat: (t, s, p) => sendToSeat(t, s, p),
  },
  () => config.current,
);

// Biten masalari bellekten dus.
const sweeper = setInterval(() => {
  const n = registry.sweep();
  if (n > 0) log("info", `${n} masa temizlendi`);
}, 60_000);
sweeper.unref();

// ----------------------------------------------------------- http

let panelHtml = "";

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

  if (await handleAdmin(req, res, {
    config, registry, adminIdOf: basicAuthAdmin, panelHtml,
  })) return;

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

const wss = attachWebSocket(server, { registry, store, verifyToken, log });
sendToSeat = (wss as any).sendToSeat;

// ----------------------------------------------------------- acilis

async function boot(): Promise<void> {
  panelHtml = await readFile(join(here, "..", "admin", "index.html"), "utf8")
    .catch(() => "<!doctype html><title>Panel bulunamadi</title><p>admin/index.html eksik.");

  await config.load();
  log("info", "ayar yuklendi", {
    acik: Object.entries(config.current.enabled)
      .filter(([, v]) => v).map(([k]) => k),
  });

  const port = Number(env("PORT", "3000"));
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
