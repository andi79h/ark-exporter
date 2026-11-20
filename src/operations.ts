// Editing operations on a .ark save: delete, refresh decay timers, empty inventories, move and rotate,
// copy. Every operation works on the SaveEditor and leaves writing to the caller.
import type { SaveEditor, SaveObject, Transform } from './editor.ts';
import { cloneProperty, findProperty, forEachRef, isNativeStruct, type NativeValue, type Property, remapRefs, type TreeValue } from './tree.ts';
import { classify, numberProp, ownedClosure, prop, referrers, type Vec3 } from './world.ts';

// ---------------------------------------------------------------- delete

export interface DeleteResult {
  /** Objects removed: the roots plus components and items they own. */
  removed: number;
  /** Objects outside the set whose references were cleaned (removed from arrays, single ones set to none). */
  cleaned: number;
  /**
   * Remaining structures that stood on, hung on or were snapped to a removed one. The game checks
   * their support when it loads the save and may let them collapse (seen in a test: a wall next to
   * a removed wall section was gone after the next save).
   */
  mayCollapse: { index: number; cls: string; name: string; via: string[] }[];
}

/** References that carry weight: what a structure stands on or is snapped to. */
const SUPPORT = new Set(['PlacedOnFloorStructure', 'PrimarySnappedStructureParent', 'LinkedStructures', 'SaddleDino']);

export function deleteObjects(ed: SaveEditor, roots: Iterable<number>, opts: { items?: boolean } = {}): DeleteResult {
  const gone = ownedClosure(ed, roots, opts);
  const { cleaned, mayCollapse } = dropReferences(ed, gone);
  for (const i of gone) ed.remove(i);
  return { removed: gone.size, cleaned, mayCollapse };
}

/** Removes references to the given objects from everything else (arrays shrink, single references become none). */
function dropReferences(ed: SaveEditor, targets: Set<number>): { cleaned: number; mayCollapse: DeleteResult['mayCollapse'] } {
  const users = referrers(ed, targets);
  const mayCollapse: DeleteResult['mayCollapse'] = [];
  for (const i of users) {
    const o = ed.edit(i);
    const via = new Set<string>();
    forEachRef(o.props, (s) => { if (targets.has(s.index) && SUPPORT.has(s.path[0])) via.add(s.path[0]); });
    if (via.size && o.location && o.names.length === 1) mayCollapse.push({ index: i, cls: o.cls, name: o.names[0], via: [...via] });
    remapRefs(o.props, (t) => (targets.has(t) ? -1 : t), true);
  }
  return { cleaned: users.length, mayCollapse };
}

// ---------------------------------------------------------------- decay

export interface DecayResult { updated: number; added: number; gameTime: number; newTime: number; }

/**
 * Structures decay when (game time - LastInAllyRangeTime) exceeds the decay period of their tier.
 * Setting LastInAllyRangeTime to the time of the save restarts the period as if a tribe member had
 * just been near. extraSeconds moves the time stamp further into the future (more protection; the
 * game resets it as soon as a tribe member comes by again).
 */
export function refreshDecay(ed: SaveEditor, structures: Iterable<number>, opts: { extraSeconds?: number } = {}): DecayResult {
  const newTime = ed.gameTime + (opts.extraSeconds ?? 0);
  let updated = 0;
  let added = 0;
  for (const i of structures) {
    const o = ed.edit(i);
    const p = findProperty(o.props, 'LastInAllyRangeTime');
    if (p && p.type === 'DoubleProperty') {
      p.value = newTime;
    } else {
      o.props.push({ name: 'LastInAllyRangeTime', type: 'DoubleProperty', index: 0, value: newTime });
      added++;
    }
    updated++;
  }
  return { updated, added, gameTime: ed.gameTime, newTime };
}

// ---------------------------------------------------------------- inventories

export interface ClearResult { inventories: number; items: number; kept: number; }

const INVENTORY_LISTS = ['InventoryItems', 'EquippedItems', 'ItemSlots'] as const;

/** Inventory components of an actor (MyInventoryComponent). */
export function inventoriesOf(ed: SaveEditor, actor: number): number[] {
  const out: number[] = [];
  const v = prop(ed.props(actor), 'MyInventoryComponent');
  if (v && typeof v === 'object' && 'index' in v && typeof v.index === 'number' && ed.exists(v.index)) out.push(v.index);
  return out;
}

