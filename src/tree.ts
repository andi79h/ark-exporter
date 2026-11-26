// Lossless property trees for inline-named archives (cluster files, profiles, tribes, cryopod contents)
// and for the property lists of .ark files (names from a name table: pass a reader made with
// Archive.withTable and a BinaryWriter with the same NameTable).
//
// properties.ts turns property lists into plain values for the export and drops what the export does
// not need: types, array indices, string encodings, sizes. Writing a file back needs all of it, so this
// module keeps every property with type, index and order and writes it back in the same form:
// - Values the writer would encode differently than the file does (a string in an unusual encoding,
//   a NaN with payload, a bool byte other than 0/1) keep their original bytes. Those are written as
//   long as the value is unchanged.
// - Parts that cannot be decoded (unknown property types, unreadable structs) stay opaque bytes.
// The grammar is the same as in properties.ts; see there for the layout of a property.
import { Archive, float32, float64 } from './archive.ts';
import type { NameTable } from './nametable.ts';
import { nativeArrayStruct } from './properties.ts';
import { Blob, type GameObject, ObjectRef, PathRef, type Props, type ReadContext, type Value } from './types.ts';
import { BinaryWriter } from './writer.ts';

/** ObjectProperty: index into the object table (-1 = none) or a path (classes, assets). */
export type ObjectValue = { index: number; short?: true } | { path: string | null };
/** Fields of a native struct (Vector, Color, ...), see NATIVE_LAYOUT. */
export type NativeValue = { [field: string]: number | string | null };
export type TreeValue =
  | number | bigint | boolean | string | null
  | ObjectValue | NativeValue | Property[] | TreeValue[] | Buffer;

export interface Property {
  name: string;
  type: string;
  /** Static array index, e.g. ItemStatValues 0..7 are eight properties with the same name. */
  index: number;
  /** Struct type (StructProperty), element type (ArrayProperty) or enum type (ByteProperty). */
  inner?: string | null;
  /** Struct arrays of native structs: the element struct type. Unset for arrays of property lists. */
  elementStruct?: string;
  /**
   * By type: numbers (ints, floats), bigint (64-bit ints), boolean, string | null (Str, Name, enum),
   * ObjectValue, NativeValue or Property[] (structs), arrays of those, Buffer (byte arrays).
   */
  value: TreeValue;
  /** value is the undecoded body (unknown type or unreadable data) and is written back unchanged. */
  opaque?: true;
  /** Body as found in the file, for values the writer would encode differently; used while value equals rawValue. */
  raw?: Buffer;
  rawValue?: TreeValue;
}

/** Binary layout of native structs: field name and type, in file order. */
const NATIVE_LAYOUT: Record<string, [string, 'f32' | 'u8' | 'i32' | 'str'][]> = {
  Vector: [['x', 'f32'], ['y', 'f32'], ['z', 'f32']],
  Rotator: [['pitch', 'f32'], ['yaw', 'f32'], ['roll', 'f32']],
  Vector2D: [['x', 'f32'], ['y', 'f32']],
  Quat: [['x', 'f32'], ['y', 'f32'], ['z', 'f32'], ['w', 'f32']],
  LinearColor: [['r', 'f32'], ['g', 'f32'], ['b', 'f32'], ['a', 'f32']],
  Color: [['b', 'u8'], ['g', 'u8'], ['r', 'u8'], ['a', 'u8']],
  UniqueNetIdRepl: [['kind', 'i32'], ['id', 'str']],
};

export const isNativeStruct = (t: string | null | undefined): t is string => t != null && t in NATIVE_LAYOUT;

/** Collects what could not be decoded, so callers can report it. */
export type TreeNotes = Map<string, number>;

function note(notes: TreeNotes | undefined, what: string): void {
  if (notes) notes.set(what, (notes.get(what) ?? 0) + 1);
}

// ---------------------------------------------------------------- reading

function readNative(a: Archive, t: string): NativeValue {
  const v: NativeValue = {};
  for (const [field, kind] of NATIVE_LAYOUT[t]) {
    v[field] = kind === 'f32' ? a.f32raw() : kind === 'u8' ? a.u8() : kind === 'i32' ? a.i32() : a.string();
  }
  return v;
}

