// Builds small synthetic ARK: Survival Ascended saves for the tests (no real player data in the repo).
import { deflateSync } from 'node:zlib';
import { pack, CRYO_NAME_CONSTANTS } from '../src/asa/cryopod.ts';
import { openDatabase } from '../src/sqlite.ts';
import { Writer } from './build.ts';

export interface TN { name: string; params?: TN[] }
export const tn = (name: string, ...params: TN[]): TN => ({ name, params });

/** One property. `legacy` holds the type-specific header names of the older layout. */
export interface AP {
  name: string;
  type: TN;
  index?: number;
  bool?: boolean;
  value?: (w: Writer) => void;
}

function typeName(w: Writer, t: TN): void {
  w.name(t.name).i32(t.params?.length ?? 0);
  for (const p of t.params ?? []) typeName(w, p);
}

/** UE 5.5 tags (save version 14, archive version 7, cryopod 0x407). */
export function props55(w: Writer, list: AP[]): void {
  for (const p of list) {
    w.name(p.name);
    typeName(w, p.type);
    const body = w.child();
    p.value?.(body);
    let flags = 0;
    if (p.index) flags |= 0x01;
    if (p.bool) flags |= 0x10;
    w.i32(body.length).u8(flags);
    if (p.index) w.i32(p.index);
    w.bytes(body.toBuffer());
  }
  w.name('None');
}

/** Older UE5 tags (save version 13): UE4 layout plus one "has property GUID" byte. */
export function propsLegacy(w: Writer, list: AP[]): void {
  for (const p of list) {
    w.name(p.name).name(p.type.name);
    const body = w.child();
    p.value?.(body);
    w.i32(p.type.name === 'BoolProperty' ? 0 : body.length).i32(p.index ?? 0);
    const inner = p.type.params ?? [];
    switch (p.type.name) {
      case 'StructProperty': w.name(inner[0].name).bytes(Buffer.alloc(16)); break;
      case 'ByteProperty': case 'EnumProperty': case 'ArrayProperty': case 'SetProperty': w.name(inner[0].name); break;
      case 'MapProperty': w.name(inner[0].name).name(inner[1].name); break;
      case 'BoolProperty': w.u8(p.bool ? 1 : 0); break;
    }
    w.u8(0);
    w.bytes(body.toBuffer());
  }
  w.name('None');
}

const guidBytes = (hex: string): Buffer => Buffer.from(hex.padStart(32, '0'), 'hex');

// Property helpers; `w` decides between name-table and inline names.
export const aInt = (name: string, v: number, index = 0): AP => ({ name, type: tn('IntProperty'), index, value: (w) => w.i32(v) });
export const aFloat = (name: string, v: number): AP => ({ name, type: tn('FloatProperty'), value: (w) => w.f32(v) });
export const aDouble = (name: string, v: number): AP => ({ name, type: tn('DoubleProperty'), value: (w) => w.f64(v) });
export const aStr = (name: string, v: string): AP => ({ name, type: tn('StrProperty'), value: (w) => w.string(v) });
export const aName = (name: string, v: string): AP => ({ name, type: tn('NameProperty'), value: (w) => w.name(v) });
export const aBool = (name: string, v: boolean): AP => ({ name, type: tn('BoolProperty'), bool: v });
export const aU64 = (name: string, v: bigint): AP => ({ name, type: tn('UInt64Property'), value: (w) => w.u64(v) });
export const aEnum = (name: string, e: string, v: string): AP => ({ name, type: tn('ByteProperty', tn(e)), value: (w) => w.name(v) });
export const aByte = (name: string, v: number): AP => ({ name, type: tn('ByteProperty', tn('None')), value: (w) => w.u8(v) });
export const aVector = (name: string, x: number, y: number, z: number): AP =>
  ({ name, type: tn('StructProperty', tn('Vector', tn('/Script/CoreUObject'))), value: (w) => w.f64(x).f64(y).f64(z) });