/**
 * Removes the items of the actors' inventories. Engrams (blueprint recipes of crafting stations) stay
 * unless keepEngrams is false; equipped items and slots only with equipped: true.
 */
export function clearInventories(ed: SaveEditor, actors: Iterable<number>, opts: { keepEngrams?: boolean; equipped?: boolean } = {}): ClearResult {
  const keepEngrams = opts.keepEngrams !== false;
  const lists = opts.equipped ? INVENTORY_LISTS : (['InventoryItems'] as const);
  const items = new Set<number>();
  let inventories = 0;
  let kept = 0;
  for (const a of actors) {
    for (const inv of inventoriesOf(ed, a)) {
      inventories++;
      for (const list of lists) {
        const v = prop(ed.props(inv), list);
        if (!Array.isArray(v)) continue;
        for (const e of v) {
          if (!e || typeof e !== 'object' || !('index' in e) || typeof e.index !== 'number' || !ed.exists(e.index)) continue;
          if (keepEngrams && prop(ed.props(e.index), 'bIsEngram') === true) { kept++; continue; }
          items.add(e.index);
        }
      }
    }
  }
  const owners = [...actors];
  const r = deleteObjects(ed, items);
  for (const a of owners) syncItemCounts(ed, a);
  return { inventories, items: r.removed, kept };
}

/**
 * Containers keep counters next to their inventory: CurrentItemCount (stacks, shown as "12/350")
 * and, in Super Structures' dedicated storage, ResourceCount (pieces). They are set to what is left
 * so the container does not show or hand out items that are gone.
 */
export function syncItemCounts(ed: SaveEditor, actor: number): void {
  if (!ed.exists(actor)) return;
  const p = ed.props(actor);
  const hasStacks = findProperty(p, 'CurrentItemCount');
  const hasPieces = findProperty(p, 'ResourceCount');
  if (!hasStacks && !hasPieces) return;
  let stacks = 0;
  let pieces = 0;
  for (const inv of inventoriesOf(ed, actor)) {
    const v = prop(ed.props(inv), 'InventoryItems');
    if (!Array.isArray(v)) continue;
    for (const e of v) {
      if (!e || typeof e !== 'object' || !('index' in e) || typeof e.index !== 'number' || !ed.exists(e.index)) continue;
      const item = ed.props(e.index);
      if (prop(item, 'bIsEngram') === true) continue;
      stacks++;
      const q = prop(item, 'ItemQuantity');
      pieces += typeof q === 'number' ? q : 1;
    }
  }
  const o = ed.edit(actor);
  const s = findProperty(o.props, 'CurrentItemCount');
  if (s && typeof s.value === 'number') s.value = stacks;
  const r = findProperty(o.props, 'ResourceCount');
  if (r && typeof r.value === 'number') r.value = pieces;
}

// ---------------------------------------------------------------- move and rotate

export interface Placement {
  /** Translation after the rotation. */
  dx: number; dy: number; dz: number;
  /** Rotation around the vertical axis through pivot, degrees (positive = like yaw). */
  yaw: number;
  pivot: Vec3;
}

