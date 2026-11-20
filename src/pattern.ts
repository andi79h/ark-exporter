// Building patterns: a group of structures (with components and, optionally, inventory contents) cut
// out of a save, stored as JSON with positions relative to an anchor, and placed again anywhere, in
// any save, rotated, for any tribe.
//
// What changes when a pattern is placed:
// - positions and yaw (also world positions in properties such as pipe connection points),
// - object names (fresh instance numbers; components follow their actor),
// - ItemId, DinoID1/2 and BedID (fresh, unique in the target save),
// - owner: TargetingTeam, OwnerName, OwningPlayerID/Name,
// - time stamps: stored relative to the source save and rebased onto the target's game time;
//   OriginalCreationTime and LastInAllyRangeTime become "now" (no decay right after placing),
// - references: within the pattern they are renumbered; references that left the pattern (a wall
//   linked to a neighbour that was not cut out, the player who placed it) were removed on export.
import type { SaveEditor, SaveObject, Transform } from './editor.ts';
import { forEachRef, isNativeStruct, type Property, remapRefs, type TreeValue } from './tree.ts';
import {
  cloneObject, Identities, moveWorldVectors, normalizeYaw, type Owner, type Placement, placeTransform, renewIds, setOwner,
} from './operations.ts';
import { bounds, type Box, classify, type Entry, indexWorld, type Kind, ownedClosure, type Vec3 } from './world.ts';

export const PATTERN_FORMAT = 'ark-ase-pattern';
export const PATTERN_VERSION = 1;

export interface PatternObject {
  /** Position in the pattern; references between pattern objects use it. */
  id: number;
  kind: Kind;
  cls: string;
  names: string[];
  isItem: number;
  guid: string;
  fromDataFile: number;
  dataFile: number;
  headerTail: number;
  /** Relative to the anchor, yaw relative to the anchor's yaw. */
  location: Transform | null;
  props: unknown[];
  extra: string;
}

export interface Pattern {
  format: typeof PATTERN_FORMAT;
  version: number;
  name: string;
  source: { map: string | null; gameTime: number; created: string };
  /** World position and yaw in the source save that is the pattern's origin. */
  anchor: { x: number; y: number; z: number; yaw: number };
  /** Bounding box of the actors, relative to the anchor (not rotated). */
  bounds: Box;
  counts: Record<string, number>;
  classes: Record<string, number>;
  /** Class paths of items (ItemArchetype); mod content shows up as /Game/Mods/<id>/... */
  itemArchetypes: string[];
  /** References that pointed outside the pattern and were removed, by property name. */
  droppedRefs: Record<string, number>;
  /** Items holding embedded creatures (cryopods): placing the pattern twice duplicates those creatures. */
  embeddedCreatures: number;
  objects: PatternObject[];
}

// ---------------------------------------------------------------- tree <-> JSON

/** Property trees as JSON: 64-bit ints and special floats get markers, bytes become base64. */
export function treeToJson(list: Property[]): unknown[] {
  return list.map((p) => {
    const out: Record<string, unknown> = { name: p.name, type: p.type };
    if (p.index) out.index = p.index;
    if (p.inner !== undefined) out.inner = p.inner;
    if (p.elementStruct) out.elementStruct = p.elementStruct;
    if (p.opaque) out.opaque = true;
    out.value = valueToJson(p.value, p);
    return out;
  });
}

function numberToJson(v: number): unknown {
  return Number.isFinite(v) && !Object.is(v, -0) ? v : { $f: Object.is(v, -0) ? '-0' : String(v) };
}

function valueToJson(v: TreeValue, p: Property): unknown {
  if (typeof v === 'bigint') return { $i64: v.toString() };
  if (typeof v === 'number') return numberToJson(v);
  if (Buffer.isBuffer(v)) return { $bytes: v.toString('base64') };
  if (Array.isArray(v)) {
    const structList = p.type === 'StructProperty' && !isNativeStruct(p.inner);
    if (structList) return treeToJson(v as Property[]);
    if (p.type === 'ArrayProperty' && p.inner === 'StructProperty' && !p.elementStruct) return (v as Property[][]).map(treeToJson);
    return v.map((e) => valueToJson(e as TreeValue, { ...p, type: p.inner ?? p.type }));
  }
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = typeof x === 'number' ? numberToJson(x) : x;
    return out;
  }
  return v;
}

export function jsonToTree(list: unknown[]): Property[] {
  return list.map((x) => {
    const j = x as Record<string, unknown>;
    const p: Property = { name: String(j.name), type: String(j.type), index: Number(j.index ?? 0), value: null };
    if (j.inner !== undefined) p.inner = j.inner as string | null;
    if (j.elementStruct) p.elementStruct = String(j.elementStruct);
    if (j.opaque) p.opaque = true;
    p.value = jsonToValue(j.value, p);
    return p;
  });
}

