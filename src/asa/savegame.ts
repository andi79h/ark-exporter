// World save of ARK: Survival Ascended (<Map>_WP.ark). The file is a SQLite database:
// - table `custom` (text key, blob value): SaveHeader (version, game time, sublevels, name table),
//   ActorTransforms (GUID + location + rotation quaternion per actor), ActorTransformsDelta,
//   GameModeCustomBytes (tribes and players with -usestore, else empty).
// - table `game` (16-byte GUID key, blob value): one object per row. Blob: class (name id + instance),
//   int32, names (strings since version 13), int32 sublevel ("part"), one control byte (two from
//   version 14), property list, then the UObject tail (int32 "has GUID" [+ GUID]) and native data.
// Coverage is measured against the payload (all keys and values); the SQLite page structure is
// reported separately.
import { statSync } from 'node:fs';
import { openDatabase, type SqlValue } from '../sqlite.ts';
import { Blob, type GameObject, type Location, ReadContext, type Value } from '../types.ts';
import { AsaArchive, type AsaFormat } from './archive.ts';
import { type AsaStore, enableAsaBytes, readStore } from './container.ts';
import { type CryoCoverage, newCryoCoverage } from './cryopod.ts';
import { readAsaProperties } from './properties.ts';

export interface AsaSection { name: string; bytes: number; decoded: boolean }

const KNOWN_CUSTOM_KEYS = new Set(['SaveHeader', 'ActorTransforms', 'ActorTransformsDelta', 'GameModeCustomBytes']);

export interface AsaSave {
  version: number;
  gameTime: number | string;
  /** The int32 fields of the SaveHeader whose meaning is not known. */
  headerUnknown: number[];
  /** Sublevels the objects refer to by index (first entry: the map). */
  parts: (string | null)[];
  nameCount: number;
  /** Entries of the table between parts and names (water veins and the like). */
  otherTable: { id: number; name: string | null }[];
  objectCount: number;
  /** Only filled with keepObjects. */
  objects: GameObject[];
  classes: Map<string, number>;
  transforms: number;
  fileBytes: number;
  payloadBytes: number;
  tables: { name: string; rows: number; bytes: number }[];
  customKeys: { key: string; bytes: number; decoded: boolean }[];
  store: AsaStore | null;
  /** Mission scores (Genesis) from GameModeCustomBytes. */
  missions: MissionBoard[];
  sections: AsaSection[];
  ctx: ReadContext;
  cryo: CryoCoverage;
}

const toBuf = (v: SqlValue): Buffer => {
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  return Buffer.alloc(0);
};

/** Errors grouped without numbers. */
const generic = (e: unknown): string => String((e as Error).message ?? e).replace(/\d+/g, 'N');

/** Adds bytes to a named section, creating it on first use. */
class Sections {
  readonly list: AsaSection[] = [];
  private byName = new Map<string, AsaSection>();
  add(name: string, bytes: number, decoded: boolean): void {
    if (bytes <= 0) return;
    let s = this.byName.get(name);
    if (!s) { s = { name, bytes: 0, decoded }; this.byName.set(name, s); this.list.push(s); }
    s.bytes += bytes;
  }
}

interface HeaderInfo {
  version: number; gameTime: number | string; headerUnknown: number[]; parts: (string | null)[];
  names: Map<number, string>; otherTable: AsaSave['otherTable'];
}

