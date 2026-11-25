// Creatures stored in items (cryopods and similar), ARK: Survival Ascended.
//
// The item keeps CustomItemDatas[0].CustomDataBytes.ByteArrays[]. Bytes:
// - [0] creature and status component: int32 version, int32 inflated size, int32 name table offset,
//   then a zlib stream whose output is packed once more (see unpack()). Inside: [8 bytes], object
//   count, object headers, property lists, and a name table of its own. Names are int32 ids: own
//   table at id | 0x10000000, small ids from a fixed table of the game.
// - [1] saddle, [2] costume: int32 version (0x1bedead marks a second int32 with the real version),
//   [8 bytes from version 7], one property list with inline names.
import { inflateSync } from 'node:zlib';
import { Embedded, type GameObject, ReadContext, type Value } from '../types.ts';
import { AsaArchive, ZERO_UUID } from './archive.ts';
import { readAsaProperties } from './properties.ts';

/**
 * Names with fixed ids in cryopod payloads. Not complete: unknown ids are rendered as Unknown_<hex>
 * and counted, so the coverage report shows which are missing.
 */
export const CRYO_NAME_CONSTANTS = new Map<number, string>([
  [0, 'TribeName'], [1, 'StrProperty'], [2, 'bServerInitializedDino'], [3, 'BoolProperty'],
  [5, 'FloatProperty'], [6, 'ColorSetIndices'], [7, 'ByteProperty'], [8, 'None'], [9, 'ColorSetNames'],
  [10, 'NameProperty'], [11, 'TamingTeamID'], [12, 'ObjectProperty'], [13, 'RequiredTameAffinity'],
  [14, 'TamingTeamID'], [15, 'IntProperty'], [19, 'StructProperty'], [23, 'DinoID1'],
  [24, 'UInt32Property'], [25, 'DinoID2'], [31, 'UploadedFromServerName'], [32, 'TamedOnServerName'],
  [36, 'TargetingTeam'], [38, 'bReplicateGlobalStatusValues'], [39, 'bAllowLevelUps'],
  [40, 'bServerFirstInitialized'], [41, 'ExperiencePoints'], [42, 'CurrentStatusValues'],
  [44, 'ArrayProperty'], [55, 'bIsFemale'],
  // Inferred from the neighbours of the same property in the world save (same class, same order).
  // Ids are handed out in order of first use, so neighbouring ids belong to neighbouring names.
  [0x04, 'AIRangeMultiplier'], [0x10, 'OwningPlayerID'], [0x11, 'OwningPlayerName'], [0x1a, 'UntamedPoopTimeCache'],
  [0x22, 'MyCharacterStatusComponent'], [0x38, 'Unused'], [0x3a, 'SavedLastValidTameVersion'],
]);

/**
 * Second packing layer on top of zlib: 0xF0 escapes the next byte, 0xF1 n expands to 0xF0|hi(n),
 * 0xF0|lo(n), 0xF2..0xFE are runs of (b & 0x0F) zero bytes, 0xFF a b expands to 0,0,0,a,0,0,0,b,0,0,0.
 */
export function unpack(src: Buffer): Buffer {
  let out = Buffer.allocUnsafe(Math.max(64, src.length * 2));
  let o = 0;
  const room = (n: number): void => {
    if (o + n <= out.length) return;
    const bigger = Buffer.allocUnsafe(Math.max(out.length * 2, o + n));
    out.copy(bigger, 0, 0, o);
    out = bigger;
  };
  const at = (i: number): number => {
    if (i >= src.length) throw new RangeError('packed cryopod data ends inside an escape');
    return src[i];
  };
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (b < 0xf0) { room(1); out[o++] = b; continue; }
    if (b === 0xf0) { room(1); out[o++] = at(++i); continue; }
    if (b === 0xf1) { const n = at(++i); room(2); out[o++] = 0xf0 | (n >> 4); out[o++] = 0xf0 | (n & 0x0f); continue; }
    if (b < 0xff) { const n = b & 0x0f; room(n); out.fill(0, o, o + n); o += n; continue; }
    const b1 = at(++i), b2 = at(++i);
    room(11);
    out.fill(0, o, o + 11);
    out[o + 3] = b1;
    out[o + 7] = b2;
    o += 11;
  }
  return out.subarray(0, o);
}

