// Maximum stat values of tamed creatures that stand in the world of a save, for the texts of the
// upload list (DinoStats).
//
// A world save holds the levels of a creature and its current values, but not MaxStatusValues or
// BaseLevelMaxStatusValues: the game computes them on loading from the levels, the base values of
// the species and the server's multipliers. The archives the game writes (cryopods, souls, uploads)
// hold both. For stat i the game's values follow
//
//   BaseLevelMaxStatusValues = B × (1 + W × a) × (1 + IB × s) + T
//   MaxStatusValues          = BaseLevelMaxStatusValues × (1 + D × d)
//
// with W the wild points of the stat (torpidity grows with every wild level: BaseCharacterLevel − 1),
// D the domestic points, IB the imprinting quality, and B, a, s, T, d fixed per species and server.
// Food also shrinks with lower taming effectiveness TE = 1 / (1 + TamedIneffectivenessModifier).
// Multiplied out, both lines are linear in [1, W, IB, W·IB] × [1, TE] and [1, D] × [1, TE], so a least
// squares fit over the archives of the same class gives the coefficients without knowing the species.
// An estimate is only given where the creature's levels lie in the span of the archives' levels
// (one archive with the same levels is enough), and only when at least half of the archives fit the
// line exactly; the others (packed under other settings) are left out.
//
// Checked against 15,427 values in game archives of 15 saves of one cluster, each estimated without
// its own archive: 91 % give the very text the game writes, 0.9 % are within 1 %, 0.13 % further off;
// 7.7 % get no estimate (mostly a class without other archives).
import { findProperty, type Property } from './tree.ts';

/** Stats estimated here: health, stamina, torpidity, oxygen, food, water, temperature, weight. */
export const ESTIMATED_STATS = 8;
const TORPIDITY = 2;
/** Relative deviation up to which an archive counts as fitting the line (float32 values). */
const FITS = 1e-4;

export interface StatArchive {
  /** Creature class, e.g. "Rex_Character_BP_C". */
  cls: string;
  /** Map the archive was packed on (second outer name of the creature), null if unknown. */
  map: string | null;
  /** Properties of its status component. */
  status: Property[];
}

export interface MaxStatus {
  /** MaxStatusValues 0–7, null where no estimate is possible. */
  values: (number | null)[];
  /** Archives of the class the estimate rests on, and whether they were packed on the same map. */
  archives: number;
  sameMap: boolean;
}

const value = (list: Property[], name: string, index = 0): number | undefined => {
  const v = findProperty(list, name, index)?.value;
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined;
};

interface Levels { w: number; d: number; ib: number; te: number }

function levels(status: Property[], i: number): Levels {
  return {
    w: i === TORPIDITY ? (value(status, 'BaseCharacterLevel') ?? 1) - 1 : value(status, 'NumberOfLevelUpPointsApplied', i) ?? 0,
    d: value(status, 'NumberOfLevelUpPointsAppliedTamed', i) ?? 0,
    ib: value(status, 'DinoImprintingQuality') ?? 0,
    te: 1 / (1 + (value(status, 'TamedIneffectivenessModifier') ?? 0)),
  };
}

const withTe = (x: number[], l: Levels, te: boolean): number[] => (te ? [...x, ...x.map((v) => v * l.te)] : x);
const baseRow = (l: Levels, te: boolean): number[] => withTe([1, l.w, l.ib, l.w * l.ib], l, te);
const tamedRow = (l: Levels, te: boolean): number[] => withTe([1, l.d], l, te);

/** Coefficients over independent columns, and how each dependent column follows from them. */
interface Fit { keep: number[]; coef: number[]; deps: { col: number; coef: number[] }[] }

const dot = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a: number[]): number => Math.sqrt(dot(a, a));

/**
 * Least squares by Gram-Schmidt over the columns; columns that depend on earlier ones are left out.
 * leverage: how much each row pulls the line to itself (1: the row alone fixes a coefficient).
 */
function leastSquares(rows: number[][], y: number[]): Fit & { leverage: number[] } {
  const q: number[][] = [];
  const r: number[][] = [];
  const keep: number[] = [];
  const deps: Fit['deps'] = [];
  const back = (proj: number[]): number[] => {
    const c = new Array<number>(keep.length).fill(0);
    for (let t = keep.length - 1; t >= 0; t--) {
      let s = proj[t];
      for (let u = t + 1; u < keep.length; u++) s -= r[u][t] * c[u];
      c[t] = s / r[t][t];
    }
    return c;
  };
  for (let j = 0; j < (rows[0]?.length ?? 0); j++) {
    const col = rows.map((x) => x[j]);
    let v = col.slice();
    const proj: number[] = [];
    for (const b of q) {
      const p = dot(b, v);
      proj.push(p);
      v = v.map((x, t) => x - p * b[t]);
    }
    const n = norm(v);
    if (n > 1e-9 * Math.max(1, norm(col))) {
      r.push([...proj, n]);
      q.push(v.map((x) => x / n));
      keep.push(j);
    } else {
      deps.push({ col: j, coef: back(proj) });
    }
  }
  const leverage = rows.map((_, i) => q.reduce((s, b) => s + b[i] * b[i], 0));
  return { keep, coef: back(q.map((b) => dot(b, y))), deps, leverage };
}

/** The fitted value for x, or null if x is not in the span of the archives' rows. */
function predict(f: Fit, x: number[]): number | null {
  const kx = f.keep.map((k) => x[k]);
  for (const d of f.deps) {
    if (Math.abs(dot(d.coef, kx) - x[d.col]) > 1e-6 * Math.max(1, Math.abs(x[d.col]))) return null;
  }
  return dot(f.coef, kx);
}