export const aStruct = (name: string, struct: string, list: AP[], legacy = false): AP =>
  ({ name, type: tn('StructProperty', tn(struct)), value: (w) => (legacy ? propsLegacy : props55)(w, list) });
/** World save reference by GUID. */
export const aRef = (name: string, guid: string): AP => ({ name, type: tn('ObjectProperty'), value: (w) => w.i16(0).bytes(guidBytes(guid)) });
/** World save reference by name (class or asset path). */
export const aPath = (name: string, path: string): AP => ({ name, type: tn('ObjectProperty'), value: (w) => w.i16(1).name(path) });
/** Archive reference (profiles, cryopods): int32 kind 1 + path string. */
export const aArchivePath = (name: string, path: string): AP => ({ name, type: tn('ObjectProperty'), value: (w) => w.i32(1).string(path) });
export const aSoft = (name: string, path: string): AP => ({ name, type: tn('SoftObjectProperty'), value: (w) => w.name(path).i32(0) });
export const aBytes = (name: string, b: Buffer): AP => ({ name, type: tn('ArrayProperty', tn('ByteProperty')), value: (w) => w.i32(b.length).bytes(b) });
export const aIntArray = (name: string, v: number[]): AP =>
  ({ name, type: tn('ArrayProperty', tn('IntProperty')), value: (w) => { w.i32(v.length); for (const x of v) w.i32(x); } });
export const aStructArray = (name: string, struct: string, items: AP[][]): AP => ({
  name, type: tn('ArrayProperty', tn('StructProperty', tn(struct))),
  value: (w) => { w.i32(items.length); for (const it of items) props55(w, it); },
});
/** Older layout: one inner tag for all elements. */
export const aStructArrayLegacy = (name: string, struct: string, items: AP[][]): AP => ({
  name, type: tn('ArrayProperty', tn('StructProperty')),
  value: (w) => {
    w.i32(items.length);
    const body = w.child();
    for (const it of items) propsLegacy(body, it);
    w.name(name).name('StructProperty').i32(body.length).i32(0).name(struct).bytes(Buffer.alloc(16)).u8(0);
    w.bytes(body.toBuffer());
  },
});
export const aMapNameInt = (name: string, entries: [string, number][]): AP => ({
  name, type: tn('MapProperty', tn('NameProperty'), tn('IntProperty')),
  value: (w) => { w.i32(0).i32(entries.length); for (const [k, v] of entries) w.name(k).i32(v); },
});
export const aUnknown = (name: string, bytes: Buffer): AP => ({ name, type: tn('FancyNewProperty'), value: (w) => w.bytes(bytes) });

/** Name writer for cryopod payloads: fixed ids first, otherwise own table at index | 0x10000000. */
export class CryoWriter extends Writer {
  readonly own: string[];
  private static reverse = new Map([...CRYO_NAME_CONSTANTS].map(([id, n]) => [n, id] as const));
  constructor(own: string[] = []) { super(new Map()); this.own = own; }
  override child(): Writer { return new CryoWriter(this.own); }
  override name(s: string): this {
    let id = CryoWriter.reverse.get(s);
    if (id === undefined) {
      let i = this.own.indexOf(s);
      if (i < 0) { i = this.own.length; this.own.push(s); }
      id = i | 0x10000000;
    }
    return this.i32(id).i32(0);
  }
}

export interface CryoObj { guid: string; cls: string; names: string[]; props: AP[] }