/** The inverse of unpack(), used by the tests to build payloads. */
export function pack(src: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < src.length;) {
    const b = src[i];
    if (b === 0) {
      let n = 1;
      while (n < 14 && src[i + n] === 0) n++;
      if (n >= 2) { out.push(0xf0 | n); i += n; continue; }
      out.push(0); i++; continue;
    }
    if (b >= 0xf0) out.push(0xf0);
    out.push(b);
    i++;
  }
  return Buffer.from(out);
}

export interface CryoCoverage { found: number; decoded: number; partial: number; failed: number; saddles: number }

export function newCryoCoverage(): CryoCoverage {
  return { found: 0, decoded: 0, partial: 0, failed: 0, saddles: 0 };
}

/** Byte ranges of the unpacked payload that were read, to find what is left over. */
class Ranges {
  private list: [number, number][] = [];
  add(from: number, to: number): void { if (to > from) this.list.push([from, to]); }
  covered(): number {
    this.list.sort((x, y) => x[0] - y[0]);
    let sum = 0, end = 0;
    for (const [f, t] of this.list) {
      if (t <= end) continue;
      sum += t - Math.max(f, end);
      end = t;
    }
    return sum;
  }
  /** Uncovered stretches of [0, total). */
  gaps(total: number): [number, number][] {
    this.list.sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    let end = 0;
    for (const [f, t] of this.list) {
      if (f > end) out.push([end, f]);
      end = Math.max(end, t);
    }
    if (end < total) out.push([end, total]);
    return out;
  }
}

function readCryoObject(a: AsaArchive, index: number): GameObject {
  const guid = a.uuid();
  const cls = a.string() ?? '';
  const isItem = a.i32() !== 0;
  const nameCount = a.u32();
  if (nameCount > 64) throw new RangeError(`cryopod object with ${nameCount} names`);
  const names: string[] = [];
  for (let i = 0; i < nameCount; i++) names.push(a.string() ?? '');
  const fromDataFile = a.bool();
  const dataFile = a.i32();
  const loc = a.bool() ? { x: 0, y: 0, z: 0, pitch: a.f64(), yaw: a.f64(), roll: a.f64() } : null;
  const propOffset = a.i32();
  if (a.i32() !== 0) a.ctx.note('cryopod: non-zero value after property offset');
  return {
    index, guid: guid === ZERO_UUID ? null : guid, cls, isItem, names, fromDataFile, dataFile, loc, propOffset,
    props: {}, extra: undefined, error: undefined,
  };
}