function jsonToValue(v: unknown, p: Property): TreeValue {
  if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (p.type === 'StructProperty' && !isNativeStruct(p.inner)) return jsonToTree(v);
    if (p.type === 'ArrayProperty' && p.inner === 'StructProperty' && !p.elementStruct) return v.map((e) => jsonToTree(e as unknown[]));
    return v.map((e) => jsonToValue(e, { ...p, type: p.inner ?? p.type }));
  }
  const o = v as Record<string, unknown>;
  if ('$i64' in o) return BigInt(String(o.$i64));
  if ('$bytes' in o) return Buffer.from(String(o.$bytes), 'base64');
  if ('$f' in o) return o.$f === '-0' ? -0 : Number(o.$f);
  const out: Record<string, TreeValue> = {};
  for (const [k, x] of Object.entries(o)) {
    out[k] = x !== null && typeof x === 'object' && '$f' in (x as object) ? jsonToValue(x, p) as number : x as TreeValue;
  }
  return out as TreeValue;
}

// ---------------------------------------------------------------- export

export interface ExportOptions {
  name?: string;
  /** Origin of the pattern; default: center of the actors' bounding box at its lowest z. */
  anchor?: { x: number; y: number; z: number; yaw?: number };
  /** Include inventory contents (default: no, the pattern holds the empty buildings). */
  items?: boolean;
  map?: string | null;
}

/** Double properties named ...Time that hold game time stamps; stored relative to the save's game time. */
function isTimeStamp(p: Property): boolean {
  return p.type === 'DoubleProperty' && /Time$/.test(p.name) && typeof p.value === 'number' && p.value > 0;
}

function shiftTimes(list: Property[], delta: number): void {
  for (const p of list) {
    if (p.opaque) continue;
    if (isTimeStamp(p)) { p.value = (p.value as number) + delta; delete p.raw; delete p.rawValue; continue; }
    if (p.type === 'StructProperty' && !isNativeStruct(p.inner) && Array.isArray(p.value)) shiftTimes(p.value as Property[], delta);
    if (p.type === 'ArrayProperty' && p.inner === 'StructProperty' && !p.elementStruct && Array.isArray(p.value)) {
      for (const e of p.value as Property[][]) shiftTimes(e, delta);
    }
  }
}

function countEmbedded(list: Property[]): number {
  let n = 0;
  for (const p of list) {
    if (p.opaque) continue;
    if (p.type === 'ArrayProperty' && Buffer.isBuffer(p.value) && p.value.length >= 40) {
      const c = p.value.readInt32LE(0);
      if (c > 0 && c <= 10_000) n++;
    }
    if (p.type === 'StructProperty' && !isNativeStruct(p.inner) && Array.isArray(p.value)) n += countEmbedded(p.value as Property[]);
    if (p.type === 'ArrayProperty' && p.inner === 'StructProperty' && !p.elementStruct && Array.isArray(p.value)) {
      for (const e of p.value as Property[][]) n += countEmbedded(e);
    }
  }
  return n;
}

/** Cuts the actors (and what they own) out of the save as a pattern. The save is not changed. */
export function exportPattern(ed: SaveEditor, actors: number[], opts: ExportOptions = {}): Pattern {
  if (actors.length === 0) throw new Error('nothing selected');
  const set = ownedClosure(ed, actors, { items: opts.items === true });
  const ids = [...set].sort((a, b) => a - b);
  const local = new Map(ids.map((i, k) => [i, k]));
  const objects = ids.map((i) => cloneObject(ed.get(i)));

  const points = objects.filter((o) => o.location).map((o) => o.location!);
  const b = bounds(points)!;
  const a = opts.anchor ?? { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.min.z };
  const anchor = { x: a.x, y: a.y, z: a.z, yaw: a.yaw ?? 0 };
  const toLocal: Placement = { dx: -anchor.x, dy: -anchor.y, dz: -anchor.z, yaw: -anchor.yaw, pivot: { x: anchor.x, y: anchor.y, z: 0 } };
  // rotatePoint rotates around the pivot first and then translates, so pivot = anchor and the
  // translation by -anchor puts the anchor at the origin.

  const dropped = new Map<string, number>();
  const classes: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const archetypes = new Set<string>();
  let embeddedCreatures = 0;
  const out: PatternObject[] = objects.map((o, k) => {
    const i = ids[k];
    const kind = classify(ed, i);
    counts[kind] = (counts[kind] ?? 0) + 1;
    classes[o.cls] = (classes[o.cls] ?? 0) + 1;
    forEachRef(o.props, (s) => {
      if (s.index !== -1 && !local.has(s.index)) dropped.set(s.path.join('.'), (dropped.get(s.path.join('.')) ?? 0) + 1);
    });
    remapRefs(o.props, (t) => local.get(t) ?? -1, true);
    if (o.isItem) {
      const at = o.props.find((p) => p.name === 'ItemArchetype');
      if (at && at.value && typeof at.value === 'object' && 'path' in at.value && at.value.path) archetypes.add(String(at.value.path));
      embeddedCreatures += countEmbedded(o.props);
    }
    if (o.location) {
      moveWorldVectors(o.props, o.location, toLocal, new Map());
      o.location = placeTransform(o.location, toLocal);
    }
    shiftTimes(o.props, -ed.gameTime);
    return {
      id: k, kind, cls: o.cls, names: o.names, isItem: o.isItem, guid: o.guid.toString('hex'), fromDataFile: o.fromDataFile,
      dataFile: o.dataFile, headerTail: o.headerTail, location: o.location, props: treeToJson(o.props), extra: o.extra.toString('base64'),
    };
  });
  const rel = bounds(out.filter((o) => o.location && o.kind !== 'item' && o.kind !== 'component').map((o) => o.location!))!;
  return {
    format: PATTERN_FORMAT, version: PATTERN_VERSION, name: opts.name ?? 'pattern',
    source: { map: opts.map ?? null, gameTime: ed.gameTime, created: new Date().toISOString() },
    anchor, bounds: rel, counts, classes, itemArchetypes: [...archetypes].sort(),
    droppedRefs: Object.fromEntries(dropped), embeddedCreatures, objects: out,
  };
}