function readHeader(buf: Buffer, ctx: ReadContext, sec: Sections): HeaderInfo {
  const a = new AsaArchive(buf, { names: { kind: 'inline' }, ue55: false, refs: 'save' }, ctx);
  const version = a.i16();
  const headerUnknown: number[] = [];
  if (version >= 14) headerUnknown.push(a.i32(), a.i32());
  const nameTableOffset = a.i32();
  const gameTime = a.f64();
  if (version >= 12) headerUnknown.push(a.i32());
  sec.add('SaveHeader: fields', a.pos, true);

  let s0 = a.pos;
  const parts: (string | null)[] = [];
  const nParts = a.u32();
  if (nParts > 100_000) throw new RangeError(`SaveHeader with ${nParts} parts`);
  for (let i = 0; i < nParts; i++) {
    parts.push(a.string());
    if (a.i32() !== -1) ctx.note('SaveHeader: part entry not terminated by -1');
  }
  sec.add('SaveHeader: parts (sublevels)', a.pos - s0, true);

  s0 = a.pos;
  const otherTable: AsaSave['otherTable'] = [];
  try {
    if (a.i32() !== 0) ctx.note('SaveHeader: non-zero value after parts');
    const n = a.i32();
    if (n < 0 || n > 100_000) throw new RangeError('bad count');
    for (let i = 0; i < n; i++) {
      const id = a.i32();
      if (a.i32() !== 1) ctx.note('SaveHeader: other table entry without 1');
      otherTable.push({ id, name: a.string() });
    }
    sec.add('SaveHeader: table after parts', a.pos - s0, true);
  } catch {
    ctx.note('SaveHeader: table after parts unreadable');
    a.pos = s0;
  }
  if (a.pos < nameTableOffset) {
    ctx.note('SaveHeader: bytes before the name table');
    sec.add('SaveHeader: bytes before the name table (raw)', nameTableOffset - a.pos, false);
  } else if (a.pos > nameTableOffset) {
    ctx.note('SaveHeader: table after parts overlaps the name table');
  }
  a.pos = nameTableOffset;
  s0 = a.pos;
  const names = new Map<number, string>();
  const n = a.i32();
  if (n < 0 || n > 10_000_000) throw new RangeError(`name table with ${n} names`);
  for (let i = 0; i < n; i++) {
    const id = a.i32();
    names.set(id, a.string() ?? '');
  }
  sec.add('SaveHeader: name table', a.pos - s0, true);
  if (a.remaining) {
    ctx.note('SaveHeader: data after the name table');
    sec.add('SaveHeader: data after the name table (raw)', a.remaining, false);
  }
  return { version, gameTime, headerUnknown, parts, names, otherTable };
}

const RAD = 180 / Math.PI;
const clean = (v: number): number => (Object.is(v, -0) ? 0 : v);
const normalizeAxis = (deg: number): number => {
  let d = deg % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
};

/** Unreal's FQuat::Rotator(): pitch, yaw, roll in degrees. */
export function quatToRotator(x: number, y: number, z: number, w: number): { pitch: number; yaw: number; roll: number } {
  const singularity = z * x - w * y;
  const yawY = 2 * (w * z + x * y);
  const yawX = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(yawY, yawX) * RAD;
  if (singularity < -0.4999995) return { pitch: -90, yaw: clean(yaw), roll: clean(normalizeAxis(-yaw - 2 * Math.atan2(x, w) * RAD)) };
  if (singularity > 0.4999995) return { pitch: 90, yaw: clean(yaw), roll: clean(normalizeAxis(yaw - 2 * Math.atan2(x, w) * RAD)) };
  return {
    pitch: clean(Math.asin(2 * singularity) * RAD),
    yaw: clean(yaw),
    roll: clean(Math.atan2(-2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * RAD),
  };
}

/** ActorTransforms (and ActorTransformsDelta): GUID, location (3 doubles), rotation quaternion (4 doubles); zero GUID ends the list. */
function readTransforms(name: string, buf: Buffer, ctx: ReadContext, sec: Sections): Map<string, Location> {
  const a = new AsaArchive(buf, { names: { kind: 'inline' }, ue55: false, refs: 'save' }, ctx);
  const map = new Map<string, Location>();
  let terminated = false;
  let notUnit = 0;
  while (a.remaining >= 16) {
    const guid = a.uuid();
    if (/^0+$/.test(guid)) { terminated = true; break; }
    if (a.remaining < 56) { a.pos -= 16; break; }
    const x = a.dv.getFloat64(a.pos, true), y = a.dv.getFloat64(a.pos + 8, true), z = a.dv.getFloat64(a.pos + 16, true);
    const qx = a.dv.getFloat64(a.pos + 24, true), qy = a.dv.getFloat64(a.pos + 32, true);
    const qz = a.dv.getFloat64(a.pos + 40, true), qw = a.dv.getFloat64(a.pos + 48, true);
    a.pos += 56;
    if (Math.abs(Math.hypot(qx, qy, qz, qw) - 1) > 1e-4) notUnit++;
    map.set(guid, { x: clean(x), y: clean(y), z: clean(z), ...quatToRotator(qx, qy, qz, qw) });
  }
  sec.add(`${name}: records`, map.size * 72 + (terminated ? 16 : 0), true);
  if (notUnit) ctx.note(`${name}: rotations that are not unit quaternions`, notUnit);
  if (a.remaining) {
    ctx.note(`${name}: data after the records`);
    sec.add(`${name}: data after the records (raw)`, a.remaining, false);
  }
  return map;
}

function shortClass(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1) : path;
}