function readObject(a: Archive, size: number): ObjectValue {
  if (size === 4) return { index: a.i32(), short: true };
  const kind = a.i32();
  if (kind === 0) return { index: a.i32() };
  if (kind === 1) return { path: a.name() };
  throw new RangeError(`object reference of kind ${kind}`);
}

function readArray(a: Archive, p: Property, size: number, notes: TreeNotes | undefined): void {
  const n = a.i32();
  if (n < 0 || n > size) throw new RangeError(`array claims ${n} elements in ${size} bytes`);
  const items: TreeValue[] = new Array(n);
  const each = (read: () => TreeValue): void => { for (let i = 0; i < n; i++) items[i] = read(); };
  switch (p.inner) {
    case 'StructProperty': {
      // An empty array keeps no element type: it is written the same way either way.
      const st = n === 0 ? null : nativeArrayStruct(p.name, n, size);
      if (st) {
        p.elementStruct = st;
        each(() => readNative(a, st));
      } else {
        each(() => readPropertyList(a, notes));
      }
      break;
    }
    case 'ByteProperty':
      if (size === n + 4) { p.value = a.bytes(n); return; }
      each(() => a.name());
      break;
    case 'IntProperty': each(() => a.i32()); break;
    case 'UInt32Property': each(() => a.u32()); break;
    case 'Int16Property': each(() => a.i16()); break;
    case 'UInt16Property': each(() => a.u16()); break;
    case 'Int8Property': each(() => a.i8()); break;
    case 'Int64Property': each(() => a.i64n()); break;
    case 'UInt64Property': each(() => a.u64n()); break;
    case 'FloatProperty': each(() => a.f32raw()); break;
    case 'DoubleProperty': each(() => a.f64raw()); break;
    case 'BoolProperty': each(() => a.u8() !== 0); break;
    case 'StrProperty': each(() => a.string()); break;
    case 'NameProperty': each(() => a.name()); break; // inline archives: the same as a string
    case 'ObjectProperty': each(() => readObject(a, 8)); break;
    default: throw new RangeError(`unknown array element type ${p.inner}`);
  }
  p.value = items;
}

function readValue(a: Archive, p: Property, size: number, notes: TreeNotes | undefined): void {
  switch (p.type) {
    case 'IntProperty': p.value = a.i32(); return;
    case 'UInt32Property': p.value = a.u32(); return;
    case 'Int16Property': p.value = a.i16(); return;
    case 'UInt16Property': p.value = a.u16(); return;
    case 'Int8Property': p.value = a.i8(); return;
    case 'Int64Property': p.value = a.i64n(); return;
    case 'UInt64Property': p.value = a.u64n(); return;
    case 'FloatProperty': p.value = a.f32raw(); return;
    case 'DoubleProperty': p.value = a.f64raw(); return;
    case 'StrProperty': p.value = a.string(); return;
    case 'NameProperty': p.value = a.name(); return;
    case 'ObjectProperty': p.value = readObject(a, size); return;
    case 'ByteProperty': p.value = p.inner === 'None' ? a.u8() : a.name(); return;
    case 'StructProperty':
      p.value = isNativeStruct(p.inner) ? readNative(a, p.inner) : readPropertyList(a, notes);
      return;
    case 'ArrayProperty': readArray(a, p, size, notes); return;
  }
  throw new RangeError(`unknown property type ${p.type}`);
}

/** Property lists and struct arrays of property lists check their children; everything else is a leaf. */
function isLeaf(p: Property): boolean {
  if (p.type === 'StructProperty') return isNativeStruct(p.inner);
  if (p.type === 'ArrayProperty') return !(p.inner === 'StructProperty' && !p.elementStruct && Array.isArray(p.value) && p.value.length > 0);
  return true;
}

