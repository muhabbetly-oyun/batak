import { VARIANTS, type VariantConfig } from "../variants.js";
import { DEFAULT_TIMERS, type Timers } from "../table/types.js";

/**
 * Calisma zamani ayarlari.
 *
 * variants.ts'teki degerler artik YALNIZCA varsayilan. Gercek degerler
 * veritabaninda durur ve panelden degistirilir. Masa kurulurken ayarin
 * kopyasi masaya yazilir, boylece oynanan masa degisiklikten etkilenmez.
 */

export interface Region {
  id: string;
  label: string;
  /** Kapali bolgede yeni masa kurulmaz; acik masalar bitene kadar surer. */
  enabled: boolean;
}

export interface RuntimeConfig {
  /**
   * Salonlar. Bolge AYRI HAVUZ DEGIL, TERCIHTIR: ayni bolgeden bekleyen
   * masa varsa oraya oturulur, yoksa herhangi bir masaya. Ayri havuz
   * yapilsaydi 20 oyuncu 12 bolgeye bolunur, kimse masa bulamazdi.
   */
  regions: Region[];
  variants: Record<string, VariantConfig>;
  timers: Timers;
  /** Varyant masa kurulumuna acik mi. Lansmanda yalnizca biri acik. */
  enabled: Record<string, boolean>;
  /** Jeton cinsinden masa bahsi. */
  stakes: Record<string, number>;
  updatedAt: string | null;
  updatedBy: string | null;
}

const DEFAULT_REGIONS: Region[] = [
  { id: "genel",    label: "Genel salon",   enabled: true },
  { id: "marmara",  label: "Marmara",       enabled: true },
  { id: "ege",      label: "Ege",           enabled: true },
  { id: "akdeniz",  label: "Akdeniz",       enabled: true },
  { id: "icanadolu", label: "İç Anadolu",   enabled: true },
  { id: "karadeniz", label: "Karadeniz",    enabled: true },
  { id: "guneydogu", label: "Güneydoğu",    enabled: true },
  { id: "dogu",     label: "Doğu Anadolu",  enabled: true },
  { id: "yurtdisi", label: "Yurt dışı",     enabled: true },
];

export const defaultConfig = (): RuntimeConfig => ({
  regions: DEFAULT_REGIONS.map((r) => ({ ...r })),
  variants: Object.fromEntries(
    Object.entries(VARIANTS).map(([k, v]) => [k, { ...v }]),
  ),
  timers: { ...DEFAULT_TIMERS },
  enabled: { esli: true, ihaleli: false, koz: false, gonul: false },
  stakes: { esli: 100, ihaleli: 100, koz: 100, gonul: 100 },
  updatedAt: null,
  updatedBy: null,
});

/** Hangi alanlar panelden degistirilebilir. Digerleri yok sayilir. */
export const EDITABLE_VARIANT_FIELDS = [
  "minBid", "maxBid", "fixedTarget",
  "mustPlayTrumpWhenVoid", "contractorScoresActualTricks",
  "forceLastBidder", "slamBonus",
] as const;

export const EDITABLE_TIMER_FIELDS = [
  "bid", "trump", "play", "handEnd", "reconnect",
] as const;

export interface ValidationIssue { path: string; message: string }

/**
 * Panelden gelen degeri dogrular. Panel kullanicisi admin olsa bile
 * imkansiz degerler (minBid 0, reconnect 1 ms) masayi bozar.
 */
