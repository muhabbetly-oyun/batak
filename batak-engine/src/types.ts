/**
 * Batak kural motoru — tip tanimlari.
 * Spec: Batak Kural Spesifikasyonu, bolum "Ortak kurallar".
 */

/** 0=Maca(S) 1=Kupa(H) 2=Karo(D) 3=Sinek(C) */
export type Suit = 0 | 1 | 2 | 3;

export const SUITS: readonly Suit[] = [0, 1, 2, 3];
export const SUIT_LABELS = ["S", "H", "D", "C"] as const;
export const RANK_LABELS = [
  "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A",
] as const;

/**
 * Kart = 0..51. card = suit * 13 + rankIndex, rankIndex 0..12 (2..A).
 * Sayisal tutulmasinin sebebi: karsilastirma ucuz, serilestirme kucuk.
 */
export type Card = number;

export type Seat = 0 | 1 | 2 | 3;
export const SEATS: readonly Seat[] = [0, 1, 2, 3];

export const suitOf = (c: Card): Suit => Math.floor(c / 13) as Suit;
/** 2..14 (14 = As) */
export const rankOf = (c: Card): number => (c % 13) + 2;
export const makeCard = (s: Suit, rank: number): Card => s * 13 + (rank - 2);
export const cardLabel = (c: Card): string =>
  `${RANK_LABELS[c % 13]}${SUIT_LABELS[suitOf(c)]}`;

export type Phase = "bidding" | "trump" | "playing" | "ended" | "voided";

export interface PlayedCard {
  seat: Seat;
  card: Card;
}

export interface HandState {
  phase: Phase;
  variantId: string;
  dealer: Seat;
  /** Koltuk basina eldeki kartlar. Sunucuda tutulur, istemciye TUM hali gonderilmez. */
  hands: Card[][];
  /** Sirasi gelen koltuk. phase "ended"/"voided" ise anlamsiz. */
  turn: Seat;

  // --- ihale ---
  /** Koltuk basina son teklif; pas gecen null kalir. */
  bids: (number | null)[];
  passed: boolean[];
  highBid: number;
  highBidder: Seat | null;

  // --- oyun ---
  trump: Suit | null;
  leader: Seat;
  trick: PlayedCard[];
  trickNo: number;
  tricksWon: number[];

  // --- dogrulanabilirlik ---
  seedHash: string;
  /** El bitene kadar null; "ended" ile birlikte aciklanir. */
  seed: string | null;

  /** El bitince doldurulur: koltuk basina puan. */
  scores: number[] | null;
}

export type Move =
  | { type: "bid"; seat: Seat; value: number }
  | { type: "pass"; seat: Seat }
  | { type: "chooseTrump"; seat: Seat; suit: Suit }
  | { type: "play"; seat: Seat; card: Card };

export type GameEvent =
  | { type: "hand_started"; dealer: Seat; seedHash: string }
  | { type: "cards_dealt"; counts: number[] }
  | { type: "bid"; seat: Seat; value: number }
  | { type: "pass"; seat: Seat }
  | { type: "bid_won"; seat: Seat; value: number }
  | { type: "hand_voided"; reason: "all_passed" }
  | { type: "trump_set"; seat: Seat | null; suit: Suit | null }
  | { type: "card_played"; seat: Seat; card: Card; trickNo: number }
  | { type: "trick_won"; seat: Seat; trickNo: number; cards: PlayedCard[] }
  | { type: "hand_ended"; scores: number[]; tricksWon: number[]; seed: string };

/** Kural ihlali. Motor asla exception atmaz; bu nesneyi dondurur. */
export interface RuleError {
  code:
    | "WRONG_PHASE"
    | "NOT_YOUR_TURN"
    | "ALREADY_PASSED"
    | "BID_TOO_LOW"
    | "BID_ABOVE_MAX"
    | "NOT_CONTRACTOR"
    | "CARD_NOT_IN_HAND"
    | "MUST_FOLLOW_SUIT"
    | "MUST_PLAY_TRUMP"
    | "BIDDING_DISABLED";
  message: string;
}

export interface Applied {
  state: HandState;
  events: GameEvent[];
  error?: undefined;
}
export interface Rejected {
  state: HandState;
  events: [];
  error: RuleError;
}
export type Result = Applied | Rejected;