/** Up to this many archives, each step looks for the one archive whose removal helps most. */
const FEW = 60;

/**
 * Fits and leaves out archives off the line until all left fit; null when fewer than half are left,
 * or when archives were left out and the rest only just fixes the coefficients (nothing left to
 * check them). With few archives one step leaves out the archive without which most of the others
 * fit; with many, the worst quarter of those off the line, ranked by their deviation from a line
 * fitted without them (leverage), so that a single archive cannot pull the line to itself.
 */
function robustFit(rows: number[][], y: number[]): Fit | null {
  const fit = (use: number[]) => leastSquares(use.map((i) => rows[i]), use.map((i) => y[i]));
  const errors = (f: Fit, use: number[]) =>
    use.map((i) => Math.abs(dot(f.coef, f.keep.map((k) => rows[i][k])) - y[i]) / Math.max(1, Math.abs(y[i])));
  let use = rows.map((_, i) => i);
  while (use.length && use.length * 2 >= rows.length) {
    const f = fit(use);
    const e = errors(f, use);
    const off = e.filter((v) => v > FITS).length;
    if (!off) return use.length < rows.length && use.length <= f.keep.length ? null : f;
    if (use.length <= FEW) {
      let best = { at: -1, fitting: -1, worst: Infinity };
      use.forEach((_, t) => {
        const rest = use.filter((__, u) => u !== t);
        const er = errors(fit(rest), rest);
        const fitting = er.filter((v) => v <= FITS).length;
        const worst = Math.max(...er);
        if (fitting > best.fitting || (fitting === best.fitting && worst < best.worst)) best = { at: t, fitting, worst };
      });
      use = use.filter((_, u) => u !== best.at);
    } else {
      const worst = use
        .map((i, t) => ({ i, e: e[t], without: e[t] / Math.max(1e-9, 1 - f.leverage[t]) }))
        .filter((r) => r.e > FITS)
        .sort((a, b) => b.without - a.without);
      const drop = new Set(worst.slice(0, Math.ceil(off / 4)).map((r) => r.i));
      use = use.filter((i) => !drop.has(i));
    }
  }
  return null;
}

/** With the taming effectiveness first; without it when the archives do not span the creature's. */
function fitBoth(rows: (te: boolean) => number[][], y: number[]): [Fit | null, Fit | null] {
  return [robustFit(rows(true), y), robustFit(rows(false), y)];
}

const first = (fits: [Fit | null, Fit | null], x: (te: boolean) => number[]): number | null =>
  (fits[0] && predict(fits[0], x(true))) ?? (fits[1] && predict(fits[1], x(false))) ?? null;

interface StatFit { base: [Fit | null, Fit | null]; tamed: [Fit | null, Fit | null] | null }

/** Estimates MaxStatusValues of creatures from archives the game wrote, per class. */
export class MaxStatusEstimator {
  private readonly byClass = new Map<string, StatArchive[]>();
  private readonly fits = new Map<string, StatFit[]>();

  constructor(archives: StatArchive[]) {
    // Archives with BaseLevelMaxStatusValues; there a missing entry is 0, the default.
    for (const a of archives) {
      if (!a.status.some((p) => p.name === 'BaseLevelMaxStatusValues')) continue;
      (this.byClass.get(a.cls) ?? this.byClass.set(a.cls, []).get(a.cls)!).push(a);
    }
  }

  /** MaxStatusValues 0–7 for a creature of class cls on map from its status component; null without archives. */
  estimate(cls: string, map: string | null, status: Property[]): MaxStatus | null {
    const all = this.byClass.get(cls) ?? [];
    const same = map === null ? [] : all.filter((a) => a.map === map);
    const sameMap = same.length >= 3;
    const refs = sameMap ? same : all;
    if (!refs.length) return null;
    const key = `${cls}\n${sameMap ? map : ''}`;
    let fits = this.fits.get(key);
    if (!fits) {
      fits = Array.from({ length: ESTIMATED_STATS }, (_, i) => this.fit(refs, i));
      this.fits.set(key, fits);
    }
    const values = fits.map((f, i) => {
      const l = levels(status, i);
      const base = first(f.base, (te) => baseRow(l, te));
      const ratio = f.tamed ? first(f.tamed, (te) => tamedRow(l, te)) : l.d === 0 ? 1 : null;
      const v = base === null || ratio === null ? null : base * ratio;
      return v !== null && Number.isFinite(v) && v > 0 ? v : null;
    });
    return { values, archives: refs.length, sameMap };
  }

  private fit(refs: StatArchive[], i: number): StatFit {
    const lv = refs.map((a) => levels(a.status, i));
    const blm = refs.map((a) => value(a.status, 'BaseLevelMaxStatusValues', i) ?? 0);
    // MaxStatusValues / BaseLevelMaxStatusValues from archives that hold both (a missing
    // MaxStatusValues entry is the species default, which is not known here).
    const t = refs.map((a, k) => [k, value(a.status, 'MaxStatusValues', i)] as const).filter(([k, m]) => m !== undefined && blm[k] > 0);
    return {
      base: fitBoth((te) => lv.map((l) => baseRow(l, te)), blm),
      tamed: t.length ? fitBoth((te) => t.map(([k]) => tamedRow(lv[k], te)), t.map(([k, m]) => m! / blm[k])) : null,
    };
  }
}
