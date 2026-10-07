import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Seat } from "@muhabbetly/batak-engine";
import type { TableRegistry } from "../tables/registry.js";
import type { EventStore } from "../effects/persist.js";
import { RateLimiter, parse, toMove } from "./protocol.js";

/**
 * WebSocket sunucusu.
 *
 * Kural mantigi YOK. Burasi yalnizca: kimligi dogrula, mesaji ayristir,
 * dogru masaya yonlendir, gorunumu geri gonder.
 */

export interface Session extends WebSocket {
  userId?: string;
  username?: string;
  alive?: boolean;
  ip?: string;
}

export interface WsDeps {
  registry: TableRegistry;
  store: EventStore;
  verifyToken(token: string): Promise<{ userId: string; username: string }>;
  log(level: "info" | "warn" | "error", msg: string, meta?: unknown): void;
}

export function attachWebSocket(server: Server, d: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const limiter = new RateLimiter(20, 10_000);
  /** userId -> acik baglanti. Bir oyuncunun tek baglantisi olur. */
  const live = new Map<string, Session>();

  server.on("upgrade", async (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) { socket.destroy(); return; }

    // Token query string'de DEGIL, alt protokolde tasinir: query string
    // proxy loglarina duser.
    const token = (req.headers["sec-websocket-protocol"] as string | undefined)
      ?.split(",")[1]?.trim();
    if (!token) { reject(socket, 401); return; }

    let who: { userId: string; username: string };
    try {
      who = await d.verifyToken(token);
    } catch (err) {
      d.log("warn", "token reddedildi", { err: String(err) });
      reject(socket, 401);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = ws as Session;
      s.userId = who.userId;
      s.username = who.username;
      s.ip = (req.headers["x-real-ip"] as string) ?? req.socket.remoteAddress ?? null ?? undefined;

      // Ayni oyuncunun eski baglantisi varsa kapat: tek baglanti kurali
      // coklu sekme ile ayni masada iki kez oynamayi engeller.
      const old = live.get(who.userId);
      if (old && old !== s) { try { old.close(4001, "baska_cihaz"); } catch { /* yoksay */ } }
      live.set(who.userId, s);

      // Anlasmali oyun tespiti icin ham veri. Algoritma sonra yazilir ama
      // veri BUGUN birikmeye baslamali.
      void d.store.logFingerprint({
        userId: who.userId,
        tableId: d.registry.runnerFor(who.userId)?.id ?? null,
        ip: s.ip ?? null,
        userAgent: (req.headers["user-agent"] as string) ?? null,
        deviceHash: null,
      }).catch(() => {});

      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", async (ws: Session) => {
    ws.alive = true;
    ws.on("pong", () => { ws.alive = true; });

    send(ws, { type: "hello", userId: ws.userId, serverTime: Date.now() });

    // Kopan oyuncu geri donduyse masasina otur.
    const back = await d.registry.reconnect(ws.userId!);
    if (back) {
      const seat = d.registry.seatOf(ws.userId!);
      send(ws, { type: "rejoined", tableId: back.id, seat });
      send(ws, { type: "state", view: back.viewFor(seat) });
    }

    ws.on("message", (raw) => { void onMessage(ws, raw.toString()); });

    ws.on("close", () => {
      if (!ws.userId) return;
      if (live.get(ws.userId) === ws) live.delete(ws.userId);
      limiter.forget(ws.userId);
      // Masadan DUSURMEZ: 90 saniyelik yeniden baglanma penceresi isler.
      void d.registry.disconnect(ws.userId).catch(() => {});
    });

    ws.on("error", (err) => d.log("warn", "soket hatasi", { err: err.message }));
  });

  async function onMessage(ws: Session, raw: string): Promise<void> {
    const uid = ws.userId!;
    if (!limiter.allow(uid)) {
      send(ws, { type: "error", code: "RATE_LIMIT", message: "Cok hizli." });
      return;
    }

    const p = parse(raw);
    if (!p.ok) { send(ws, { type: "error", code: p.code, message: p.message }); return; }
    const msg = p.msg;

    if (msg.type === "ping") { send(ws, { type: "pong", t: Date.now() }); return; }

    if (msg.type === "join") {
      const r = await d.registry.join({
        userId: uid, username: ws.username!,
        variantId: msg.variantId, practice: msg.practice,
        roomId: msg.roomId, tableId: msg.tableId,
      });
      if (!r.ok) { send(ws, { type: "error", code: r.code, message: r.message }); return; }
      send(ws, { type: "joined", tableId: r.tableId, seat: r.seat });
      return;
    }

    if (msg.type === "leave") {
      await d.registry.leave(uid);
      send(ws, { type: "left" });
      return;
    }

    // Hamleler
    const runner = d.registry.runnerFor(uid);
    const seat = d.registry.seatOf(uid);
    if (!runner || seat === null) {
      send(ws, { type: "error", code: "NOT_AT_TABLE", message: "Masada degilsiniz." });
      return;
    }

    // KOLTUK SUNUCUDAN GELIR. Istemci koltuk gondermeye calissa yok sayilir.
    const move = toMove(msg, seat as Seat);
    if (!move) {
      send(ws, { type: "error", code: "BAD_MOVE", message: "Gecersiz hamle." });
      return;
    }

    const res = await runner.enqueue({ type: "move", seat: seat as Seat, move, now: Date.now() });
    if (res.error) {
      send(ws, { type: "error", code: res.error.code, message: res.error.message });
    }
    // Basarili hamlede gorunum runner tarafindan zaten gonderilir.
  }

  /** Koltuga gorunum gonderir. TableRunner bunu cagirir. */
  function sendToSeat(tableId: string, seat: Seat, payload: unknown): void {
    const r = d.registry.get(tableId);
    const uid = r?.snapshot.seats[seat].userId;
    if (!uid) return;
    const ws = live.get(uid);
    if (ws) send(ws, payload);
  }

  // Olu baglantilari temizle. Mobilde sik gorulur.
  const beat = setInterval(() => {
    for (const ws of wss.clients as Set<Session>) {
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 30_000);
  if (typeof beat.unref === "function") beat.unref();
  wss.on("close", () => clearInterval(beat));

  (wss as any).sendToSeat = sendToSeat;
  return wss;
}

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function reject(socket: { write(s: string): void; destroy(): void }, status: number): void {
  const text = status === 401 ? "Unauthorized" : "Bad Request";
  socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
  socket.destroy();
}