/** One row of the game table. */
function readGameObject(
  key: Buffer, blob: Buffer, index: number, h: HeaderInfo, format: AsaFormat, transforms: Map<string, Location>,
  ctx: ReadContext, sec: Sections,
): GameObject {
  const guid = key.toString('hex');
  if (key.length !== 16) ctx.note('game: key is not 16 bytes');
  const a = new AsaArchive(blob, format, ctx);
  const o: GameObject = {
    index, guid, cls: '', isItem: false, names: [], fromDataFile: false, dataFile: -1,
    loc: transforms.get(guid) ?? null, propOffset: 0, props: {}, extra: undefined, error: undefined,
  };
  let stage = 'header';
  try {
    const path = a.name() ?? '';
    o.cls = shortClass(path);
    if (path !== o.cls) o.clsPath = path;
    ctx.owner = o.cls;
    const flag = a.i32();
    if (flag !== 0) ctx.saw(`object header int32 ${flag}`);
    o.isItem = flag === 1;
    const nameCount = a.i32();
    if (nameCount < 0 || nameCount > 64) throw new RangeError(`object with ${nameCount} names`);
    for (let i = 0; i < nameCount; i++) o.names.push((h.version >= 13 ? a.string() : a.name()) ?? '');
    o.dataFile = a.i32();
    if (o.dataFile < -1 || o.dataFile >= h.parts.length) ctx.note('game: part index outside the part list');
    const control = [a.u8()];
    if (h.version >= 14 && a.remaining) control.push(a.u8());
    ctx.saw(`object control bytes ${control.join(',')}`);
    o.propOffset = a.pos;
    sec.add('game: object headers', a.pos, true);
    if (!a.remaining) {
      ctx.saw('object without property list');
      return o;
    }

    stage = 'properties';
    o.props = readAsaProperties(a, ctx);
    sec.add('game: property lists', a.pos - o.propOffset, true);
  } catch (e) {
    o.error = (e as Error).message;
    ctx.note(`game: unreadable object ${stage}: ${generic(e)}`);
    ctx.keepRaw(`section: unreadable object ${stage}: ${o.cls || '?'}`, blob.length - o.propOffset);
    sec.add(`game: unreadable objects (${stage})`, blob.length - o.propOffset, false);
    o.extra = new Blob(blob.subarray(o.propOffset), `unreadable ${stage}`);
    return o;
  }

  // UObject tail: int32 0/1 "has GUID" [+ GUID], then whatever the class serializes natively.
  const tailStart = a.pos;
  let tailGuid: string | null = null;
  if (a.remaining >= 4 && (a.peekI32() === 0 || a.peekI32() === 1)) {
    if (a.i32() === 1) {
      if (a.remaining >= 16) tailGuid = a.uuid();
      else a.pos -= 4;
    }
  }
  let native: Value | undefined;
  if (a.remaining) native = readNativeTail(o.cls, a, ctx);
  sec.add('game: data after property lists (decoded)', a.pos - tailStart, true);
  if (native !== undefined || tailGuid) {
    o.extra = { ...(tailGuid ? { guid: tailGuid } : {}), ...(native !== undefined ? { native } : {}) };
  }
  if (a.remaining) {
    ctx.note(`game: raw data after properties (${o.cls})`);
    ctx.keepRaw(`section: after properties: ${o.cls}`, a.remaining);
    sec.add('game: data after property lists (raw)', a.remaining, false);
    const raw = new Blob(a.bytes(a.remaining), 'after properties');
    o.extra = { ...(o.extra && typeof o.extra === 'object' && !Array.isArray(o.extra) ? o.extra as Record<string, Value> : {}), raw };
  }
  return o;
}