/** ByteArrays[0] of a cryopod: header, zlib(pack(payload)). */
export function cryoBytes(objects: CryoObj[], version = 0x407): Buffer {
  const own: string[] = [];
  const bodies = objects.map((o) => {
    const w = new CryoWriter(own);
    w.u8(0);
    props55(w, o.props);
    w.i32(0).i32(0); // no GUID, tail int32
    return w.toBuffer();
  });
  const headerLen = (o: CryoObj) => 16 + 4 + o.cls.length + 1 + 4 + 4 + o.names.reduce((s, n) => s + 4 + n.length + 1, 0) + 4 + 4 + 4 + 4 + 4;
  let offset = 8 + 4 + objects.reduce((s, o) => s + headerLen(o), 0);
  const head = new Writer(null);
  head.bytes(Buffer.alloc(8)).i32(objects.length);
  objects.forEach((o, i) => {
    head.bytes(guidBytes(o.guid)).string(o.cls).i32(0).u32(o.names.length);
    for (const n of o.names) head.string(n);
    head.i32(0).i32(0).i32(0).i32(offset).i32(0);
    offset += bodies[i].length;
  });
  const namesOffset = offset;
  const table = new Writer(null).i32(own.length);
  for (const n of own) table.string(n);
  const data = Buffer.concat([head.toBuffer(), ...bodies, table.toBuffer()]);
  const packed = pack(data);
  const header = new Writer(null).i32(version).i32(packed.length).i32(namesOffset).toBuffer();
  return Buffer.concat([header, deflateSync(packed)]);
}

/** Saddle/costume archive: marker, version 7, 8 bytes, one property list with inline names. */
export function itemArchiveBytes(list: AP[]): Buffer {
  const w = new Writer(null).i32(0x1bedead).i32(7).bytes(Buffer.alloc(8));
  props55(w, list);
  return w.toBuffer();
}

export interface TemplateStructure { cls: number; skin?: number; loc: [number, number, number]; rot: [number, number, number]; flag?: number }

/** Structure template (blueprint tablet): int32 1, inflated size, zlib(pack(payload)). */
export function templateBytes(t: { author: string; name: string; description?: string; classes: string[]; structures: TemplateStructure[]; header?: number[] }): Buffer {
  const w = new Writer(null).i32(1).string(t.author).string(t.name).string(t.description ?? null);
  const header = t.header ?? [0];
  w.i32(header[0]).i32(header.length - 1);
  for (const v of header.slice(1)) w.i32(v);
  w.i32(t.classes.length);
  for (const c of t.classes) w.string(c);
  w.i32(t.structures.length);
  for (const s of t.structures) {
    const idx = Buffer.alloc(4);
    idx.writeUInt16LE(s.cls, 0);
    idx.writeInt16LE(s.skin ?? -1, 2);
    w.bytes(idx);
    for (const v of [...s.loc, ...s.rot]) w.f64(v);
    w.i32(s.flag ?? 0).string('None').bytes(Buffer.alloc(36));
  }
  const packed = pack(w.toBuffer());
  return Buffer.concat([new Writer(null).i32(1).i32(packed.length).toBuffer(), deflateSync(packed)]);
}

/** Cryopod item property: CustomItemDatas[0].CustomDataBytes.ByteArrays[].Bytes. */
export function aCryoItemData(arrays: Buffer[]): AP {
  return aStructArray('CustomItemDatas', 'CustomItemData', [[
    aStruct('CustomDataBytes', 'CustomItemByteArrays', [
      aStructArray('ByteArrays', 'CustomItemByteArray', arrays.map((b) => [aBytes('Bytes', b)])),
    ]),
  ]]);
}

export interface AsaObj {
  guid: string;
  cls: string;
  names: string[];
  part?: number;
  loc?: [number, number, number];
  props: AP[];
  /** Bytes after the UObject tail. */
  tail?: Buffer;
  /** Writes the data after the UObject tail (instead of tail). */
  tailWriter?: (w: Writer) => void;
}

export interface AsaWorld {
  version?: 13 | 14;
  parts?: string[];
  objects: AsaObj[];
  extraCustom?: Record<string, Buffer>;
  /** Custom rows that use names of the save's name table (written before the SaveHeader is built). */
  customWriter?: (table: Map<string, number>) => Record<string, Buffer>;
  extraTable?: boolean;
}