export function parsePattern(text: string): Pattern {
  const p = JSON.parse(text) as Pattern;
  if (p.format !== PATTERN_FORMAT) throw new Error(`not a pattern file (format ${String(p.format)})`);
  if (p.version !== PATTERN_VERSION) throw new Error(`pattern version ${p.version} is not supported`);
  return p;
}

// ---------------------------------------------------------------- placing

export interface PlaceOptions {
  /** Where the anchor goes, and the yaw of the pattern there. */
  at: { x: number; y: number; z: number; yaw?: number };
  owner: Owner;
  /** Place even when the checks found blocking problems. */
  force?: boolean;
  /** Extra free space around the pattern for the overlap check (units; 100 = 1 m). */
  margin?: number;
  /** Structures allowed within limitRadius of the anchor after placing (the game's TheMaxStructuresInRange). */
  limit?: number;
  limitRadius?: number;
}

export interface PlaceCheck {
  /** Problems that stop placing unless forced. */
  blocking: string[];
  warnings: string[];
  /** Target area (world coordinates, axis-aligned around the rotated pattern). */
  area: Box;
  /** Existing actors in the target area. */
  overlapping: { index: number; kind: Kind; cls: string; team: number | null }[];
  /** Height of existing actors around the target, a hint for the ground level (no terrain data in the save). */
  nearbyZ: { min: number; max: number; count: number } | null;
  structuresInRange: number;
  unknownClasses: string[];
}

function placement(p: Pattern, at: PlaceOptions['at']): Placement {
  return { dx: at.x, dy: at.y, dz: at.z, yaw: at.yaw ?? 0, pivot: { x: 0, y: 0, z: 0 } };
}

function placedArea(p: Pattern, t: Placement, margin: number): Box {
  const { min, max } = p.bounds;
  const corners: Vec3[] = [];
  for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
    const q = placeTransform({ x, y, z, pitch: 0, yaw: 0, roll: 0 }, t);
    corners.push(q);
  }
  const b = bounds(corners)!;
  return {
    min: { x: b.min.x - margin, y: b.min.y - margin, z: b.min.z - margin },
    max: { x: b.max.x + margin, y: b.max.y + margin, z: b.max.z + margin },
  };
}