function readProperty(a: Archive, name: string, notes: TreeNotes | undefined): Property {
  const type = a.name();
  if (type === null) throw new RangeError(`property ${name} without type at ${a.pos - 4}`);
  const size = a.i32();
  const index = a.i32();
  const p: Property = { name, type, index, value: null };
  if (type === 'BoolProperty') {
    if (size !== 0) throw new RangeError(`BoolProperty ${name} with size ${size}`);
    const byte = a.u8();
    p.value = byte !== 0;
    if (byte > 1) { p.raw = a.buf.subarray(a.pos - 1, a.pos); p.rawValue = p.value; }
    return p;
  }
  if (type === 'StructProperty' || type === 'ArrayProperty' || type === 'ByteProperty') p.inner = a.name();
  const start = a.pos;
  const end = start + size;
  if (size < 0 || end > a.length) throw new RangeError(`${type} ${name} of ${size} bytes at ${start} beyond end ${a.length}`);
  try {
    readValue(a, p, size, notes);
    if (a.pos !== end) throw new RangeError(`ends at ${a.pos}, size says ${end}`);
  } catch (e) {
    note(notes, `opaque ${type}${p.inner ? `<${p.inner}>` : ''}: ${(e as Error).message.replace(/\d+/g, 'N')}`);
    a.pos = start;
    p.value = a.bytes(size);
    p.opaque = true;
    delete p.elementStruct;
    return p;
  }
  if (isLeaf(p)) {
    const original = a.buf.subarray(start, end);
    if (!encodeBody(p, a.table).equals(original)) {
      p.raw = original;
      p.rawValue = cloneValue(p.value);
      note(notes, `kept original bytes of ${type}${p.inner ? `<${p.inner}>` : ''}`);
    }
  }
  return p;
}

/** Reads properties up to and including the terminating "None". */
export function readPropertyList(a: Archive, notes?: TreeNotes): Property[] {
  const list: Property[] = [];
  for (;;) {
    const at = a.pos;
    const name = a.name();
    if (name === 'None') return list;
    if (name === null) throw new RangeError(`property list without "None" at ${at}`);
    list.push(readProperty(a, name, notes));
  }
}

// ---------------------------------------------------------------- writing

function toBigInt(v: TreeValue, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new TypeError(`${what}: ${String(v)} is not an integer`);
}

function num(v: TreeValue, what: string): number {
  if (typeof v !== 'number') throw new TypeError(`${what}: ${String(v)} is not a number`);
  return v;
}

function str(v: TreeValue, what: string): string | null {
  if (v !== null && typeof v !== 'string') throw new TypeError(`${what}: expected a string`);
  return v;
}

function writeNative(w: BinaryWriter, t: string, v: TreeValue): void {
  const o = v as NativeValue;
  for (const [field, kind] of NATIVE_LAYOUT[t]) {
    const x = o[field];
    if (kind === 'str') w.string(str(x, `${t}.${field}`));
    else if (kind === 'f32') w.f32(num(x, `${t}.${field}`));
    else if (kind === 'u8') w.u8(num(x, `${t}.${field}`));
    else w.i32(num(x, `${t}.${field}`));
  }
}

function writeObject(w: BinaryWriter, v: TreeValue, what: string): void {
  const o = v as ObjectValue;
  if (o === null || typeof o !== 'object') throw new TypeError(`${what}: expected an object reference`);
  if ('path' in o) { w.i32(1).name(o.path); return; }
  if (o.short) w.i32(o.index);
  else w.i32(0).i32(o.index);
}

function writeElement(w: BinaryWriter, t: string | null | undefined, v: TreeValue, what: string): void {
  switch (t) {
    case 'IntProperty': w.i32(num(v, what)); return;
    case 'UInt32Property': w.u32(num(v, what)); return;
    case 'Int16Property': w.i16(num(v, what)); return;
    case 'UInt16Property': w.u16(num(v, what)); return;
    case 'Int8Property': w.i8(num(v, what)); return;
    case 'Int64Property': w.i64(toBigInt(v, what)); return;
    case 'UInt64Property': w.u64(toBigInt(v, what)); return;
    case 'FloatProperty': w.f32(num(v, what)); return;
    case 'DoubleProperty': w.f64(num(v, what)); return;
    case 'BoolProperty': w.u8(v ? 1 : 0); return;
    case 'StrProperty': w.string(str(v, what)); return;
    case 'NameProperty': w.name(str(v, what)); return;
    case 'ObjectProperty': writeObject(w, v, what); return;
  }
  throw new TypeError(`${what}: cannot write ${t}`);
}

