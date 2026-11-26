// What the game dropped when it loaded a save, per class, and which of it is a loss the edit
// caused: the check after remove-classes (or any other edit) on a test server.
//
//   before: the save that was put in place (for example the output of remove-classes)
//   after:  the save the game wrote after loading it (saveworld)
//
// Objects are matched by stable ids: items by ItemId, creatures by DinoID1/DinoID2, everything else
// by name (with the data file, for actors of sublevels that share a name). Objects the game writes
// twice count once. Crafting recipes (bIsEngram) are left out, the game rebuilds them on load.
//
// The game also drops things by itself while it runs (spoiling, decay, wild creatures). A baseline
// run takes that out: the unedited save loaded with the full mod list and saved again. Objects of
// the before save that the baseline run lost as well do not count as extra loss.
import { OwnerIndex } from './classes.ts';
import type { SaveEditor, Transform } from './editor.ts';
import { embeddedRefunds, itemKey, quantityOf, type RefundEntry } from './removal.ts';
import { findProperty } from './tree.ts';
import { classify, prop } from './world.ts';

/** Teams below this are wild creatures and the world, not players or tribes (as in the game). */
const PLAYER_TEAM = 50_000;

/** Stable key of an object, null for crafting recipes. */
export function objectKey(ed: SaveEditor, i: number): string | null {
  const h = ed.header(i);
  if (h.isItem) {
    const props = ed.props(i);
    if (prop(props, 'bIsEngram') === true) return null;
    const id = itemKey(props);
    if (id !== null) return `item:${id}`;
  } else if (h.names.length === 1 && h.location) {
    const props = ed.props(i);
    if (findProperty(props, 'DinoID1')) return `dino:${String(prop(props, 'DinoID1'))}:${String(prop(props, 'DinoID2'))}`;
  }
  return `name:${h.dataFile}:${h.names.join('/')}`;
}

export interface SaveIndex {
  /** Key of every object (recipes left out) → its class; objects written twice count once. */
  keys: Map<string, string>;
  /** Objects in the object table, recipes and doubles included. */
  objects: number;
  recipes: number;
}

export function indexSave(ed: SaveEditor): SaveIndex {
  const keys = new Map<string, string>();
  let recipes = 0;
  let objects = 0;
  for (let i = 0; i < ed.size; i++) {
    if (!ed.exists(i)) continue;
    objects++;
    const k = objectKey(ed, i);
    if (k === null) recipes++;
    else if (!keys.has(k)) keys.set(k, ed.cls(i));
  }
  return { keys, objects, recipes };
}

/** Keys of `before` without a counterpart in `after`: what the game dropped in that run. */
export function lostKeys(before: SaveIndex, after: SaveIndex): Set<string> {
  const out = new Set<string>();
  for (const k of before.keys.keys()) if (!after.keys.has(k)) out.add(k);
  return out;
}

export interface ClassDiff {
  cls: string;
  /** Distinct objects compared (recipes left out, doubles once). */
  before: number;
  after: number;
  /** Objects of before without counterpart in after. */
  lost: number;
  /** Of these, lost in the baseline run as well (the game drops them by itself). */
  baselineLost: number;
  /** lost − baselineLost: the loss of the edit. */
  extra: number;
  /** Objects of after without counterpart in before. */
  gained: number;
}

export interface DiffReport {
  baseline: boolean;
  objects: { before: number; after: number };
  recipesLeftOut: { before: number; after: number };
  compared: { before: number; after: number; matched: number };
  lost: number;
  baselineLost: number;
  extra: number;
  gained: number;
  /** Matched objects that carry another class after loading, "old -> new". */
  classChanged: Record<string, number>;
  /**
   * Extra losses without a row of their own (their embedded contents still get rows): components go
   * with their actor, buff data with its buff, wild creatures belong to nobody, other actors (buffs,
   * weapons in hand, world actors) are no property to hand out. Rows are for items, structures,
   * tamed creatures and player characters.
   */
  notRefunded: { components: number; buffData: number; wildCreatures: number; actors: number };
  /** Classes with lost, gained or extra objects, most extra loss first. */
  classes: ClassDiff[];
}

/**
 * Compares the before save (open in the editor, for owners and places) with the index of the after
 * save; baselineLost are the keys the baseline run lost. Refund entries cover the extra loss.
 */