/**
 * Data a class serializes after its UObject tail. Returns undefined (and leaves the position) when
 * the bytes do not match a known layout, so they are kept raw.
 */
function readNativeTail(cls: string, a: AsaArchive, ctx: ReadContext): Value | undefined {
  const start = a.pos;
  // Components and inventories end with int32 0, characters and vehicles with int32 1 (as in ASE).
  if (a.remaining === 4 && (a.peekI32() === 0 || a.peekI32() === 1)) {
    ctx.saw(`object end int32 ${a.i32()}`);
    return undefined;
  }
  // Materials and textures: a few zero bytes.
  if (a.remaining <= 16 && a.buf.subarray(a.pos).every((b) => b === 0)) {
    ctx.saw(`object end ${a.remaining} zero bytes`);
    a.skip(a.remaining);
    return undefined;
  }
  if (cls === 'InstancedFoliageActor') {
    try {
      return { foliage: readFoliage(a, ctx) };
    } catch (e) {
      ctx.note(`foliage data unreadable: ${generic(e)}`);
      a.pos = start;
    }
  }
  try {
    const list = readPropertyRefs(a);
    if (list) return { propertyRefs: list };
  } catch {
    // not this layout
  }
  a.pos = start;
  return undefined;
}

/**
 * Seen on inventories (taxidermy bases): int32 count, entries of uint16 1, class name, property name,
 * 16 bytes (zero in all saves examined). Null unless the bytes match exactly.
 */
function readPropertyRefs(a: AsaArchive): Value[] | null {
  const n = a.i32();
  if (n <= 0 || n > 1000 || a.remaining !== n * 34) return null;
  const out: Value[] = [];
  for (let i = 0; i < n; i++) {
    if (a.u16() !== 1) return null;
    const cls = a.name();
    const property = a.name();
    const guid = a.uuid();
    out.push(/^0+$/.test(guid) ? { cls, property } : { cls, property, guid });
  }
  return out;
}

/**
 * InstancedFoliageActor: int32 count, then per foliage type either int32 0 (empty slot) or an inline
 * sub-object: int32 1, name, control byte, property list (InstancesVisibility = one bit per instance,
 * i.e. harvest state), int32 "has GUID" [+ GUID], int32.
 */
function readFoliage(a: AsaArchive, ctx: ReadContext): Value {
  const n = a.i32();
  if (n < 0 || n > 100_000) throw new RangeError(`foliage with ${n} entries`);
  const out: Value[] = [];
  for (let i = 0; i < n; i++) {
    const marker = a.i32();
    if (marker === 0) { out.push(null); continue; }
    if (marker !== 1) throw new RangeError(`foliage entry starts with ${marker}`);
    const name = a.string();
    if (a.u8() !== 0) ctx.note('foliage: control byte not 0');
    const props = readAsaProperties(a, ctx);
    const hasGuid = a.i32();
    const guid = hasGuid === 1 ? a.uuid() : null;
    const last = a.i32();
    if (last !== 0) ctx.saw(`foliage entry last int32 ${last}`);
    out.push(guid ? { name, props, guid } : { name, props });
  }
  if (a.remaining) throw new RangeError(`${a.remaining} bytes after the foliage entries`);
  return out;
}

export interface MissionBoard { mission: string | null; scores: Value[] }

