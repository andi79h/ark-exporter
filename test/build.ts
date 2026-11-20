// Builds small synthetic ARK archives for the tests (no real player data in the repo).

export class Writer {
  private chunks: Buffer[] = [];
  private size = 0;
  /** Name table mode: name -> index (1-based on disk). null = inline names. */
  readonly table: Map<string, number> | null;

  constructor(table: Map<string, number> | null = null) { this.table = table; }

  get length(): number { return this.size; }
  child(): Writer { return new Writer(this.table); }

  bytes(b: Buffer): this { this.chunks.push(b); this.size += b.length; return this; }
  u8(v: number): this { return this.bytes(Buffer.from([v])); }
  i16(v: number): this { const b = Buffer.alloc(2); b.writeInt16LE(v); return this.bytes(b); }
  i32(v: number): this { const b = Buffer.alloc(4); b.writeInt32LE(v); return this.bytes(b); }
  u32(v: number): this { const b = Buffer.alloc(4); b.writeUInt32LE(v); return this.bytes(b); }
  i64(v: bigint): this { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return this.bytes(b); }
  u64(v: bigint): this { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return this.bytes(b); }
  f32(v: number): this { const b = Buffer.alloc(4); b.writeFloatLE(v); return this.bytes(b); }
  f64(v: number): this { const b = Buffer.alloc(8); b.writeDoubleLE(v); return this.bytes(b); }

  string(s: string | null): this {
    if (s === null) return this.i32(0);
    if (/^[\x00-\xff]*$/.test(s)) {
      this.i32(s.length + 1);
      return this.bytes(Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]));
    }
    this.i32(-(s.length + 1));
    return this.bytes(Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.from([0, 0])]));
  }

  name(s: string): this {
    if (this.table === null) return this.string(s);
    let idx = this.table.get(s);
    if (idx === undefined) { idx = this.table.size + 1; this.table.set(s, idx); }
    return this.i32(idx).i32(0);
  }

  toBuffer(): Buffer { return Buffer.concat(this.chunks); }
}

export interface Prop {
  name: string;
  type: string;
  index?: number;
  /** Struct type, array element type or enum type. */
  inner?: string;
  bool?: boolean;
  value?: (w: Writer) => void;
}

export function writeProps(w: Writer, list: Prop[]): void {
  for (const p of list) {
    w.name(p.name).name(p.type);
    if (p.type === 'BoolProperty') {
      w.i32(0).i32(p.index ?? 0).u8(p.bool ? 1 : 0);
      continue;
    }
    const body = w.child();
    p.value?.(body);
    w.i32(body.length).i32(p.index ?? 0);
    if (p.inner !== undefined) w.name(p.inner);
    w.bytes(body.toBuffer());
  }
  w.name('None');
}

export const int = (name: string, v: number, index = 0): Prop => ({ name, type: 'IntProperty', index, value: (w) => w.i32(v) });
export const float = (name: string, v: number, index = 0): Prop => ({ name, type: 'FloatProperty', index, value: (w) => w.f32(v) });
export const double = (name: string, v: number): Prop => ({ name, type: 'DoubleProperty', value: (w) => w.f64(v) });
export const str = (name: string, v: string): Prop => ({ name, type: 'StrProperty', value: (w) => w.string(v) });
export const bool = (name: string, v: boolean): Prop => ({ name, type: 'BoolProperty', bool: v });
export const ref = (name: string, index: number): Prop => ({ name, type: 'ObjectProperty', value: (w) => w.i32(0).i32(index) });
export const path = (name: string, p: string): Prop => ({ name, type: 'ObjectProperty', value: (w) => w.i32(1).name(p) });
export const u64 = (name: string, v: bigint): Prop => ({ name, type: 'UInt64Property', value: (w) => w.u64(v) });
export const struct = (name: string, inner: string, list: Prop[]): Prop => ({ name, type: 'StructProperty', inner, value: (w) => writeProps(w, list) });
export const vector = (name: string, x: number, y: number, z: number): Prop => ({ name, type: 'StructProperty', inner: 'Vector', value: (w) => w.f32(x).f32(y).f32(z) });
export const bytesArray = (name: string, b: Buffer): Prop => ({ name, type: 'ArrayProperty', inner: 'ByteProperty', value: (w) => w.i32(b.length).bytes(b) });
export const structArray = (name: string, items: Prop[][]): Prop => ({
  name, type: 'ArrayProperty', inner: 'StructProperty', value: (w) => { w.i32(items.length); for (const it of items) writeProps(w, it); },
});

