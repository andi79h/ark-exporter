// Object table entries and their property lists, shared by .ark files and the smaller containers
// (.arkprofile, .arktribe, cryopod contents).
import { Archive } from './archive.ts';
import { readProperties } from './properties.ts';
import { Blob, Embedded, type GameObject, ObjectRef, type Props, ReadContext, type Value } from './types.ts';

function isZero(b: Buffer): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

/** GUID, class, isItem, names, fromDataFile, dataFileIndex, [location], propertiesOffset, 0. */
export function readObjectHeader(a: Archive, index: number, ctx: ReadContext): GameObject {
  const guid = a.bytes(16);
  const cls = a.name() ?? '';
  const isItem = a.bool();
  const nameCount = a.i32();
  if (nameCount < 0 || nameCount > 64) throw new RangeError(`object ${index} has ${nameCount} names`);
  const names: string[] = new Array(nameCount);
  for (let k = 0; k < nameCount; k++) names[k] = a.name() ?? '';
  const fromDataFile = a.bool();
  const dataFile = a.i32();
  const loc = a.bool()
    ? { x: a.f32(), y: a.f32(), z: a.f32(), pitch: a.f32(), yaw: a.f32(), roll: a.f32() }
    : null;
  const propOffset = a.i32();
  if (a.i32() !== 0) ctx.note('object header: non-zero value after property offset');
  return {
    index, guid: isZero(guid) ? null : guid.toString('hex'), cls, isItem, names, fromDataFile, dataFile,
    loc, propOffset, props: {}, extra: undefined, error: undefined,
  };
}

export interface PropertyCoverage {
  /** Bytes consumed by property lists. */
  properties: number;
  /** Bytes after property lists that were decoded (foliage, known terminators). */
  extraDecoded: number;
  /** Bytes after property lists that were kept raw. */
  extraRaw: number;
  /** Bytes of objects whose property list failed. */
  failed: number;
}

/** InstancedFoliageActor: 0, then a list of maps from foliage type to a property list. */
function readFoliage(a: Archive, end: number, ctx: ReadContext): Value {
  if (a.i32() !== 0) throw new RangeError('foliage data does not start with 0');
  const maps: Value[] = [];
  for (let m = a.i32(); m > 0; m--) {
    const map: { [key: string]: Value } = {};
    for (let n = a.i32(); n > 0; n--) {
      const key = a.string();
      if (!key) continue;
      map[key] = readProperties(a, ctx);
      if (a.i32() !== 0) throw new RangeError('foliage entry not terminated by 0');
    }
    maps.push(map);
  }
  if (a.pos !== end) throw new RangeError(`foliage data ends at ${a.pos}, expected ${end}`);
  return { foliage: maps };
}

/**
 * Player characters: int32, int32, then two arrays of vectors (19 each in the saves examined). The meaning
 * is not documented; the vectors look like recent world positions.
 */
function readPawnVectors(a: Archive, end: number): Value {
  const head = [a.i32(), a.i32()];
  const lists: Value[] = [];
  while (a.pos < end) {
    const n = a.i32();
    if (n < 0 || a.pos + n * 12 > end) throw new RangeError('vector list overruns');
    const list: Value[] = [];
    for (let i = 0; i < n; i++) list.push({ x: a.f32(), y: a.f32(), z: a.f32() });
    lists.push(list);
  }
  return { head, vectors: lists };
}

/** Interprets the bytes between the end of an object's property list and the start of the next one. */
function readExtra(o: GameObject, a: Archive, end: number, ctx: ReadContext, cov: PropertyCoverage): void {
  const start = a.pos;
  const len = end - start;
  if (len === 4 && a.dv.getInt32(start, true) === 0) {
    cov.extraDecoded += 4; // plain terminator, carries no information
    return;
  }
  if (len === 8 && a.dv.getInt32(start, true) === 0 && a.dv.getInt32(start + 4, true) === 1) {
    cov.extraDecoded += 8; // characters and vehicles end with 0, 1
    return;
  }
  if (o.cls.startsWith('PlayerPawn')) {
    try {
      o.extra = readPawnVectors(a, end);
      cov.extraDecoded += len;
      return;
    } catch (e) {
      ctx.note(`player data after properties unreadable: ${(e as Error).message}`);
      a.pos = start;
    }
  }
  if (o.cls === 'InstancedFoliageActor') {
    try {
      o.extra = readFoliage(a, end, ctx);
      cov.extraDecoded += len;
      return;
    } catch (e) {
      ctx.note(`foliage data unreadable: ${(e as Error).message}`);
      a.pos = start;
    }
  }
  ctx.note(`raw data after properties (${o.cls})`);
  ctx.keepRaw(`after properties: ${o.cls}`, len);
  o.extra = new Blob(a.bytes(len), 'after properties');
  cov.extraRaw += len;
}

