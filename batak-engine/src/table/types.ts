import type { GameEvent, HandState, Move, Seat } from "../types.js";
import type { VariantConfig } from "../variants.js";
import type { EndCondition } from "../scoring.js";

/** Sureler milisaniye. Panelden degistirilebilir. */
export interface Timers {
  bid: number;
  trump: number;
  play: number;
  handEnd: number;
  /** Kopan oyuncunun yeri ne kadar korunur. */
  reconnect: number;
}

export const DEFAULT_TIMERS: Timers = {
  bid: 20_000,
  trump: 15_000,
  play: 20_000,
  handEnd: 5_000,
  reconnect: 90_000,
};

export interface SeatState {
  userId: string | null;
  username: string | null;
  /** Baglanti kopuk; reconnect penceresi isliyor. */
  disconnected: boolean;
  /** Kopma ani; pencere bundan sayilir. */
  disconnectedAt: number | null;
  /** Bot devraldi. Oyuncu donerse geri alir. */
  bot: boolean;
  /** Bu oturumda kac kez el ortasinda terk etti. */
  abandons: number;
}

export type TablePhase =
  | "waiting"   // koltuklar doluyor
  | "playing"   // el suruyor
  | "handEnd"   // el bitti, sonraki bekleniyor
  | "finished"; // oyun bitti

export interface Deadline {
  at: number;
  seat: Seat;
  kind: "bid" | "trump" | "play" | "handEnd";
}

/**
 * Masanin tum durumu. Serilestirlebilir; tek bir JSON olarak saklanabilir
 * ve kopan node'da yeniden kurulabilir.
 */
export interface TableState {
  tableId: string;
  /**
   * Masa kurulurken ayarin KOPYASI alinir. Panelden ayar degisse bile
   * oynanan masa kendi kurallariyla biter.
   */
  variant: VariantConfig;
  timers: Timers;
  endCondition: EndCondition;
  stake: number;
  roomId: string | null;
  /** Salon kimligi. Ayri havuz degil, eslestirme tercihidir. */
  region: string | null;

  phase: TablePhase;
  seats: SeatState[];
  dealer: Seat;
  handNo: number;
  /** Koltuk basina masa puani. Esli varyantta es koltuklar ayni degeri tasir. */
  scores: number[];
  /** Koltuk basina kac kez battigi — beraberlik bozmak icin. */
  timesSet: number[];

  hand: HandState | null;
  /** El icin uretilen seed. El bitince olaya yazilir. */
  seed: string | null;
  deadline: Deadline | null;
  /** Ust uste iptal edilen el sayisi. 3'te dagitan degisir. */
  consecutiveVoids: number;

  /**
   * Bos koltuklarin bot ile doldurulacagi an. null = doldurma yok.
   *
   * Soguk baslangic sorunu: lansmanda masa dolduracak oyuncu yok, ilk gelen
   * bos masa gorup gider. Alistirma masasinda 30 saniye sonra botlar oturur.
   * YALNIZCA bahissiz masalarda; yoksa bota karsi kazanilan jeton ekonomiye
   * yoktan girer.
   */
  botFillAt: number | null;
  /** Masa bahissiz mi (alistirma). stake === 0 ile ayni, acikca tutulur. */
  practice: boolean;
  /** Bos koltuklar kac saniye sonra bota verilsin. Yalnizca alistirmada. */
  botFillSeconds?: number;
}

export type TableInput =
  | { type: "join"; seat: Seat; userId: string; username: string; now: number }
  | { type: "leave"; seat: Seat; now: number }
  | { type: "move"; seat: Seat; move: Move; now: number }
  | { type: "disconnect"; seat: Seat; now: number }
  | { type: "reconnect"; seat: Seat; now: number }
  /** Zamanlayici. Masa aktoru bunu duzenli cagirir. */
  | { type: "tick"; now: number };

export type TableEvent =
  | GameEvent
  | { type: "seat_taken"; seat: Seat; userId: string; username: string }
  | { type: "seat_left"; seat: Seat; userId: string | null; abandoned: boolean }
  | { type: "player_disconnected"; seat: Seat }
  | { type: "player_reconnected"; seat: Seat }
  | { type: "bot_took_over"; seat: Seat }
  | { type: "bot_released"; seat: Seat }
  | { type: "player_timeout"; seat: Seat; kind: Deadline["kind"] }
  | { type: "table_started" }
  | { type: "hand_voided_redeal"; handNo: number }
  | { type: "table_finished"; scores: number[]; winner: number | null };

/**
 * Yan etkiler. Motor bunlari YAPMAZ, yalnizca ister. Masa aktorunu saran
 * katman cagrilari yapar: cuzdan, yayin, kalici yazim.
 */
export type Effect =
  | { kind: "wallet_hold"; tableId: string; handNo: number; seats: Seat[]; userIds: string[]; amount: number }
  | { kind: "wallet_settle"; tableId: string; handNo: number; userIds: string[]; deltas: number[] }
  | { kind: "wallet_release"; tableId: string; handNo: number; userIds: string[]; amount: number }
  | { kind: "publish"; channel: string; events: TableEvent[] }
  | { kind: "persist_events"; tableId: string; events: TableEvent[] }
  /** Bir sonraki tick ne zaman gerekli — aktor zamanlayiciyi buna gore kurar. */
  | { kind: "schedule"; at: number };

export interface StepResult {
  state: TableState;
  events: TableEvent[];
  effects: Effect[];
  error?: { code: string; message: string };
}
