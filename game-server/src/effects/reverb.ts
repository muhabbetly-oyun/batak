import { createHash, createHmac } from "node:crypto";

/**
 * Reverb yayinci.
 *
 * Masa ici sohbet icin YENI bir sistem yazilmiyor: muhabbetly'de zaten
 * calisan Reverb kullaniliyor. Moderasyon, ban ve mute mevcut sistemde
 * kaliyor; oyun sunucusu yalnizca `table.{id}` kanalina olay basiyor.
 *
 * Reverb, Pusher protokolunu konusur. Imza Pusher'in HTTP API semasidir.
 */

export interface ReverbConfig {
  host: string;      // 10.8.0.1 (tunel)
  port: number;      // 8080
  appId: string;
  key: string;
  secret: string;
  timeoutMs: number;
}

export class ReverbClient {
  constructor(private cfg: ReverbConfig) {}

  /** Tek kanala olay basar. Basarisizlik oyunu durdurmaz; log'lanir. */
  async publish(channel: string, event: string, data: unknown): Promise<boolean> {
    const body = JSON.stringify({
      name: event,
      channel,
      data: JSON.stringify(data),
    });

    const bodyMd5 = createHash("md5").update(body).digest("hex");
    const ts = Math.floor(Date.now() / 1000);
    const path = `/apps/${this.cfg.appId}/events`;
    const query =
      `auth_key=${this.cfg.key}&auth_timestamp=${ts}` +
      `&auth_version=1.0&body_md5=${bodyMd5}`;
    const sig = createHmac("sha256", this.cfg.secret)
      .update(`POST\n${path}\n${query}`)
      .digest("hex");

    const url =
      `http://${this.cfg.host}:${this.cfg.port}${path}?${query}&auth_signature=${sig}`;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json" },
        body,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Oyuncuya ozel veri Reverb'e GITMEZ. Kanal herkese acik oldugu icin
 * yalnizca masa geneli olaylar basilir; kartlar her oyuncunun kendi
 * WebSocket baglantisindan gider.
 */
const PRIVATE_EVENTS = new Set(["cards_dealt"]);

export function publicEvents<T extends { type: string }>(events: T[]): T[] {
  return events.filter((e) => !PRIVATE_EVENTS.has(e.type));
}