/** Creature payload (ByteArrays[0]); null if the bytes are not one. */
export function readCryopod(bytes: Buffer, parent: ReadContext, cov: CryoCoverage): Embedded | null {
  if (bytes.length < 14 || bytes[12] !== 0x78) return null;
  const version = bytes.readInt32LE(0);
  const inflatedSize = bytes.readInt32LE(4);
  const namesOffset = bytes.readInt32LE(8);
  let data: Buffer;
  try {
    const inflated = inflateSync(bytes.subarray(12));
    if (inflated.length !== inflatedSize) parent.note('cryopod: inflated size differs from header');
    data = unpack(inflated);
  } catch {
    return null;
  }
  cov.found++;
  const ctx = new ReadContext();
  ctx.decodeBytes = parent.decodeBytes;
  const ranges = new Ranges();
  const objects: GameObject[] = [];
  try {
    if (namesOffset < 0 || namesOffset + 4 > data.length) throw new RangeError('name table offset outside the payload');
    const names = new Map<number, string>();
    const t = new AsaArchive(data, { names: { kind: 'inline' }, ue55: false, refs: 'archive' }, ctx, namesOffset);
    const count = t.i32();
    if (count < 0 || count > 100_000) throw new RangeError(`cryopod name table with ${count} names`);
    for (let i = 0; i < count; i++) names.set(i | 0x10000000, t.string() ?? '');
    ranges.add(namesOffset, t.pos);

    const ue55 = version >= 0x407;
    ctx.saw(`cryopod version 0x${version.toString(16)}`);
    const a = new AsaArchive(data, { names: { kind: 'cryo', names, constants: CRYO_NAME_CONSTANTS }, ue55, refs: 'archive' }, ctx);
    if (ue55) a.skip(8);
    const n = a.i32();
    if (n <= 0 || n > 1000) throw new RangeError(`cryopod with ${n} objects`);
    for (let i = 0; i < n; i++) objects.push(readCryoObject(a, i));
    ranges.add(0, a.pos);
    for (const o of objects) {
      a.pos = o.propOffset;
      const start = a.pos;
      ctx.owner = o.cls.split('.').pop() ?? '';
      if (ue55 && a.remaining && a.u8() !== 0) ctx.note('cryopod: serialization control byte not 0');
      o.props = readAsaProperties(a, ctx);
      // UObject tail: bool "has GUID" [+ GUID], then one int32.
      if (a.remaining >= 4 && a.bool()) o.extra = { guid: a.uuid() };
      if (a.remaining >= 4) ctx.saw(`cryopod tail int32 ${a.i32()}`);
      // Some creatures end with extra zero bytes before the next object (or the name table).
      const next = Math.min(namesOffset, ...objects.map((x) => x.propOffset).filter((x) => x > start));
      if (next > a.pos && next - a.pos <= 16 && data.subarray(a.pos, next).every((b) => b === 0)) {
        ctx.saw(`cryopod: ${next - a.pos} zero bytes after ${o.cls.split('.').pop()}`);
        a.pos = next;
      }
      ranges.add(start, a.pos);
    }
  } catch (e) {
    cov.failed++;
    parent.note(`cryopod unreadable: ${String((e as Error).message).replace(/\d+/g, 'N')}`);
    parent.keepRaw('cryopod unreadable', bytes.length);
    return null;
  }
  const innerRaw = [...ctx.rawBytes.values()].reduce((s, x) => s + x, 0) + (data.length - ranges.covered());
  for (const [k, v] of ctx.issues) parent.note(`cryopod: ${k}`, v);
  for (const [k, v] of ctx.seen) parent.saw(`cryopod: ${k}`, v);
  for (const [k, v] of ctx.rawBytes) parent.saw(`cryopod raw bytes (unpacked): ${k}`, v);
  if (data.length > ranges.covered()) {
    parent.saw('cryopod raw bytes (unpacked): not covered', data.length - ranges.covered());
    // Where the leftovers sit, with a short sample, so the report shows what to look at next.
    for (const [f, t] of ranges.gaps(data.length)) {
      const before = objects.filter((o) => o.propOffset < f).pop();
      parent.saw(`cryopod gap of ${t - f} bytes after ${before ? before.cls.split('.').pop() : 'header'}: ${data.subarray(f, Math.min(t, f + 24)).toString('hex')}`);
    }
  }
  if (innerRaw > 0) {
    cov.partial++;
    // Raw share of the unpacked payload, applied to the bytes it occupies in the save.
    parent.keepRaw('cryopod content (share of packed size)', Math.round(bytes.length * innerRaw / data.length));
  } else {
    cov.decoded++;
  }
  return new Embedded(objects);
}

/** Saddle or costume (ByteArrays[1], [2]): one property list with inline names; null if not one. */
export function readItemArchive(bytes: Buffer, parent: ReadContext, cov: CryoCoverage): Value | null {
  if (bytes.length < 12) return null;
  let pos = 4;
  let version = bytes.readInt32LE(0);
  if (version === 0x1bedead) { version = bytes.readInt32LE(4); pos = 8; }
  if (version < 5 || version > 7) return null;
  if (version >= 7) pos += 8;
  const ctx = new ReadContext();
  ctx.decodeBytes = parent.decodeBytes;
  const a = new AsaArchive(bytes, { names: { kind: 'inline' }, ue55: version >= 7, refs: 'archive' }, ctx, pos);
  let props;
  try {
    props = readAsaProperties(a, ctx);
  } catch {
    return null;
  }
  cov.saddles++;
  parent.absorb(ctx, 'item archive: ');
  if (a.remaining) {
    parent.note('item archive: data after the property list');
    parent.keepRaw('item archive: data after the property list', a.remaining);
  }
  return { $properties: props, version };
}