function writeValue(w: BinaryWriter, p: Property): void {
  const what = p.name;
  const v = p.value;
  switch (p.type) {
    case 'ObjectProperty': writeObject(w, v, what); return;
    case 'ByteProperty':
      if (p.inner === 'None') w.u8(num(v, what));
      else w.name(str(v, what));
      return;
    case 'StructProperty':
      if (isNativeStruct(p.inner)) writeNative(w, p.inner, v);
      else writePropertyList(w, v as Property[]);
      return;
    case 'ArrayProperty': {
      if (Buffer.isBuffer(v)) {
        if (p.inner !== 'ByteProperty') throw new TypeError(`${what}: bytes for an array of ${p.inner}`);
        w.i32(v.length).bytes(v);
        return;
      }
      if (!Array.isArray(v)) throw new TypeError(`${what}: expected an array`);
      w.i32(v.length);
      if (p.inner === 'StructProperty') {
        const st = p.elementStruct;
        for (const e of v) {
          if (st) writeNative(w, st, e);
          else writePropertyList(w, e as Property[]);
        }
      } else if (p.inner === 'ByteProperty') {
        for (const e of v) w.name(str(e, what));
      } else {
        for (const e of v) writeElement(w, p.inner, e, what);
      }
      return;
    }
  }
  writeElement(w, p.type, v, what);
}

function writeBody(w: BinaryWriter, p: Property): void {
  if (p.opaque) {
    if (!Buffer.isBuffer(p.value)) throw new TypeError(`${p.name}: opaque value must stay bytes`);
    w.bytes(p.value);
  } else if (p.raw && p.rawValue !== undefined && sameValue(p.value, p.rawValue)) {
    w.bytes(p.raw);
  } else {
    writeValue(w, p);
  }
}

function encodeBody(p: Property, names: NameTable | null): Buffer {
  const w = new BinaryWriter(64, names);
  writeValue(w, p);
  return w.toBuffer();
}

export function writeProperty(w: BinaryWriter, p: Property): void {
  w.name(p.name).name(p.type);
  if (p.type === 'BoolProperty') {
    w.i32(0).i32(p.index);
    if (p.raw && p.rawValue !== undefined && sameValue(p.value, p.rawValue)) w.bytes(p.raw);
    else w.u8(p.value ? 1 : 0);
    return;
  }
  const sizeAt = w.length;
  w.i32(0).i32(p.index);
  if (p.type === 'StructProperty' || p.type === 'ArrayProperty' || p.type === 'ByteProperty') w.name(p.inner ?? null);
  const start = w.length;
  writeBody(w, p);
  w.patchI32(sizeAt, w.length - start);
}

export function writePropertyList(w: BinaryWriter, list: Property[]): void {
  for (const p of list) writeProperty(w, p);
  w.name('None');
}

// ---------------------------------------------------------------- values

export function sameValue(a: TreeValue | undefined, b: TreeValue | undefined): boolean {
  if (Object.is(a, b)) return true;
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ob = b as Record<string, TreeValue>;
  for (const k of ka) if (!(k in ob) || !sameValue((a as Record<string, TreeValue>)[k], ob[k])) return false;
  return true;
}

export function cloneValue<T extends TreeValue>(v: T): T {
  if (Buffer.isBuffer(v)) return Buffer.from(v) as T;
  if (Array.isArray(v)) return v.map((x) => cloneValue(x)) as T;
  if (v !== null && typeof v === 'object') {
    const out: Record<string, TreeValue> = {};
    for (const [k, x] of Object.entries(v)) out[k] = cloneValue(x as TreeValue);
    return out as T;
  }
  return v;
}

