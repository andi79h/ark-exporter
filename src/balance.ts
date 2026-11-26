// Same decay times for every building material (ASE).
//
// The game takes the decay time of a structure from its class: base time B (the time after which
// others may demolish it) and B × AutoDestroyOldStructuresMultiplier (removal when the server loads
// the save). Thatch, wood, stone, metal and tek differ by their class (4, 8, 12, 16, 20 days by default).
// The save only holds LastInAllyRangeTime, the last time a tribe member was near. Shifting that time
// stamp per class makes every class reach both thresholds at the same real age:
//
//   phase 1 (real age < T1): stored age = real age + (B − T1)      → others may demolish from T1 on
//   phase 2 (real age ≥ T1): stored age = real age + (k·B − T2)    → removed at the first load after T2
//
// The game removes on load (and on waking from stasis) only when LastInAllyRangeTime is above 0 and
// now − LastInAllyRangeTime > k·B. A shifted value for phase 2 therefore never goes below MIN_STAMP: on a map
// whose game time is not yet beyond k·B, a class cannot be removed by shifting; the report counts those.
//
// Written values carry a fixed fraction (MARK) so the next run can tell them from the game's own
// values (a visit writes the current game time) and compute the real visit back. The phase of a marked
// value follows from its stored age: phase-2 values are written at a stored age of at least T1 + k·B − T2,
// phase-1 values below B; the gap between both, (k − 1)·B − (T2 − T1), must be positive for a class to
// be balanced and covers missed runs. If runs are missed for longer than the gap, phase-1 values may be
// read as phase 2; the real age then comes out smaller by the gap, the structure is protected longer.
import { findProperty } from './tree.ts';
import type { SaveEditor } from './editor.ts';
import type { Entry } from './world.ts';

/** Fraction (seconds) of every time stamp written by balance-decay: 13/32, exact in a double. */
export const MARK = 13 / 32;
/** Fraction of time stamps written back by undo; anything but MARK reads as a game value. */
export const UNDO_FRACTION = 1 / 2;
/** Smallest value written: the game skips structures whose time stamp is 0 or below. */
export const MIN_STAMP = 1 + MARK;
export const DAY = 86_400;

export interface DecayClass {
  /** Base decay time in seconds (class default × class multiplier × StructureSettings multiplier). */
  base: number;
  core: boolean | null;
}

export interface ClassTable {
  /** Short class name as stored in saves (e.g. Wall_Wood_C). */
  classes: Map<string, DecayClass>;
  /** Short names that stand for classes with different base times (mods copy vanilla names). */
  ambiguous: Set<string>;
}

/**
 * Reads a tab-separated class table with a header. Required: `class` (short name or full path) and the
 * base time as `base_s` (seconds), `days_base` (days) or `period_s` × `class_mult` × `settings_mult`.
 * Optional: `core` (0/1). Lines starting with # are comments.
 */
export function parseClassTable(text: string): ClassTable {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) throw new Error('class table is empty');
  const head = lines[0].split('\t').map((h) => h.trim());
  const col = (n: string) => head.indexOf(n);
  const ci = col('class');
  if (ci < 0) throw new Error('class table: column "class" missing');
  const bs = col('base_s');
  const bd = col('days_base');
  const [ps, cm, sm] = [col('period_s'), col('class_mult'), col('settings_mult')];
  if (bs < 0 && bd < 0 && (ps < 0 || cm < 0 || sm < 0)) {
    throw new Error('class table: give base_s, days_base or period_s, class_mult and settings_mult');
  }
  const core = col('core');
  const classes = new Map<string, DecayClass>();
  const ambiguous = new Set<string>();
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    const full = (f[ci] ?? '').trim();
    if (!full) continue;
    const short = full.slice(full.lastIndexOf('.') + 1);
    let base: number;
    if (bs >= 0) base = Number(f[bs]);
    else if (bd >= 0) base = Number(f[bd]) * DAY;
    else base = Number(f[ps]) * Number(f[cm]) * Number(f[sm]);
    if (!Number.isFinite(base) || base < 0) throw new Error(`class table: bad base time for ${full}`);
    const c: DecayClass = { base, core: core >= 0 ? f[core]?.trim() === '1' : null };
    const seen = classes.get(short);
    if (seen && Math.abs(seen.base - base) > 1e-6) ambiguous.add(short);
    if (!seen) classes.set(short, c);
  }
  return { classes, ambiguous };
}