export function rotatePoint(p: Vec3, t: Placement): Vec3 {
  const r = (t.yaw * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const x = p.x - t.pivot.x;
  const y = p.y - t.pivot.y;
  return { x: t.pivot.x + x * c - y * s + t.dx, y: t.pivot.y + x * s + y * c + t.dy, z: p.z + t.dz };
}

export function normalizeYaw(yaw: number): number {
  let y = yaw % 360;
  if (y > 180) y -= 360;
  if (y <= -180) y += 360;
  return y;
}

export function placeTransform(loc: Transform, t: Placement): Transform {
  const p = rotatePoint(loc, t);
  return { ...loc, x: p.x, y: p.y, z: p.z, yaw: t.yaw ? normalizeYaw(loc.yaw + t.yaw) : loc.yaw };
}

/** Property names whose vectors are relative or not positions, never moved. */
const NOT_A_POSITION = /Relative|Offset|Scale|Velocity|Direction|Normal|Extent|Size|Color|Bone/i;
/** Vectors within this distance of the object itself are taken as world positions (pipe ends, landing spots). */
const WORLD_VECTOR_RANGE = 30_000;

/**
 * Moves world positions stored in properties: native Vector structs (also in arrays and nested lists)
 * close to the object's own position, unless the name says they are relative. Returns the names moved.
 */
export function moveWorldVectors(list: Property[], before: Vec3, t: Placement, moved: Map<string, number>): void {
  const near = (v: NativeValue): boolean => typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number'
    && Math.hypot(v.x - before.x, v.y - before.y, v.z - before.z) < WORLD_VECTOR_RANGE;
  const apply = (v: NativeValue): NativeValue => {
    const p = rotatePoint({ x: v.x as number, y: v.y as number, z: v.z as number }, t);
    return { ...v, x: p.x, y: p.y, z: p.z };
  };
  for (const p of list) {
    if (p.opaque || NOT_A_POSITION.test(p.name)) continue;
    if (p.type === 'StructProperty') {
      if (p.inner === 'Vector') {
        if (near(p.value as NativeValue)) { p.value = apply(p.value as NativeValue); moved.set(p.name, (moved.get(p.name) ?? 0) + 1); }
      } else if (!isNativeStruct(p.inner) && Array.isArray(p.value)) {
        moveWorldVectors(p.value as Property[], before, t, moved);
      }
    } else if (p.type === 'ArrayProperty' && p.inner === 'StructProperty' && Array.isArray(p.value)) {
      if (p.elementStruct === 'Vector') {
        const items = p.value as NativeValue[];
        if (items.length && items.every(near)) { p.value = items.map(apply); moved.set(p.name, (moved.get(p.name) ?? 0) + items.length); }
      } else if (!p.elementStruct) {
        for (const e of p.value as Property[][]) moveWorldVectors(e, before, t, moved);
      }
    }
  }
}

export interface MoveResult { moved: number; saddleStructures: number; vectors: Record<string, number>; }

/**
 * Moves actors (structures, dinos) and rotates them around the pivot. Structures standing on a moved
 * dino's platform saddle (SaddleDino) move with it. Components and items have no position of their own.
 */
export function moveObjects(ed: SaveEditor, actors: Iterable<number>, t: Placement): MoveResult {
  const set = new Set(actors);
  // Platform saddles: structures that reference a moved dino through SaddleDino.
  const dinos = new Set([...set].filter((i) => classify(ed, i) === 'dino'));
  let saddleStructures = 0;
  if (dinos.size) {
    for (const i of referrers(ed, dinos)) {
      const v = prop(ed.props(i), 'SaddleDino');
      if (v && typeof v === 'object' && 'index' in v && dinos.has(v.index as number) && !set.has(i)) { set.add(i); saddleStructures++; }
    }
  }
  const vectors = new Map<string, number>();
  let moved = 0;
  for (const i of set) {
    const h = ed.header(i);
    if (!h.location) continue;
    const o = ed.edit(i);
    const before = o.location!;
    moveWorldVectors(o.props, before, t, vectors);
    o.location = placeTransform(before, t);
    moved++;
  }
  return { moved, saddleStructures, vectors: Object.fromEntries(vectors) };
}

// ---------------------------------------------------------------- identities

const randomInt32 = (): number => (Math.random() * 0x1_0000_0000) | 0;

/** Existing ItemID pairs, DinoID pairs and BedIDs of the save, to hand out new ones without collision. */
export class Identities {
  private readonly items = new Set<string>();
  private readonly dinos = new Set<string>();
  private readonly beds = new Set<number>();
  private readonly names = new Map<string, number>();

  constructor(ed: SaveEditor) {
    for (let i = 0; i < ed.size; i++) {
      if (!ed.exists(i)) continue;
      const h = ed.header(i);
      if (h.names.length === 1) this.noteName(h.names[0]);
      if (h.names.length > 1) continue;
      if (h.isItem) {
        const id = prop(ed.props(i), 'ItemId');
        if (Array.isArray(id)) this.items.add(`${numberProp(id as Property[], 'ItemID1')}:${numberProp(id as Property[], 'ItemID2')}`);
      } else if (h.location) {
        const p = ed.props(i);
        const d1 = numberProp(p, 'DinoID1');
        if (d1 !== null) this.dinos.add(`${d1}:${numberProp(p, 'DinoID2')}`);
        const bed = numberProp(p, 'BedID');
        if (bed !== null) this.beds.add(bed);
      }
    }
  }

  private noteName(n: string): void {
    const m = /^(.*)_(\d+)$/.exec(n);
    const base = m ? m[1] : n;
    const num = m ? Number(m[2]) : -1;
    if ((this.names.get(base) ?? -1) < num) this.names.set(base, num);
  }

  /** A fresh object name like Wall_Wood_C_1234 (base = name without its number). */
  name(old: string): string {
    const m = /^(.*)_(\d+)$/.exec(old);
    const base = m ? m[1] : old;
    const next = (this.names.get(base) ?? -1) + 1;
    this.names.set(base, next);
    return `${base}_${next}`;
  }

  itemId(): [number, number] {
    for (;;) {
      const id: [number, number] = [randomInt32(), randomInt32()];
      const k = `${id[0]}:${id[1]}`;
      if (!this.items.has(k)) { this.items.add(k); return id; }
    }
  }

  dinoId(): [number, number] {
    for (;;) {
      const id: [number, number] = [randomInt32() & 0x7fffffff, randomInt32() & 0x7fffffff];
      const k = `${id[0]}:${id[1]}`;
      if (!this.dinos.has(k)) { this.dinos.add(k); return id; }
    }
  }

  bedId(): number {
    for (;;) {
      const id = randomInt32() & 0x7fffffff;
      if (id !== 0 && !this.beds.has(id)) { this.beds.add(id); return id; }
    }
  }
}

// ---------------------------------------------------------------- ownership

export interface Owner {
  /** TargetingTeam: tribe id (or player id for solo players). */
  team: number;
  /** OwnerName on structures / TribeName on dinos. */
  name?: string;
  /** OwningPlayerID / OwningPlayerName, set only where the object has them, unless force is set. */
  playerId?: number;
  playerName?: string;
}

function setProp(list: Property[], name: string, type: string, value: TreeValue, onlyIfPresent: boolean): void {
  const p = findProperty(list, name);
  if (p) { p.value = value; delete p.raw; delete p.rawValue; return; }
  if (!onlyIfPresent) list.push({ name, type, index: 0, value });
}

/** Hands an actor to another tribe or player. */
export function setOwner(o: SaveObject, owner: Owner, kind: string): void {
  const p = o.props;
  setProp(p, 'TargetingTeam', 'IntProperty', owner.team, false);
  if (owner.name !== undefined) setProp(p, kind === 'dino' ? 'TribeName' : 'OwnerName', 'StrProperty', owner.name, kind === 'dino');
  if (owner.playerId !== undefined) setProp(p, 'OwningPlayerID', 'IntProperty', owner.playerId, true);
  if (owner.playerName !== undefined) setProp(p, 'OwningPlayerName', 'StrProperty', owner.playerName, true);
}

/** Fresh IDs for a copied object: ItemId, DinoID1/2, BedID. */
export function renewIds(o: SaveObject, ids: Identities): void {
  const item = findProperty(o.props, 'ItemId');
  if (item && Array.isArray(item.value)) {
    const [a, b] = ids.itemId();
    const l = item.value as Property[];
    const p1 = findProperty(l, 'ItemID1');
    const p2 = findProperty(l, 'ItemID2');
    if (p1) { p1.value = a; delete p1.raw; delete p1.rawValue; }
    if (p2) { p2.value = b; delete p2.raw; delete p2.rawValue; }
  }
  const d1 = findProperty(o.props, 'DinoID1');
  const d2 = findProperty(o.props, 'DinoID2');
  if (d1 && d2) { const [a, b] = ids.dinoId(); d1.value = a; d2.value = b; }
  const bed = findProperty(o.props, 'BedID');
  if (bed && typeof bed.value === 'number') bed.value = ids.bedId();
}

export function cloneObject(o: SaveObject): SaveObject {
  return {
    ...o, guid: Buffer.from(o.guid), names: o.names.slice(), location: o.location ? { ...o.location } : null,
    props: o.props.map(cloneProperty), extra: Buffer.from(o.extra),
  };
}