export function diffSaves(ed: SaveEditor, after: SaveIndex, baselineLost?: Set<string>): { report: DiffReport; refunds: RefundEntry[] } {
  const rows = new Map<string, ClassDiff>();
  const row = (cls: string): ClassDiff => {
    let r = rows.get(cls);
    if (!r) rows.set(cls, (r = { cls, before: 0, after: 0, lost: 0, baselineLost: 0, extra: 0, gained: 0 }));
    return r;
  };
  const seen = new Set<string>();
  const extra: number[] = [];
  const classChanged = new Map<string, number>();
  let objects = 0;
  let recipes = 0;
  let matched = 0;
  for (let i = 0; i < ed.size; i++) {
    if (!ed.exists(i)) continue;
    objects++;
    const k = objectKey(ed, i);
    if (k === null) { recipes++; continue; }
    if (seen.has(k)) continue;
    seen.add(k);
    const cls = ed.cls(i);
    const r = row(cls);
    r.before++;
    const now = after.keys.get(k);
    if (now !== undefined) {
      matched++;
      if (now !== cls) classChanged.set(`${cls} -> ${now}`, (classChanged.get(`${cls} -> ${now}`) ?? 0) + 1);
      continue;
    }
    r.lost++;
    if (baselineLost?.has(k)) { r.baselineLost++; continue; }
    r.extra++;
    extra.push(i);
  }
  for (const [k, cls] of after.keys) {
    const r = row(cls);
    r.after++;
    if (!seen.has(k)) r.gained++;
  }

  // Refund entries for the extra loss; items in a holder that is lost as well are its content.
  const owners = new OwnerIndex(ed);
  const lostSet = new Set(extra);
  const refunds: RefundEntry[] = [];
  const notRefunded = { components: 0, buffData: 0, wildCreatures: 0, actors: 0 };
  for (const i of extra) {
    const h = ed.header(i);
    const props = ed.props(i);
    const owner = owners.team(i);
    const a = owners.holder(i);
    const at: Transform | null = (a !== null ? ed.header(a).location : null) ?? h.location;
    // Without a row of their own, but what they carry in embedded archives (a recovery list of
    // stored creatures, for example) keeps its owners.
    const kind = !h.isItem && h.names.length > 1 ? 'component' : classify(ed, i, props);
    const player = owner.team !== null && owner.team >= PLAYER_TEAM;
    // PrimalBuffPersistentData carries the item flag in real saves, but belongs to a buff.
    const skip = kind === 'component' ? 'components' : findProperty(props, 'ForPrimalBuffClass') ? 'buffData'
      : kind === 'dino' && !player ? 'wildCreatures' : kind === 'actor' || (kind === 'pawn' && !player) ? 'actors' : null;
    if (skip) {
      notRefunded[skip]++;
      refunds.push(...embeddedRefunds(props, owner, h.cls, at));
      continue;
    }
    const holder = h.isItem ? (a === null ? 'loose' : ed.cls(a)) : '';
    const inLost = h.isItem && a !== null && a !== i && lostSet.has(a);
    refunds.push({
      team: owner.team, tribeName: owner.name, reason: inLost ? 'content' : 'lost', kind, cls: h.cls,
      blueprint: prop(props, 'bIsBlueprint') === true, quantity: h.isItem ? quantityOf(props) : 1, holder,
      at: at ? { x: at.x, y: at.y, z: at.z } : null,
    });
    refunds.push(...embeddedRefunds(props, owner, h.isItem ? `${h.cls} in ${holder}` : h.cls, at));
  }

  const classes = [...rows.values()].filter((r) => r.lost || r.gained)
    .sort((a, b) => b.extra - a.extra || b.lost - a.lost || b.gained - a.gained || (a.cls < b.cls ? -1 : 1));
  const sum = (f: (r: ClassDiff) => number): number => classes.reduce((n, r) => n + f(r), 0);
  return {
    report: {
      baseline: baselineLost !== undefined,
      objects: { before: objects, after: after.objects },
      recipesLeftOut: { before: recipes, after: after.recipes },
      compared: { before: seen.size, after: after.keys.size, matched },
      lost: sum((r) => r.lost), baselineLost: sum((r) => r.baselineLost), extra: sum((r) => r.extra), gained: sum((r) => r.gained),
      classChanged: Object.fromEntries([...classChanged].sort((a, b) => b[1] - a[1])),
      notRefunded,
      classes,
    },
    refunds,
  };
}

/** Numbers of the extra loss for a quick look: objects and summed quantity per class. */
export function extraByClass(refunds: RefundEntry[]): Record<string, { objects: number; quantity: number }> {
  const m = new Map<string, { objects: number; quantity: number }>();
  for (const e of refunds) {
    const r = m.get(e.cls) ?? { objects: 0, quantity: 0 };
    r.objects++;
    r.quantity += e.quantity;
    m.set(e.cls, r);
  }
  return Object.fromEntries([...m].sort((a, b) => b[1].objects - a[1].objects));
}
