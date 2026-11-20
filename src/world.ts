// What is what in a .ark save, for the editing operations: kinds of objects, ownership (components,
// inventories, items), selections by tribe, owner, area and class.
import type { SaveEditor, Transform } from './editor.ts';
import { findProperty, type Property, type TreeValue } from './tree.ts';

export type Kind = 'structure' | 'dino' | 'pawn' | 'item' | 'component' | 'actor';

export interface Vec3 { x: number; y: number; z: number; }

export interface Entry {
  index: number;
  kind: Kind;
  cls: string;
  name: string;
  location: Transform | null;
  /** TargetingTeam: tribe id, or the player id for solo players. */
  team: number | null;
  /** OwnerName (structures) or TribeName (dinos). */
  ownerName: string | null;
  /** OwningPlayerID, if set. */
  playerId: number | null;
}

/** Value of a property (first static-array element unless index is given). */
export function prop(list: Property[], name: string, index = 0): TreeValue | undefined {
  return findProperty(list, name, index)?.value;
}

export function numberProp(list: Property[], name: string): number | null {
  const v = prop(list, name);
  return typeof v === 'number' ? v : null;
}

export function stringProp(list: Property[], name: string): string | null {
  const v = prop(list, name);
  return typeof v === 'string' ? v : null;
}

/** Kind of an object from its header and, for actors with a location, its properties. */
export function classify(ed: SaveEditor, i: number, props?: Property[]): Kind {
  const h = ed.header(i);
  if (h.isItem) return 'item';
  if (h.names.length > 1) return 'component';
  if (!h.location) return 'actor';
  const p = props ?? ed.props(i);
  if (findProperty(p, 'DinoID1')) return 'dino';
  if (findProperty(p, 'LinkedPlayerDataID')) return 'pawn';
  // Structures carry health and the decay time stamp; weapons, buffs and dropped items do not.
  if (findProperty(p, 'TargetingTeam') && (findProperty(p, 'MaxHealth') || findProperty(p, 'LastInAllyRangeTime'))) return 'structure';
  return 'actor';
}

/**
 * Index of all actors with a location (structures, dinos, player characters, other actors).
 * Items and components are left out: they move, vanish and get copied with their owner.
 */
export function indexWorld(ed: SaveEditor): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < ed.size; i++) {
    if (!ed.exists(i)) continue;
    const h = ed.header(i);
    if (h.isItem || h.names.length > 1 || !h.location) continue;
    const props = ed.props(i);
    const kind = classify(ed, i, props);
    out.push({
      index: i, kind, cls: h.cls, name: h.names[0] ?? '', location: h.location,
      team: numberProp(props, 'TargetingTeam'),
      ownerName: stringProp(props, kind === 'dino' ? 'TribeName' : 'OwnerName') ?? stringProp(props, 'OwningPlayerName'),
      playerId: numberProp(props, 'OwningPlayerID'),
    });
  }
  return out;
}

export interface Box { min: Vec3; max: Vec3; }
/** Sphere, or a vertical cylinder when z is omitted. */
export interface Radius { x: number; y: number; z?: number; r: number; }

export interface Selection {
  tribe?: number;
  /** OwnerName / TribeName / OwningPlayerName, exact match (case-insensitive). */
  owner?: string;
  box?: Box;
  radius?: Radius;
  /** Class names; a pattern with * matches any text. */
  classes?: string[];
  /** Kinds to select; default structures only. */
  kinds?: Kind[];
}

export function classMatcher(patterns: string[] | undefined): (cls: string) => boolean {
  if (!patterns || patterns.length === 0) return () => true;
  const res = patterns.map((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i'));
  return (cls) => res.some((r) => r.test(cls));
}

export function inArea(loc: Vec3, sel: Pick<Selection, 'box' | 'radius'>): boolean {
  if (sel.box) {
    const { min, max } = sel.box;
    if (loc.x < min.x || loc.x > max.x || loc.y < min.y || loc.y > max.y || loc.z < min.z || loc.z > max.z) return false;
  }
  if (sel.radius) {
    const r = sel.radius;
    const dz = r.z === undefined ? 0 : loc.z - r.z;
    if ((loc.x - r.x) ** 2 + (loc.y - r.y) ** 2 + dz ** 2 > r.r ** 2) return false;
  }
  return true;
}

export function select(entries: Entry[], sel: Selection): Entry[] {
  const kinds = new Set(sel.kinds ?? ['structure']);
  const cls = classMatcher(sel.classes);
  const owner = sel.owner?.toLowerCase();
  return entries.filter((e) => kinds.has(e.kind)
    && (sel.tribe === undefined || e.team === sel.tribe)
    && (owner === undefined || e.ownerName?.toLowerCase() === owner)
    && cls(e.cls)
    && (!e.location || inArea(e.location, sel)));
}

/**
 * Everything that belongs to the given actors: their components (inventory, status, painting, found
 * through references or through the outer name), the items in those inventories, and recursively
 * what those own. Returns the roots too.
 */
export function ownedClosure(ed: SaveEditor, roots: Iterable<number>, opts: { items?: boolean } = {}): Set<number> {
  const items = opts.items !== false;
  const out = new Set<number>();
  const byOuter = componentsByOuter(ed);
  const stack = [...roots];
  while (stack.length) {
    const i = stack.pop()!;
    if (out.has(i) || !ed.exists(i)) continue;
    out.add(i);
    const h = ed.header(i);
    const self = h.names[0];
    for (const t of ed.refs(i)) {
      if (out.has(t) || !ed.exists(t)) continue;
      const th = ed.header(t);
      if (th.names.length > 1 && th.names[1] === self && h.names.length === 1) stack.push(t);
      else if (items && th.isItem && h.names.length > 1) stack.push(t); // items of an inventory component
    }
    if (h.names.length === 1) for (const c of byOuter.get(self) ?? []) if (!out.has(c)) stack.push(c);
  }
  return out;
}

const outerCache = new WeakMap<SaveEditor, { size: number; map: Map<string, number[]> }>();

/** Components by the name of their actor, only for actor names that occur once in the save. */
function componentsByOuter(ed: SaveEditor): Map<string, number[]> {
  const cached = outerCache.get(ed);
  if (cached && cached.size === ed.size) return cached.map;
  const actors = new Map<string, number>();
  const comps = new Map<string, number[]>();
  for (let i = 0; i < ed.size; i++) {
    if (!ed.exists(i)) continue;
    const n = ed.header(i).names;
    if (n.length === 1) actors.set(n[0], (actors.get(n[0]) ?? 0) + 1);
    else if (n.length === 2) (comps.get(n[1]) ?? comps.set(n[1], []).get(n[1])!).push(i);
  }
  for (const [name, n] of actors) if (n !== 1) comps.delete(name);
  outerCache.set(ed, { size: ed.size, map: comps });
  return comps;
}

/** Objects that reference any of the targets, with the editor's reference scanner. */
export function referrers(ed: SaveEditor, targets: Set<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < ed.size; i++) {
    if (!ed.exists(i) || targets.has(i)) continue;
    if (ed.refs(i).some((t) => targets.has(t))) out.push(i);
  }
  return out;
}

export function bounds(points: Vec3[]): Box | null {
  if (points.length === 0) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
  }
  return { min, max };
}
