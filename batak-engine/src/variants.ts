/**
 * Varyant ayarlari.
 *
 * Spec'teki "Karar bekleyen maddeler" bolumu BURADA bayrak olarak durur.
 * Karar degisince bu dosyada tek satir degisir; motor degismez.
 */

export interface VariantConfig {
  id: string;
  label: string;

  /** Karsilikli koltuklar takim olur (0-2 / 1-3). */
  partnership: boolean;

  /** Ihale asamasi var mi. */
  bidding: boolean;
  /** Ihale varsa en dusuk teklif. KARAR: 5 mi? */
  minBid: number;
  maxBid: number;

  /** Ihale yoksa herkesin sabit hedefi (Koz Batak: 3). KARAR: 3 mu? */
  fixedTarget: number | null;

  /** Koz yok (Gonul Batagi). */
  noTrump: boolean;
  /** Tur almak ceza (Gonul Batagi). */
  inverted: boolean;
  /** Ters oyunda 13 turun hepsini alana +13. KARAR: kalsin mi? */
  slamBonus: boolean;

  /**
   * KARAR: Elinde acilan renk yoksa koz oynamak ZORUNLU mu?
   * false = serbest (spec'in varsayilani).
   */
  mustPlayTrumpWhenVoid: boolean;

  /**
   * Son aktif teklifci, kimse teklif vermemisse pas gecemez; minBid ile
   * zorunlu ihale acar. Kapatilirsa dort pas eli iptal eder ve BOT masasi
   * sonsuz dongu riskine girer.
   */
  forceLastBidder: boolean;

  /**
   * KARAR: Ihale sahibi tutturunca kac puan?
   * true  = aldigi tur sayisi kadar (spec'in varsayilani)
   * false = yalnizca taahhut degeri kadar
   */
  contractorScoresActualTricks: boolean;
}

const base = {
  maxBid: 13,
  fixedTarget: null,
  noTrump: false,
  inverted: false,
  slamBonus: false,
  mustPlayTrumpWhenVoid: false,
  contractorScoresActualTricks: true,
  forceLastBidder: true,
} as const;

/** Lansman varyanti. */
export const ESLI_BATAK: VariantConfig = {
  ...base,
  id: "esli",
  label: "Esli Batak",
  partnership: true,
  bidding: true,
  minBid: 5,
};

export const IHALELI_BATAK: VariantConfig = {
  ...base,
  id: "ihaleli",
  label: "Ihaleli Batak",
  partnership: false,
  bidding: true,
  minBid: 5,
};

export const KOZ_BATAK: VariantConfig = {
  ...base,
  id: "koz",
  label: "Koz Batak",
  partnership: false,
  bidding: false,
  minBid: 0,
  fixedTarget: 3,
};

export const GONUL_BATAGI: VariantConfig = {
  ...base,
  id: "gonul",
  label: "Gonul Batagi",
  partnership: false,
  bidding: false,
  minBid: 0,
  noTrump: true,
  inverted: true,
  slamBonus: true,
};

export const VARIANTS: Record<string, VariantConfig> = {
  esli: ESLI_BATAK,
  ihaleli: IHALELI_BATAK,
  koz: KOZ_BATAK,
  gonul: GONUL_BATAGI,
};