export interface BalanceParams {
  /** T1 in seconds: real age from which others may demolish. */
  destroyableAfter: number;
  /** T2 in seconds: real age after which the next load removes the structure. */
  removedAfter: number;
  /** AutoDestroyOldStructuresMultiplier as the server applies it. */
  autoDestroyMult: number;
  /** PvEStructureDecayPeriodMultiplier as the server applies it (ASE 358.24: 1, see docs of the analysis). */
  periodMult: number;
  /** Lowest TargetingTeam that counts as a player (the game uses 50000). */
  minTeam: number;
  /**
   * Game time before which nothing becomes due for removal (transition period): structures past T2 get
   * the virtual visit notBefore − T2 and are removed at the first load after notBefore. At most T2 − T1
   * ahead of the save's game time.
   */
  notBefore?: number;
}

export interface ClassShift {
  /** Stored minus real age, whole seconds, per phase. */
  d1: number;
  d2: number;
  /** Stored age from which a marked value is read as phase 2 (T1 + d2). */
  phase2From: number;
}

/** Shifts of one class, or null when the class cannot reach both targets (gap ≤ 0). */
export function classShift(base: number, p: BalanceParams): ClassShift | null {
  const b = base * p.periodMult;
  if (!(b > 0)) return null;
  const gap = (p.autoDestroyMult - 1) * b - (p.removedAfter - p.destroyableAfter);
  if (!(gap > 0)) return null;
  const d1 = Math.round(b - p.destroyableAfter);
  const d2 = Math.round(p.autoDestroyMult * b - p.removedAfter);
  return { d1, d2, phase2From: p.destroyableAfter + d2 };
}

export const isMarked = (t: number): boolean => t - Math.floor(t) === MARK;

/** Real visit time behind a stored value; marked values are ours and get their shift removed. */
export function realVisit(stored: number, now: number, s: ClassShift): { visit: number; marked: boolean; phase: 1 | 2 | 0 } {
  if (!isMarked(stored)) return { visit: stored, marked: false, phase: 0 };
  const phase = now - stored >= s.phase2From ? 2 : 1;
  return { visit: stored + (phase === 2 ? s.d2 : s.d1), marked: true, phase };
}

/** Value to store for a real visit time; clamped marks a phase-2 value raised to MIN_STAMP. */
export function shiftedValue(visit: number, now: number, s: ClassShift, p: BalanceParams): { value: number; phase: 1 | 2; clamped: boolean } {
  const phase = now - visit < p.destroyableAfter ? 1 : 2;
  const value = Math.floor(visit - (phase === 1 ? s.d1 : s.d2)) + MARK;
  // Phase-1 values may be 0 or below: "demolishable" (time stamp + B) has no such check, and removal is not wanted.
  if (phase === 2 && value < MIN_STAMP) return { value: MIN_STAMP, phase, clamped: true };
  return { value, phase, clamped: false };
}

export interface BalanceGroup { structures: number; changed: number; phase1: number; phase2: number; destroyable: number; due: number; }

export interface BalanceReport {
  operation: 'balance-decay';
  undo: boolean;
  params: { destroyableAfterDays: number; removedAfterDays: number; autoDestroyMult: number; periodMult: number; minTeam: number };
  gameTime: number;
  structures: number;
  balanced: number;
  changed: number;
  /** Values written by an earlier run (marked) and values the game wrote since (visits, new structures). */
  markedBefore: number;
  gameValues: number;
  phase1: number;
  phase2: number;
  /** Real age at least T1 (others may demolish) and at least T2 (removed when the server loads this save). */
  destroyable: number;
  due: number;
  /** Past T2 but kept until notBefore (transition period). */
  graced: number;
  /**
   * Phase-2 values raised to MIN_STAMP; of those, the ones the game cannot remove yet because the map's game
   * time is not beyond k·B (classes with very long base times on young maps), per class.
   */
  clamped: number;
  notRemovable: Record<string, number>;
  /** Per base time in days. */
  byBaseDays: Record<string, BalanceGroup>;
  skipped: {
    otherTeams: number;
    noTimestamp: number;
    noDecay: number;
    unknown: Record<string, number>;
    ambiguous: Record<string, number>;
    /** Classes whose base time is too short for the targets: (k − 1)·B ≤ T2 − T1. */
    gapTooSmall: Record<string, number>;
  };
}

const inc = (r: Record<string, number>, k: string): void => { r[k] = (r[k] ?? 0) + 1; };

/**
 * Balances (or with undo: restores) LastInAllyRangeTime of all player structures in the editor.
 * Structures of unknown, ambiguous or unbalanceable classes and values the run cannot attribute stay as
 * they are. Returns what happened; changes go into the editor and are written by the caller.
 */