/** Deep copy of a property (e.g. to use an existing item as template). */
export function cloneProperty(p: Property): Property {
  const out: Property = { ...p, value: cloneValue(p.value) };
  if (p.raw) out.raw = Buffer.from(p.raw);
  if (p.rawValue !== undefined) out.rawValue = cloneValue(p.rawValue);
  return out;
}

/**
 * Forgets the original bytes kept for unusual encodings. Needed before a tree goes into an archive
 * of the other kind (name table <-> inline names): stored bytes of one kind are wrong in the other.
 */
export function dropRawBytes(list: Property[]): void {
  for (const p of list) {
    delete p.raw;
    delete p.rawValue;
    if (p.opaque) continue;
    if (p.type === 'StructProperty' && Array.isArray(p.value) && !isNativeStruct(p.inner)) dropRawBytes(p.value as Property[]);
    if (p.type === 'ArrayProperty' && p.inner === 'StructProperty' && !p.elementStruct && Array.isArray(p.value)) {
      for (const e of p.value as Property[][]) dropRawBytes(e);
    }
  }
}

export function findProperty(list: Property[], name: string, index = 0): Property | undefined {
  return list.find((p) => p.name === name && p.index === index);
}

// ---------------------------------------------------------------- object references

/** Where an index reference sits: the property (and array position) holding it. */
export interface RefSite {
  /** Property path from the list given, e.g. ["MyData", "Items"]. */
  path: string[];
  property: Property;
  /** Position in an ObjectProperty array, -1 for a single reference. */
  element: number;
  index: number;
}

function isIndexRef(v: TreeValue): v is { index: number; short?: true } {
  return v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !Array.isArray(v) && 'index' in v && typeof (v as { index: unknown }).index === 'number';
}

/**
 * Calls fn for every object-table reference in a property list, nested structs and struct arrays
 * included. Byte arrays (cryopod contents) are not entered: their indices point into their own table.
 */
export function forEachRef(list: Property[], fn: (site: RefSite) => void, path: string[] = []): void {
  for (const p of list) {
    if (p.opaque) continue;
    const here = [...path, p.name];
    if (p.type === 'ObjectProperty') {
      if (isIndexRef(p.value)) fn({ path: here, property: p, element: -1, index: p.value.index });
    } else if (p.type === 'StructProperty') {
      if (!isNativeStruct(p.inner) && Array.isArray(p.value)) forEachRef(p.value as Property[], fn, here);
    } else if (p.type === 'ArrayProperty' && Array.isArray(p.value)) {
      const items = p.value as TreeValue[];
      if (p.inner === 'ObjectProperty') {
        items.forEach((e, i) => { if (isIndexRef(e)) fn({ path: here, property: p, element: i, index: e.index }); });
      } else if (p.inner === 'StructProperty' && !p.elementStruct) {
        for (const e of items) forEachRef(e as Property[], fn, here);
      }
    }
  }
}

/**
 * Rewrites every object-table reference: map returns the new index (-1 = none). With dropFromArrays,
 * array elements that map to -1 are removed instead of being set to -1.
 */