export interface Obj {
  cls: string;
  names: string[];
  isItem?: boolean;
  loc?: [number, number, number];
  props: Prop[];
  /** Bytes after the property list. */
  extra?: Buffer;
}

function writeHeader(w: Writer, o: Obj, propOffset: number): void {
  w.bytes(Buffer.alloc(16)).name(o.cls).i32(o.isItem ? 1 : 0).i32(o.names.length);
  for (const n of o.names) w.name(n);
  w.i32(0).i32(0);
  if (o.loc) w.i32(1).f32(o.loc[0]).f32(o.loc[1]).f32(o.loc[2]).f32(0).f32(90).f32(0);
  else w.i32(0);
  w.i32(propOffset).i32(0);
}

function propBodies(table: Map<string, number> | null, objects: Obj[]): Buffer[] {
  return objects.map((o) => {
    const w = new Writer(table);
    writeProps(w, o.props);
    if (o.extra) w.bytes(o.extra);
    return w.toBuffer();
  });
}

/** Inline-named archive: [version], count, headers, property lists (offsets from the start). */
export function buildContainer(objects: Obj[], version: number | null): Buffer {
  const bodies = propBodies(null, objects);
  const sizing = new Writer(null);
  if (version !== null) sizing.i32(version);
  sizing.i32(objects.length);
  for (const o of objects) writeHeader(sizing, o, 0);
  const w = new Writer(null);
  if (version !== null) w.i32(version);
  w.i32(objects.length);
  let offset = sizing.length;
  for (let i = 0; i < objects.length; i++) { writeHeader(w, objects[i], offset); offset += bodies[i].length; }
  for (const b of bodies) w.bytes(b);
  return w.toBuffer();
}

/** Cryopod payload: count, headers, property lists, no version. */
export const buildEmbedded = (objects: Obj[]): Buffer => buildContainer(objects, null);

/** A version 9 .ark with name table, empty hibernation stores and the given objects. */
export function buildSave(objects: Obj[], opts: { map?: string; gameTime?: number; saveCount?: number } = {}): Buffer {
  const table = new Map<string, number>();
  const headerSize = 2 + 4 * 4 + 4 + 4;
  const files = new Writer(table).i32(1).string(opts.map ?? 'TestMap').i32(0).i32(0);
  const bodies = propBodies(table, objects);
  const offsets: number[] = [];
  let off = 0;
  for (const b of bodies) { offsets.push(off); off += b.length; }
  const objTable = new Writer(table).i32(objects.length);
  objects.forEach((o, i) => writeHeader(objTable, o, offsets[i]));
  const hib = new Writer(null);
  for (let s = 0; s < 2; s++) hib.i32(-1).i32(2).i64(0n).i64(0n);
  const names = new Writer(null).i32(table.size);
  for (const n of table.keys()) names.string(n);
  const hibOff = headerSize + files.length + objTable.length;
  const nameOff = hibOff + hib.length;
  const propsOff = nameOff + names.length;
  const head = new Writer(null).i16(9).i32(hibOff).i32(0).i32(nameOff).i32(propsOff).f32(opts.gameTime ?? 1234.5).i32(opts.saveCount ?? 7);
  return Buffer.concat([head.toBuffer(), files.toBuffer(), objTable.toBuffer(), hib.toBuffer(), names.toBuffer(), ...bodies]);
}