export function balanceDecay(ed: SaveEditor, world: Entry[], table: ClassTable, p: BalanceParams, opts: { undo?: boolean } = {}): BalanceReport {
  if (!(p.removedAfter >= p.destroyableAfter && p.destroyableAfter >= 0)) throw new Error('removed-after must be at least destroyable-after (both ≥ 0)');
  if (!(p.autoDestroyMult >= 1) || !(p.periodMult > 0)) throw new Error('autodestroy multiplier must be ≥ 1 and period multiplier > 0');
  const undo = opts.undo === true;
  const now = ed.gameTime;
  const grace = !undo && p.notBefore !== undefined && p.notBefore > now ? p.notBefore : null;
  if (grace !== null && grace - now > p.removedAfter - p.destroyableAfter) {
    throw new Error(`not-before is ${((grace - now) / DAY).toFixed(1)} days ahead; at most removed-after − destroyable-after (${((p.removedAfter - p.destroyableAfter) / DAY).toFixed(1)} days)`);
  }
  const r: BalanceReport = {
    operation: 'balance-decay', undo,
    params: { destroyableAfterDays: p.destroyableAfter / DAY, removedAfterDays: p.removedAfter / DAY, autoDestroyMult: p.autoDestroyMult, periodMult: p.periodMult, minTeam: p.minTeam },
    gameTime: now, structures: 0, balanced: 0, changed: 0, markedBefore: 0, gameValues: 0, phase1: 0, phase2: 0, destroyable: 0, due: 0, graced: 0, clamped: 0, notRemovable: {},
    byBaseDays: {},
    skipped: { otherTeams: 0, noTimestamp: 0, noDecay: 0, unknown: {}, ambiguous: {}, gapTooSmall: {} },
  };
  const shifts = new Map<string, ClassShift | null>();
  for (const e of world) {
    if (e.kind !== 'structure') continue;
    r.structures++;
    if ((e.team ?? 0) < p.minTeam) { r.skipped.otherTeams++; continue; }
    const t = findProperty(ed.props(e.index), 'LastInAllyRangeTime');
    if (!t || t.type !== 'DoubleProperty' || typeof t.value !== 'number') { r.skipped.noTimestamp++; continue; }
    if (table.ambiguous.has(e.cls)) { inc(r.skipped.ambiguous, e.cls); continue; }
    const c = table.classes.get(e.cls);
    if (!c) { inc(r.skipped.unknown, e.cls); continue; }
    if (!(c.base > 0)) { r.skipped.noDecay++; continue; }
    if (!shifts.has(e.cls)) shifts.set(e.cls, classShift(c.base, p));
    const s = shifts.get(e.cls)!;
    if (!s) { inc(r.skipped.gapTooSmall, e.cls); continue; }

    const stored = t.value;
    const real = realVisit(stored, now, s);
    if (real.marked) r.markedBefore++;
    else r.gameValues++;
    // Transition period: overdue structures count as visited at notBefore − T2, so they are due at notBefore.
    if (grace !== null && now - real.visit >= p.removedAfter) { real.visit = grace - p.removedAfter; r.graced++; }
    const age = now - real.visit;
    let value = stored;
    let phase: 1 | 2;
    if (undo) {
      phase = age < p.destroyableAfter ? 1 : 2;
      if (real.marked) value = Math.floor(real.visit) + UNDO_FRACTION;
    } else {
      const sh = shiftedValue(real.visit, now, s, p);
      value = sh.value;
      phase = sh.phase;
      if (sh.clamped) {
        r.clamped++;
        if (!(now - MIN_STAMP > p.autoDestroyMult * c.base * p.periodMult)) inc(r.notRemovable, e.cls);
      }
    }
    r.balanced++;
    const g = (r.byBaseDays[String(+(c.base / DAY).toFixed(3))] ??= { structures: 0, changed: 0, phase1: 0, phase2: 0, destroyable: 0, due: 0 });
    g.structures++;
    if (phase === 1) { r.phase1++; g.phase1++; } else { r.phase2++; g.phase2++; }
    if (age >= p.destroyableAfter) { r.destroyable++; g.destroyable++; }
    if (age >= p.removedAfter) { r.due++; g.due++; }
    if (value !== stored) {
      const o = ed.edit(e.index);
      const prop = findProperty(o.props, 'LastInAllyRangeTime')!;
      prop.value = value;
      r.changed++;
      g.changed++;
    }
  }
  return r;
}