export function remapRefs(list: Property[], map: (index: number) => number, dropFromArrays = false): boolean {
  let changed = false;
  for (const p of list) {
    if (p.opaque) continue;
    if (p.type === 'ObjectProperty') {
      if (isIndexRef(p.value) && p.value.index !== -1) {
        const n = map(p.value.index);
        if (n !== p.value.index) { p.value = { ...p.value, index: n }; changed = true; }
      }
    } else if (p.type === 'StructProperty') {
      if (!isNativeStruct(p.inner) && Array.isArray(p.value)) changed = remapRefs(p.value as Property[], map, dropFromArrays) || changed;
    } else if (p.type === 'ArrayProperty' && Array.isArray(p.value)) {
      const items = p.value as TreeValue[];
      if (p.inner === 'ObjectProperty') {
        const out: TreeValue[] = [];
        for (const e of items) {
          if (!isIndexRef(e) || e.index === -1) { out.push(e); continue; }
          const n = map(e.index);
          if (n !== e.index) changed = true;
          if (n === -1 && dropFromArrays) continue;
          out.push(n === e.index ? e : { ...e, index: n });
        }
        p.value = out;
      } else if (p.inner === 'StructProperty' && !p.elementStruct) {
        for (const e of items) changed = remapRefs(e as Property[], map, dropFromArrays) || changed;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------- export value model

function nativeToValue(t: string, v: NativeValue): Value {
  const out: { [k: string]: Value } = {};
  const fields = t === 'Color' ? ['r', 'g', 'b', 'a'] : NATIVE_LAYOUT[t].map(([f]) => f);
  for (const f of fields) {
    const x = v[f];
    out[f] = typeof x === 'number' && NATIVE_LAYOUT[t].find(([n]) => n === f)?.[1] === 'f32' ? float32(x) : x;
  }
  return out;
}

function objectToValue(o: ObjectValue): Value {
  return 'path' in o ? new PathRef(o.path) : new ObjectRef(o.index);
}

function elementToValue(t: string | null | undefined, v: TreeValue): Value {
  switch (t) {
    case 'FloatProperty': return float32(v as number);
    case 'DoubleProperty': return float64(v as number);
    case 'Int64Property': case 'UInt64Property': return String(v);
    case 'ObjectProperty': return objectToValue(v as ObjectValue);
  }
  return v as Value;
}

/** The same value the export reader (properties.ts) produces for this property. */
export function propertyToValue(p: Property, ctx: ReadContext): Value {
  const v = p.value;
  if (p.opaque) return new Blob(v as Buffer, `${p.type}${p.inner ? `<${p.inner}>` : ''}`);
  switch (p.type) {
    case 'StructProperty':
      return isNativeStruct(p.inner) ? nativeToValue(p.inner, v as NativeValue) : treeToProps(v as Property[], ctx);
    case 'ArrayProperty': {
      if (Buffer.isBuffer(v)) {
        const decoded = ctx.decodeBytes ? ctx.decodeBytes(p.name, v, ctx) : null;
        if (decoded !== null) return decoded;
        ctx.keepRaw(`byte array ${p.name}`, v.length);
        return new Blob(v, 'bytes');
      }
      const items = v as TreeValue[];
      if (p.inner === 'StructProperty') {
        const st = p.elementStruct;
        return items.map((e) => (st ? nativeToValue(st, e as NativeValue) : treeToProps(e as Property[], ctx)));
      }
      return items.map((e) => elementToValue(p.inner, e));
    }
  }
  return elementToValue(p.type, v);
}

/** Property list in the export value model: name[index] keys, numbers formatted like properties.ts. */
export function treeToProps(list: Property[], ctx: ReadContext): Props {
  const props: Props = {};
  for (const p of list) {
    let key = p.index ? `${p.name}[${p.index}]` : p.name;
    for (let n = 2; key in props; n++) key = `${p.index ? `${p.name}[${p.index}]` : p.name}#${n}`;
    props[key] = propertyToValue(p, ctx);
  }
  return props;
}

// ---------------------------------------------------------------- containers

export interface TreeObject {
  /** 16 bytes. */
  guid: Buffer;
  cls: string | null;
  /** The int32 values of the header, kept as found (flags, data file). */
  isItem: number;
  names: (string | null)[];
  fromDataFile: number;
  dataFile: number;
  hasLocation: number;
  /** 6 floats (x, y, z, pitch, yaw, roll) when hasLocation is non-zero. */
  location: Buffer | null;
  /** int32 after the property offset, 0 in all files seen. */
  headerTail: number;
  props: Property[];
  /** Bytes between the end of the property list and the next list (or the end): usually int32 0. */
  extra: Buffer;
}

export interface TreeContainer {
  /** Leading int32 (1 for profiles and tribes, 4 for cluster files); null for cryopod payloads. */
  version: number | null;
  objects: TreeObject[];
  /** Bytes between the object headers and the first property list. */
  gap: Buffer;
  /** Object indices in the order their property lists are stored. */
  order: number[];
}

/** Object headers plus property lists at offsets from the start of the buffer, every byte kept. */
export function readContainerTree(buf: Buffer, opts: { version?: boolean; notes?: TreeNotes } = {}): TreeContainer {
  const a = new Archive(buf, null);
  const version = opts.version === false ? null : a.i32();
  const count = a.i32();
  if (count < 0 || count > 100_000) throw new RangeError(`container claims ${count} objects`);
  const objects: TreeObject[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    const guid = a.bytes(16);
    const cls = a.name();
    const isItem = a.i32();
    const nameCount = a.i32();
    if (nameCount < 0 || nameCount > 64) throw new RangeError(`object ${i} has ${nameCount} names`);
    const names: (string | null)[] = [];
    for (let k = 0; k < nameCount; k++) names.push(a.name());
    const fromDataFile = a.i32();
    const dataFile = a.i32();
    const hasLocation = a.i32();
    const location = hasLocation !== 0 ? a.bytes(24) : null;
    offsets.push(a.i32());
    const headerTail = a.i32();
    objects.push({ guid, cls, isItem, names, fromDataFile, dataFile, hasLocation, location, headerTail, props: [], extra: Buffer.alloc(0) });
  }
  const headerEnd = a.pos;
  const order = Array.from(objects.keys()).sort((x, y) => offsets[x] - offsets[y]);
  const first = order.length ? offsets[order[0]] : buf.length;
  if (first < headerEnd || first > buf.length) throw new RangeError(`first property list at ${first}, headers end at ${headerEnd}`);
  const gap = buf.subarray(headerEnd, first);
  for (let k = 0; k < order.length; k++) {
    const o = objects[order[k]];
    const next = k + 1 < order.length ? offsets[order[k + 1]] : buf.length;
    a.pos = offsets[order[k]];
    o.props = readPropertyList(a, opts.notes);
    if (a.pos > next) throw new RangeError(`property list of object ${order[k]} overlaps the next one`);
    o.extra = buf.subarray(a.pos, next);
  }
  return { version, objects, gap, order };
}

export function writeContainerTree(c: TreeContainer): Buffer {
  const w = new BinaryWriter(64 * 1024);
  if (c.version !== null) w.i32(c.version);
  w.i32(c.objects.length);
  const offsetAt: number[] = [];
  for (const o of c.objects) {
    if (o.guid.length !== 16) throw new RangeError('object GUID must have 16 bytes');
    w.bytes(o.guid).name(o.cls).i32(o.isItem).i32(o.names.length);
    for (const n of o.names) w.name(n);
    w.i32(o.fromDataFile).i32(o.dataFile).i32(o.hasLocation);
    if (o.hasLocation !== 0) {
      if (!o.location || o.location.length !== 24) throw new RangeError('object location must have 24 bytes');
      w.bytes(o.location);
    }
    offsetAt.push(w.length);
    w.i32(0).i32(o.headerTail);
  }
  w.bytes(c.gap);
  const order = c.order.length === c.objects.length ? c.order : Array.from(c.objects.keys());
  for (const i of order) {
    w.patchI32(offsetAt[i], w.length);
    writePropertyList(w, c.objects[i].props);
    w.bytes(c.objects[i].extra);
  }
  return w.toBuffer();
}

/** Header fields in the shape of the export reader (objects.ts), for tools that expect GameObjects. */
export function treeObjectToGameObject(o: TreeObject, index: number, ctx: ReadContext): GameObject {
  let loc: GameObject['loc'] = null;
  if (o.location) {
    const f = (k: number) => float32(o.location!.readFloatLE(k * 4));
    loc = { x: f(0), y: f(1), z: f(2), pitch: f(3), yaw: f(4), roll: f(5) };
  }
  const zero = o.guid.every((b) => b === 0);
  return {
    index, guid: zero ? null : o.guid.toString('hex'), cls: o.cls ?? '', isItem: o.isItem !== 0,
    names: o.names.map((n) => n ?? ''), fromDataFile: o.fromDataFile !== 0, dataFile: o.dataFile, loc,
    propOffset: -1, props: treeToProps(o.props, ctx), extra: undefined, error: undefined,
  };
}