/** Writes a complete ASA world save (SQLite) to `path`. */
export async function writeAsaWorld(path: string, world: AsaWorld): Promise<void> {
  const version = world.version ?? 14;
  const table = new Map<string, number>();
  const rows = world.objects.map((o) => {
    const w = new Writer(table);
    w.name(o.cls).i32(0).i32(o.names.length);
    for (const n of o.names) w.string(n);
    w.i32(o.part ?? 0).u8(0);
    if (version >= 14) w.u8(0);
    (version >= 14 ? props55 : propsLegacy)(w, o.props);
    w.i32(0);
    if (o.tail) w.bytes(o.tail);
    o.tailWriter?.(w);
    return { key: guidBytes(o.guid), value: w.toBuffer() };
  });

  const tableCustom = world.customWriter?.(table) ?? {};
  const parts = world.parts ?? ['TestMap_WP', 'TestMap_Sublevel'];
  const body = new Writer(null);
  body.u32(parts.length);
  for (const p of parts) body.string(p).i32(-1);
  body.i32(0).i32(1).i32(77).i32(1).string('Watervein_Base_BP_C');
  const fixed = 2 + (version >= 14 ? 8 : 0) + 4 + 8 + 4;
  const nameTableOffset = fixed + body.length;
  const header = new Writer(null).i16(version);
  if (version >= 14) header.i32(0).i32(1);
  header.i32(nameTableOffset).f64(12345.5).i32(3);
  header.bytes(body.toBuffer());
  header.i32(table.size);
  for (const [name, id] of table) header.i32(id).string(name);

  const transforms = new Writer(null);
  for (const o of world.objects) {
    if (!o.loc) continue;
    // rotation: 90° yaw as quaternion (x, y, z, w)
    transforms.bytes(guidBytes(o.guid)).f64(o.loc[0]).f64(o.loc[1]).f64(o.loc[2]).f64(0).f64(0).f64(Math.SQRT1_2).f64(Math.SQRT1_2);
  }
  transforms.bytes(Buffer.alloc(16));

  const db = await openDatabase(path);
  db.exec('CREATE TABLE game (key BLOB PRIMARY KEY, value BLOB); CREATE TABLE custom (key TEXT PRIMARY KEY, value BLOB)');
  const g = db.prepare('INSERT INTO game (key, value) VALUES (?, ?)');
  for (const r of rows) g.run(r.key, r.value);
  const c = db.prepare('INSERT INTO custom (key, value) VALUES (?, ?)');
  c.run('SaveHeader', header.toBuffer());
  c.run('ActorTransforms', transforms.toBuffer());
  for (const [k, v] of Object.entries({ ...tableCustom, ...(world.extraCustom ?? {}) })) c.run(k, v);
  if (world.extraTable) db.exec("CREATE TABLE notes (k TEXT, v BLOB); INSERT INTO notes VALUES ('a', x'0102030405')");
  db.close();
}

/** .arkprofile / .arktribe of ASA (archive version 7, inline names). */
export function asaContainer(objects: { guid: string; cls: string; names: string[]; props: AP[] }[]): Buffer {
  const bodies = objects.map((o) => {
    const w = new Writer(null);
    w.u8(0);
    props55(w, o.props);
    w.i32(0);
    return w.toBuffer();
  });
  const headerLen = (o: { cls: string; names: string[] }) =>
    16 + 4 + o.cls.length + 1 + 4 + 4 + o.names.reduce((s, n) => s + 4 + n.length + 1, 0) + 4 + 4 + 4 + 4 + 4;
  let offset = 4 + 8 + 4 + objects.reduce((s, o) => s + headerLen(o), 0);
  const w = new Writer(null).i32(7).bytes(Buffer.alloc(8)).i32(objects.length);
  objects.forEach((o, i) => {
    w.bytes(guidBytes(o.guid)).string(o.cls).i32(0).u32(o.names.length);
    for (const n of o.names) w.string(n);
    w.i32(0).i32(0).i32(0).i32(offset).i32(0);
    offset += bodies[i].length;
  });
  return Buffer.concat([w.toBuffer(), ...bodies]);
}