/**
 * Reads the property list of every object. Property lists are stored back to back in the order of
 * their offsets; the gap up to the next list is extra data.
 */
export function loadProperties(objects: GameObject[], a: Archive, blockStart: number, blockEnd: number, ctx: ReadContext): PropertyCoverage {
  const cov: PropertyCoverage = { properties: 0, extraDecoded: 0, extraRaw: 0, failed: 0 };
  const order = Array.from(objects.keys());
  let sorted = true;
  for (let i = 1; i < objects.length; i++) {
    if (objects[i].propOffset < objects[i - 1].propOffset) { sorted = false; break; }
  }
  if (!sorted) order.sort((x, y) => objects[x].propOffset - objects[y].propOffset);
  for (let k = 0; k < order.length; k++) {
    const o = objects[order[k]];
    const start = blockStart + o.propOffset;
    const next = k + 1 < order.length ? blockStart + objects[order[k + 1]].propOffset : blockEnd;
    a.pos = start;
    try {
      o.props = readProperties(a, ctx);
    } catch (e) {
      o.error = (e as Error).message;
      ctx.note('unreadable property list');
      ctx.keepRaw(`unreadable property list: ${o.cls}`, Math.max(0, next - start));
      o.props = {};
      o.extra = next > start ? new Blob(a.buf.subarray(start, next), 'unreadable property list') : undefined;
      cov.failed += Math.max(0, next - start);
      continue;
    }
    cov.properties += a.pos - start;
    if (a.pos < next) readExtra(o, a, next, ctx, cov);
    else if (a.pos > next) ctx.note('property list overlaps the next object');
  }
  return cov;
}

/**
 * A byte array holding a complete inline-named archive: int32 count, object headers, property lists
 * (offsets relative to the array). Cryopods, soul traps and vivariums store creatures this way.
 */
export function readEmbeddedArchive(bytes: Buffer, parent: ReadContext): Embedded | null {
  if (bytes.length < 40) return null;
  const count = bytes.readInt32LE(0);
  if (count <= 0 || count > 10_000) return null;
  const ctx = new ReadContext();
  ctx.decodeBytes = parent.decodeBytes;
  const a = new Archive(bytes, null, 4);
  const objects: GameObject[] = [];
  try {
    for (let i = 0; i < count; i++) objects.push(readObjectHeader(a, i, ctx));
    for (const o of objects) {
      if (o.propOffset < a.pos || o.propOffset >= bytes.length) return null;
    }
    const cov = loadProperties(objects, a, 0, bytes.length, ctx);
    if (cov.failed > 0) return null;
  } catch {
    return null;
  }
  for (const [k, v] of ctx.issues) parent.note(`embedded: ${k}`, v);
  for (const [k, v] of ctx.rawBytes) parent.keepRaw(`embedded: ${k}`, v);
  return new Embedded(objects);
}

/**
 * A byte array holding exactly one inline-named property list (e.g. the Dino Storage mod keeps the
 * soul trap item itself this way). Returns null unless the list ends exactly at the end of the array.
 */
export function readSerializedProperties(bytes: Buffer, parent: ReadContext): Value {
  if (bytes.length < 16) return null;
  const first = bytes.readInt32LE(0);
  if (first <= 1 || first > 256) return null;
  const ctx = new ReadContext();
  ctx.decodeBytes = parent.decodeBytes;
  const a = new Archive(bytes, null);
  let props: Props;
  try {
    props = readProperties(a, ctx);
  } catch {
    return null;
  }
  if (a.pos !== bytes.length) return null;
  for (const [k, v] of ctx.issues) parent.note(`serialized: ${k}`, v);
  for (const [k, v] of ctx.rawBytes) parent.keepRaw(`serialized: ${k}`, v);
  return { $properties: detachRefs(props) };
}

/** Object indices inside a lone property list point into an object table that was not saved. */
function detachRefs(v: Value): Value {
  if (v instanceof ObjectRef) return v.index === -1 ? null : { $index: v.index };
  if (Array.isArray(v)) return v.map(detachRefs);
  if (typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype) {
    const out: { [key: string]: Value } = {};
    for (const k in v as { [key: string]: Value }) out[k] = detachRefs((v as { [key: string]: Value })[k]);
    return out;
  }
  return v;
}