export function validate(c: RuntimeConfig): ValidationIssue[] {
  const out: ValidationIssue[] = [];

  for (const [id, v] of Object.entries(c.variants)) {
    const p = `variants.${id}`;
    if (v.bidding) {
      if (!Number.isInteger(v.minBid) || v.minBid < 1 || v.minBid > 13) {
        out.push({ path: `${p}.minBid`, message: "1 ile 13 arasinda tam sayi olmali." });
      }
      if (!Number.isInteger(v.maxBid) || v.maxBid < v.minBid || v.maxBid > 13) {
        out.push({ path: `${p}.maxBid`, message: "minBid ile 13 arasinda olmali." });
      }
    } else if (v.fixedTarget !== null) {
      if (!Number.isInteger(v.fixedTarget) || v.fixedTarget < 0 || v.fixedTarget > 13) {
        out.push({ path: `${p}.fixedTarget`, message: "0 ile 13 arasinda olmali." });
      }
    }
    if (v.inverted && v.bidding) {
      out.push({ path: p, message: "Ters oyunda ihale olamaz." });
    }
    if (v.noTrump && v.mustPlayTrumpWhenVoid) {
      out.push({ path: `${p}.mustPlayTrumpWhenVoid`, message: "Kozsuz varyantta anlamsiz." });
    }
    if (v.bidding && !v.forceLastBidder) {
      out.push({
        path: `${p}.forceLastBidder`,
        message: "Kapatilirsa bot masasi sonsuz iptal dongusune girebilir. Emin olun.",
      });
    }
  }

  // --- salonlar ---
  const ids = new Set<string>();
  for (const r of c.regions ?? []) {
    if (!/^[a-z0-9-]{2,24}$/.test(r.id)) {
      out.push({ path: `regions.${r.id}`, message: "Kimlik kucuk harf, rakam ve tire olmali." });
    }
    if (!r.label || r.label.length > 30) {
      out.push({ path: `regions.${r.id}.label`, message: "Ad 1-30 karakter olmali." });
    }
    if (ids.has(r.id)) {
      out.push({ path: `regions.${r.id}`, message: "Ayni kimlik iki kez kullanilmis." });
    }
    ids.add(r.id);
  }
  if (!(c.regions ?? []).some((r) => r.enabled)) {
    out.push({ path: "regions", message: "En az bir salon acik olmali." });
  }
  if ((c.regions ?? []).filter((r) => r.enabled).length > 14) {
    out.push({
      path: "regions",
      message: "14'ten fazla acik salon masa dolulugunu boler. Once oyuncu sayisi artsin.",
    });
  }

  const t = c.timers;
  if (t.play < 5_000) out.push({ path: "timers.play", message: "En az 5 sn olmali." });
  if (t.bid < 5_000) out.push({ path: "timers.bid", message: "En az 5 sn olmali." });
  if (t.trump < 5_000) out.push({ path: "timers.trump", message: "En az 5 sn olmali." });
  if (t.handEnd < 1_000) out.push({ path: "timers.handEnd", message: "En az 1 sn olmali." });
  if (t.reconnect < 10_000 || t.reconnect > 300_000) {
    out.push({ path: "timers.reconnect", message: "10 sn ile 5 dk arasinda olmali." });
  }

  if (!Object.values(c.enabled).some(Boolean)) {
    out.push({ path: "enabled", message: "En az bir varyant acik olmali." });
  }
  for (const [id, s] of Object.entries(c.stakes)) {
    if (!Number.isInteger(s) || s < 0) {
      out.push({ path: `stakes.${id}`, message: "0 veya pozitif tam sayi olmali." });
    }
  }
  return out;
}

/** Gelen govdeyi mevcut ayara guvenli sekilde birlestirir. */
export function merge(current: RuntimeConfig, patch: unknown): RuntimeConfig {
  const next: RuntimeConfig = {
    ...current,
    variants: Object.fromEntries(
      Object.entries(current.variants).map(([k, v]) => [k, { ...v }]),
    ),
    timers: { ...current.timers },
    enabled: { ...current.enabled },
    stakes: { ...current.stakes },
    regions: (current.regions ?? []).map((r) => ({ ...r })),
  };
  if (typeof patch !== "object" || patch === null) return next;
  const p = patch as Record<string, any>;

  if (p.variants && typeof p.variants === "object") {
    for (const [id, raw] of Object.entries<any>(p.variants)) {
      const target = next.variants[id];
      if (!target || typeof raw !== "object" || raw === null) continue;
      for (const f of EDITABLE_VARIANT_FIELDS) {
        if (f in raw) (target as any)[f] = raw[f];
      }
    }
  }
  if (p.timers && typeof p.timers === "object") {
    for (const f of EDITABLE_TIMER_FIELDS) {
      if (f in p.timers && typeof p.timers[f] === "number") {
        next.timers[f] = p.timers[f];
      }
    }
  }
  if (p.enabled && typeof p.enabled === "object") {
    for (const id of Object.keys(next.enabled)) {
      if (id in p.enabled) next.enabled[id] = Boolean(p.enabled[id]);
    }
  }
  if (Array.isArray(p.regions)) {
    const seen = new Set<string>();
    next.regions = [];
    for (const raw of p.regions) {
      if (typeof raw !== "object" || raw === null) continue;
      const id = String(raw.id ?? "").trim().toLowerCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      next.regions.push({
        id,
        label: String(raw.label ?? id).trim().slice(0, 30),
        enabled: raw.enabled !== false,
      });
    }
  }
  if (p.stakes && typeof p.stakes === "object") {
    for (const id of Object.keys(next.stakes)) {
      if (typeof p.stakes[id] === "number") next.stakes[id] = p.stakes[id];
    }
  }
  return next;
}