/**
 * Mission scores after the (empty) tribe/player store in GameModeCustomBytes: int32 missions; per
 * mission: name, int32 count, entries of mission name, player id (EOS), uint32, double (Unix time),
 * float (score), int32, name, player name; then int32 0. Empty (one int32 0 + int32 0) on maps
 * without missions.
 */
function readMissionBoards(buf: Buffer, names: Map<number, string>, ctx: ReadContext): MissionBoard[] {
  const a = new AsaArchive(buf, { names: { kind: 'table', names }, ue55: true, refs: 'save' }, ctx);
  const n = a.i32();
  if (n < 0 || n > 10_000) throw new RangeError(`${n} missions`);
  const out: MissionBoard[] = [];
  for (let i = 0; i < n; i++) {
    const mission = a.name();
    const count = a.i32();
    if (count < 0 || count > 100_000) throw new RangeError(`mission with ${count} scores`);
    const scores: Value[] = [];
    for (let k = 0; k < count; k++) {
      const m = a.name();
      if (m !== mission) ctx.note('mission scores: entry of another mission');
      const playerId = a.string();
      const value1 = a.u32();
      const time = a.f64();
      const score = a.f32();
      const value2 = a.i32();
      const tag = a.name();
      scores.push({ playerId, playerName: a.string(), time, score, value1, value2, tag });
    }
    out.push({ mission, scores });
  }
  const rest = a.i32();
  if (rest !== 0) ctx.saw(`mission scores: last int32 ${rest}`);
  if (a.remaining) throw new RangeError(`${a.remaining} bytes after the mission scores`);
  return out;
}

export interface ReadAsaOptions {
  /** Keep every object in memory (snapshots); inspect only needs the counters. */
  keepObjects?: boolean;
  /** Stop after this many game rows (quick looks at huge saves). */
  limit?: number;
}