/** What would happen if the pattern were placed: overlap, unknown classes, structure limit. */
export function checkPlacement(ed: SaveEditor, p: Pattern, opts: PlaceOptions, world?: Entry[]): PlaceCheck {
  const entries = world ?? indexWorld(ed);
  const t = placement(p, opts.at);
  const area = placedArea(p, t, opts.margin ?? 100);
  const blocking: string[] = [];
  const warnings: string[] = [];
  const overlapping: PlaceCheck['overlapping'] = [];
  const near: number[] = [];
  const limitRadius = opts.limitRadius ?? 10_000;
  let structuresInRange = 0;
  const known = new Set<string>();
  for (let i = 0; i < ed.size; i++) if (ed.exists(i)) known.add(ed.cls(i));
  for (const e of entries) {
    const l = e.location!;
    const inside = l.x >= area.min.x && l.x <= area.max.x && l.y >= area.min.y && l.y <= area.max.y && l.z >= area.min.z && l.z <= area.max.z;
    if (inside && (e.kind === 'structure' || e.kind === 'dino' || e.kind === 'pawn')) overlapping.push({ index: e.index, kind: e.kind, cls: e.cls, team: e.team });
    const d = Math.hypot(l.x - opts.at.x, l.y - opts.at.y);
    if (d < 5_000 && Math.abs(l.z - opts.at.z) < 5_000 && e.kind !== 'item') near.push(l.z);
    if (e.kind === 'structure' && Math.hypot(d, l.z - opts.at.z) < limitRadius) structuresInRange++;
  }
  if (overlapping.length) blocking.push(`${overlapping.length} existing structures/creatures/players inside the target area`);
  const unknownClasses = Object.keys(p.classes).filter((c) => !known.has(c));
  if (unknownClasses.length) {
    warnings.push(`classes not used in the target save yet (fine for vanilla parts; for mod parts the mod must be installed there): ${unknownClasses.join(', ')}`);
  }
  const mods = p.itemArchetypes.filter((a) => a.includes('/Game/Mods/'));
  if (mods.length) warnings.push(`items from mods: ${mods.length} archetypes under /Game/Mods/ (the target map needs these mods)`);
  const placed = (p.counts.structure ?? 0) + structuresInRange;
  if (opts.limit !== undefined && placed > opts.limit) blocking.push(`${placed} structures within ${limitRadius} units after placing, limit ${opts.limit}`);
  if (p.embeddedCreatures) warnings.push(`${p.embeddedCreatures} items hold creatures (cryopods): every placement duplicates them`);
  warnings.push('the save has no terrain data: check the ground in game (floating or buried foundations)');
  const nearbyZ = near.length ? { min: Math.min(...near), max: Math.max(...near), count: near.length } : null;
  return { blocking, warnings, area, overlapping, nearbyZ, structuresInRange, unknownClasses };
}

export interface PlaceResult extends PlaceCheck {
  /** Editor indices of the new objects, in pattern order. */
  indices: number[];
}

/** Places a pattern into the save. Throws on blocking problems unless forced. */
export function placePattern(ed: SaveEditor, p: Pattern, opts: PlaceOptions, ids = new Identities(ed)): PlaceResult {
  const check = checkPlacement(ed, p, opts);
  if (check.blocking.length && !opts.force) {
    throw new Error(`pattern not placed: ${check.blocking.join('; ')} (--force places it anyway)`);
  }
  const t = placement(p, opts.at);
  const base = ed.size;
  const renamed = new Map<string, string>();
  const objects: SaveObject[] = p.objects.map((po) => ({
    guid: Buffer.from(po.guid, 'hex'), cls: po.cls, isItem: po.isItem, names: po.names.slice(), fromDataFile: po.fromDataFile,
    dataFile: po.dataFile, location: po.location ? { ...po.location } : null, headerTail: po.headerTail,
    props: jsonToTree(po.props), extra: Buffer.from(po.extra, 'base64'),
  }));
  // Names first: components refer to their actor by name.
  for (const o of objects) {
    if (o.names.length === 1) {
      const fresh = ids.name(o.names[0]);
      renamed.set(o.names[0], fresh);
      o.names[0] = fresh;
    }
  }
  for (let k = 0; k < objects.length; k++) {
    const o = objects[k];
    const kind = p.objects[k].kind;
    if (o.names.length > 1) o.names[1] = renamed.get(o.names[1]) ?? o.names[1];
    remapRefs(o.props, (local) => {
      if (local < 0 || local >= objects.length) throw new RangeError(`pattern reference ${local} outside the pattern`);
      return base + local;
    });
    shiftTimes(o.props, ed.gameTime);
    for (const name of ['OriginalCreationTime', 'LastInAllyRangeTime']) {
      const tp = o.props.find((x) => x.name === name && x.type === 'DoubleProperty');
      if (tp) tp.value = ed.gameTime;
    }
    renewIds(o, ids);
    if (kind === 'structure' || kind === 'dino') setOwner(o, opts.owner, kind);
    if (o.location) {
      moveWorldVectors(o.props, o.location, t, new Map());
      o.location = placeTransform(o.location, t);
      o.location.yaw = normalizeYaw(o.location.yaw);
    }
  }
  const indices = objects.map((o) => ed.add(o));
  return { ...check, indices };
}

/** Copies actors within the same save (pattern export and placement in one step). */
export function copyObjects(ed: SaveEditor, actors: number[], opts: Omit<PlaceOptions, 'at'> & { by: Placement; items?: boolean }): PlaceResult {
  const pattern = exportPattern(ed, actors, { items: opts.items, anchor: { x: opts.by.pivot.x, y: opts.by.pivot.y, z: opts.by.pivot.z } });
  const at = { x: opts.by.pivot.x + opts.by.dx, y: opts.by.pivot.y + opts.by.dy, z: opts.by.pivot.z + opts.by.dz, yaw: opts.by.yaw };
  return placePattern(ed, pattern, { ...opts, at });
}
