import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  type RuntimeConfig, defaultConfig, merge, validate,
} from "@muhabbetly/batak-engine";
import type { TableRegistry } from "../tables/registry.js";

/**
 * Ayar deposu + yonetim uclari.
 *
 * Ayar tek satirlik bir tabloda JSONB olarak durur. Bellekte onbellege
 * alinir; yazinca yenilenir. Masa kurulurken ayarin KOPYASI masaya gider,
 * boylece panelden kural degisse bile oynanan masa etkilenmez.
 */

export class ConfigStore {
  private cache: RuntimeConfig = defaultConfig();
  private loaded = false;

  constructor(private pool: Pool) {}

  get current(): RuntimeConfig { return this.cache; }

  async load(): Promise<RuntimeConfig> {
    const { rows } = await this.pool.query<{ value: RuntimeConfig }>(
      `SELECT value FROM runtime_config WHERE id = 1`,
    );
    if (rows.length === 0) {
      await this.pool.query(
        `INSERT INTO runtime_config (id, value) VALUES (1, $1)
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(defaultConfig())],
      );
      this.cache = defaultConfig();
    } else {
      // Varsayilanla birlestir: yeni alan eklendiginde eski kayit bozulmasin.
      this.cache = merge(defaultConfig(), rows[0].value);
      this.cache.updatedAt = (rows[0].value as any).updatedAt ?? null;
      this.cache.updatedBy = (rows[0].value as any).updatedBy ?? null;
    }
    this.loaded = true;
    return this.cache;
  }

  async save(next: RuntimeConfig, by: string): Promise<RuntimeConfig> {
    const value: RuntimeConfig = {
      ...next, updatedAt: new Date().toISOString(), updatedBy: by,
    };
    await this.pool.query(
      `INSERT INTO runtime_config (id, value) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(value)],
    );
    this.cache = value;
    return value;
  }

  get isLoaded(): boolean { return this.loaded; }
}

// --------------------------------------------------------------- uclar

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(s);
};

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("govde cok buyuk");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface AdminDeps {
  config: ConfigStore;
  registry: TableRegistry;
  /**
   * Istegi yapanin admin kimligi. null = yetkisiz.
   * Yetkiyi BU SUNUCU dogrulamaz; Caddy basic auth veya platform JWT'si
   * onunde durur ve kimligi basliga yazar.
   */
  adminIdOf(req: IncomingMessage): string | null;
  /** Panelin index.html dosyasinin icerigi. */
  panelHtml: string;
}

export async function handleAdmin(
  req: IncomingMessage, res: ServerResponse, d: AdminDeps,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (!url.pathname.startsWith("/admin")) return false;

  const admin = d.adminIdOf(req);
  if (!admin) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }

  // Panelin kendisi
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(d.panelHtml);
    return true;
  }

  if (url.pathname === "/admin/api/config" && req.method === "GET") {
    json(res, 200, d.config.current);
    return true;
  }

  if (url.pathname === "/admin/api/config" && req.method === "PUT") {
    let patch: unknown;
    try {
      patch = JSON.parse(await readBody(req));
    } catch (e) {
      json(res, 400, { error: "gecersiz govde" });
      return true;
    }
    const next = merge(d.config.current, patch);
    const issues = validate(next);
    if (issues.length > 0) {
      json(res, 422, { issues });
      return true;
    }
    const saved = await d.config.save(next, admin);
    json(res, 200, saved);
    return true;
  }

  if (url.pathname === "/admin/api/tables" && req.method === "GET") {
    json(res, 200, d.registry.list());
    return true;
  }

  json(res, 404, { error: "not_found" });
  return true;
}

/**
 * Caddy basic auth kullaniyorsaniz kimlik `Authorization` basligindadir.
 * Platform JWT'si kullaniyorsaniz bunu degistirin.
 */
export function basicAuthAdmin(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Basic ")) return null;
  try {
    const [user] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
    return user || null;
  } catch {
    return null;
  }
}