export async function readAsaSave(path: string, options: ReadAsaOptions = {}, ctx = new ReadContext()): Promise<AsaSave> {
  const cryo = newCryoCoverage();
  enableAsaBytes(ctx, cryo);
  const sec = new Sections();
  const db = await openDatabase(path, { readonly: true });
  try {
    const tables: AsaSave['tables'] = [];
    for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
      const name = String(t.name);
      const cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all().map((c) => String(c.name));
      const sum = cols.map((c) => `coalesce(sum(length("${c.replace(/"/g, '""')}")), 0)`).join(' + ') || '0';
      const row = db.prepare(`SELECT count(*) AS rows, ${sum} AS bytes FROM "${name.replace(/"/g, '""')}"`).all()[0];
      tables.push({ name, rows: Number(row.rows), bytes: Number(row.bytes) });
    }
    for (const t of tables) {
      if (t.name !== 'game' && t.name !== 'custom') {
        ctx.note(`unknown table ${t.name}`);
        sec.add(`table ${t.name} (raw)`, t.bytes, false);
      }
    }

    const custom = new Map<string, Buffer>();
    for (const row of db.prepare('SELECT key, value FROM custom').iterate()) custom.set(String(row.key), toBuf(row.value));
    const customKeys: AsaSave['customKeys'] = [];
    for (const [k, v] of custom) {
      const known = KNOWN_CUSTOM_KEYS.has(k);
      sec.add('custom: keys', Buffer.byteLength(k, 'utf8'), true);
      customKeys.push({ key: k, bytes: v.length, decoded: known });
      if (!known) {
        ctx.note(`custom: unknown key ${k}`);
        sec.add(`custom: ${k} (raw)`, v.length, false);
      }
    }
    const headerBuf = custom.get('SaveHeader');
    if (!headerBuf) {
      const rows = tables.reduce((s, t) => s + t.rows, 0);
      if (rows > 0) throw new Error('no SaveHeader in table custom: not an ASA world save');
      // The map has never been saved (database created, nothing written).
      ctx.note('empty save: no rows in any table');
      return {
        version: 0, gameTime: 0, headerUnknown: [], parts: [], nameCount: 0, otherTable: [], objectCount: 0, objects: [],
        classes: new Map(), transforms: 0, fileBytes: statSync(path).size, payloadBytes: 0, tables, customKeys, store: null,
        missions: [], sections: sec.list, ctx, cryo,
      };
    }
    const h = readHeader(headerBuf, ctx, sec);
    if (h.version < 13 || h.version > 16) ctx.note(`save version ${h.version} not tested`);
    const transforms = custom.has('ActorTransforms')
      ? readTransforms('ActorTransforms', custom.get('ActorTransforms')!, ctx, sec)
      : new Map<string, Location>();
    const delta = custom.get('ActorTransformsDelta');
    const deltaCount = delta ? readTransforms('ActorTransformsDelta', delta, ctx, sec).size : 0;
    if (deltaCount) ctx.note('ActorTransformsDelta has records (not applied to locations)');

    let store: AsaStore | null = null;
    let missions: MissionBoard[] = [];
    const storeBuf = custom.get('GameModeCustomBytes');
    const emptyStore = storeBuf && storeBuf.length >= 20 && storeBuf.readInt32LE(8) === 0 && storeBuf.readInt32LE(16) === 0;
    if (storeBuf && emptyStore) {
      // Servers without -usestore write an empty tribe/player directory, followed by mission scores.
      sec.add('GameModeCustomBytes: empty tribe and player store', 20, true);
      try {
        missions = readMissionBoards(storeBuf.subarray(20), h.names, ctx);
        sec.add('GameModeCustomBytes: mission scores', storeBuf.length - 20, true);
      } catch (e) {
        ctx.note(`GameModeCustomBytes: mission scores unreadable: ${generic(e)}`);
        sec.add('GameModeCustomBytes: after the store (raw)', storeBuf.length - 20, false);
      }
    } else if (storeBuf) {
      try {
        store = readStore(storeBuf, ctx);
        sec.add('GameModeCustomBytes: tribes and players', store.decoded, true);
        sec.add('GameModeCustomBytes: rest (raw)', storeBuf.length - store.decoded, false);
      } catch (e) {
        ctx.note(`GameModeCustomBytes unreadable: ${generic(e)}`);
        sec.add('GameModeCustomBytes (raw)', storeBuf.length, false);
      }
    }

    const format: AsaFormat = { names: { kind: 'table', names: h.names }, ue55: h.version >= 14, refs: 'save' };
    const objects: GameObject[] = [];
    const classes = new Map<string, number>();
    let index = 0;
    const sql = options.limit ? `SELECT key, value FROM game LIMIT ${Math.floor(options.limit)}` : 'SELECT key, value FROM game';
    for (const row of db.prepare(sql).iterate()) {
      const key = toBuf(row.key);
      sec.add('game: keys (object GUIDs)', key.length, true);
      const o = readGameObject(key, toBuf(row.value), index++, h, format, transforms, ctx, sec);
      classes.set(o.cls, (classes.get(o.cls) ?? 0) + 1);
      if (options.keepObjects) objects.push(o);
    }

    const payloadBytes = tables.reduce((s, t) => s + t.bytes, 0);
    return {
      version: h.version, gameTime: h.gameTime, headerUnknown: h.headerUnknown, parts: h.parts,
      nameCount: h.names.size, otherTable: h.otherTable, objectCount: index, objects, classes,
      transforms: transforms.size, fileBytes: statSync(path).size, payloadBytes, tables, customKeys, store,
      missions, sections: sec.list, ctx, cryo,
    };
  } finally {
    db.close();
  }
}

/** Share of the payload read structurally: decoded sections minus raw bytes kept inside them. */
export function asaCoverage(s: AsaSave): { decoded: number; rawInside: number; percent: number } {
  const decoded = s.sections.filter((x) => x.decoded).reduce((sum, x) => sum + x.bytes, 0);
  let rawInside = 0;
  for (const [k, v] of s.ctx.rawBytes) if (!k.startsWith('section: ')) rawInside += v;
  const percent = s.payloadBytes ? +(100 * (decoded - rawInside) / s.payloadBytes).toFixed(3) : 0;
  return { decoded, rawInside, percent };
}
