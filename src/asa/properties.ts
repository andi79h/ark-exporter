// Unreal Engine 5 property lists as stored by ARK: Survival Ascended.
//
// Two tag layouts are in use:
// - UE 5.5 (world save version 14, .arkprofile/.arktribe version 7, cryopod version 0x407 and newer):
//   name, type tree (FPropertyTypeName: name + parameter count, recursively), int32 size, uint8 flags,
//   [int32 array index], [16-byte property GUID], [extension byte]. Booleans keep their value in the
//   flags. Struct, enum, element, key and value types are all in the type tree.
// - older (world save version 13, older archives): UE4 style: name, type, int32 size, int32 index,
//   type-specific names (struct name + struct GUID, enum name, element type, key and value type),
//   uint8 "has property GUID" [+ GUID].
// Vectors, rotators and quaternions are doubles (large world coordinates). Every top-level value
// ends at (start + size), which lets the reader resynchronise after anything unknown.
import { Blob, GuidRef, ObjectRef, PathRef, type Props, type ReadContext, type Value } from '../types.ts';
import type { AsaArchive } from './archive.ts';

export interface TypeName { name: string; params: TypeName[] }

const T = (name: string, ...params: TypeName[]): TypeName => ({ name, params });

export function typeString(t: TypeName): string {
  return t.params.length ? `${t.name}<${t.params.map(typeString).join(',')}>` : t.name;
}

function readTypeName(a: AsaArchive, depth = 0): TypeName {
  const name = a.name() ?? '';
  const n = a.i32();
  if (n < 0 || n > 8 || depth > 8) throw new RangeError(`type ${name} with ${n} parameters`);
  const params: TypeName[] = new Array(n);
  for (let i = 0; i < n; i++) params[i] = readTypeName(a, depth + 1);
  return { name, params };
}

// EPropertyTagFlags (UE 5.4+)
const HAS_ARRAY_INDEX = 0x01;
const HAS_PROPERTY_GUID = 0x02;
const HAS_EXTENSIONS = 0x04;
const BINARY_OR_NATIVE = 0x08;
const BOOL_TRUE = 0x10;
const SKIPPED = 0x20;
const KNOWN_FLAGS = 0x3f;

interface Tag { type: TypeName; size: number; index: number; flags: number; bool: boolean }

function readTag55(a: AsaArchive, ctx: ReadContext): Tag {
  const type = readTypeName(a);
  const size = a.i32();
  const flags = a.u8();
  const index = flags & HAS_ARRAY_INDEX ? a.i32() : 0;
  if (flags & HAS_PROPERTY_GUID) {
    ctx.saw(`property tag with property GUID (${ctx.owner || '?'})`);
    a.skip(16);
  }
  if (flags & HAS_EXTENSIONS) {
    const ext = a.u8();
    ctx.note(`property tag extensions 0x${ext.toString(16)}`);
    if (ext & 0x02) { a.u8(); a.i32(); } // overridable operation, experimental-logic flag
  }
  if (flags & ~KNOWN_FLAGS) ctx.note(`property tag flags 0x${flags.toString(16)}`);
  if (flags & BINARY_OR_NATIVE) ctx.saw(`native-serialized ${typeString(type)}`);
  return { type, size, index, flags, bool: (flags & BOOL_TRUE) !== 0 };
}

function readTagLegacy(a: AsaArchive, ctx: ReadContext): Tag {
  const typeName = a.name() ?? '';
  const size = a.i32();
  const index = a.i32();
  let type: TypeName;
  let bool = false;
  switch (typeName) {
    case 'StructProperty': {
      type = T(typeName, T(a.name() ?? ''));
      a.skip(16); // struct GUID
      break;
    }
    case 'ByteProperty': case 'EnumProperty': type = T(typeName, T(a.name() ?? 'None')); break;
    case 'ArrayProperty': case 'SetProperty': type = T(typeName, T(a.name() ?? '')); break;
    case 'MapProperty': { const k = a.name() ?? ''; type = T(typeName, T(k), T(a.name() ?? '')); break; }
    case 'BoolProperty': bool = a.u8() !== 0; type = T(typeName); break;
    default: type = T(typeName);
  }
  if (a.u8() !== 0) {
    ctx.note('property tag with property GUID');
    a.skip(16);
  }
  return { type, size, index, flags: 0, bool };
}

/** World save: uint16 marker 1 = by name, else the object's GUID. Archives: int32 kind. */
function objectRef(a: AsaArchive, ctx: ReadContext): Value {
  if (a.format.refs === 'save') {
    const marker = a.u16();
    if (marker === 1) return new PathRef(a.name());
    if (marker !== 0) ctx.note(`ObjectProperty marker ${marker}`);
    return new GuidRef(a.uuid());
  }
  const kind = a.i32();
  if (kind === -1) return null;
  if (kind === 0) return new ObjectRef(a.i32());
  if (kind === 1) return new PathRef(a.string());
  ctx.note(`ObjectProperty with unknown reference kind ${kind}`);
  a.pos -= 4;
  return new PathRef(a.string());
}

/** FSoftObjectPath: asset path name(s), then the sub-path string. */
function softObject(a: AsaArchive): Value {
  if (a.format.names.kind === 'inline') {
    const parts: Value[] = [];
    for (let s = a.string(); s !== null && parts.length < 8; s = a.string()) parts.push(s);
    return { $soft: parts };
  }
  const parts: Value[] = [a.name()];
  while (a.remaining >= 4 && a.peekI32() !== 0 && parts.length < 4) {
    // A non-zero int32 here is either another name id or a non-empty sub-path string.
    parts.push(a.name());
  }
  const sub = a.string();
  return sub === null ? { $soft: parts } : { $soft: parts, sub };
}

/** FText: flags, history type, then the history-specific fields. */
function text(a: AsaArchive): Value {
  const flags = a.i32();
  const history = a.i8();
  switch (history) {
    case -1: return a.i32() !== 0 ? { text: a.string() } : { text: null };
    case 0: return { namespace: a.string(), key: a.string(), source: a.string(), flags };
    case 11: return { table: a.name(), key: a.string() };
  }
  throw new RangeError(`FText history type ${history}`);
}

function readScalar(a: AsaArchive, type: string, ctx: ReadContext): Value {
  switch (type) {
    case 'IntProperty': return a.i32();
    case 'FloatProperty': return a.f32();
    case 'DoubleProperty': return a.f64();
    case 'StrProperty': return a.string();
    case 'NameProperty': return a.name();
    case 'UInt32Property': return a.u32();
    case 'Int64Property': return a.i64();
    case 'UInt64Property': return a.u64();
    case 'Int16Property': return a.i16();
    case 'UInt16Property': return a.u16();
    case 'Int8Property': return a.i8();
    case 'EnumProperty': return a.name();
    case 'ObjectProperty': case 'ClassProperty': case 'WeakObjectProperty': case 'LazyObjectProperty':
    case 'InterfaceProperty':
      return objectRef(a, ctx);
    case 'SoftObjectProperty': case 'SoftClassProperty': return softObject(a);
    case 'TextProperty': return text(a);
  }
  throw new RangeError(`unknown property type ${type}`);
}

const vec3 = (a: AsaArchive, single: boolean): Value => single
  ? { x: a.f32(), y: a.f32(), z: a.f32() }
  : { x: a.f64(), y: a.f64(), z: a.f64() };

/**
 * Structs with a fixed binary layout. `size` is the value size when known (top-level properties,
 * evenly sized array elements); it tells single from double precision. undefined = not native.
 */
function readNativeStruct(a: AsaArchive, name: string, size: number | null): Value | undefined {
  switch (name) {
    case 'Vector': case 'Vector3d': return vec3(a, size === 12);
    case 'Vector3f': return vec3(a, true);
    case 'Rotator': {
      const single = size === 12;
      return single
        ? { pitch: a.f32(), yaw: a.f32(), roll: a.f32() }
        : { pitch: a.f64(), yaw: a.f64(), roll: a.f64() };
    }
    case 'Vector2D': return size === 8 ? { x: a.f32(), y: a.f32() } : { x: a.f64(), y: a.f64() };
    case 'Quat': case 'Vector4': return size === 16
      ? { x: a.f32(), y: a.f32(), z: a.f32(), w: a.f32() }
      : { x: a.f64(), y: a.f64(), z: a.f64(), w: a.f64() };
    case 'LinearColor': return { r: a.f32(), g: a.f32(), b: a.f32(), a: a.f32() };
    case 'Color': {
      const b = a.u8(), g = a.u8(), r = a.u8(), alpha = a.u8();
      return { r, g, b, a: alpha };
    }
    case 'Guid': return a.uuid();
    case 'IntPoint': return { x: a.i32(), y: a.i32() };
    case 'IntVector': return { x: a.i32(), y: a.i32(), z: a.i32() };
    case 'DateTime': case 'Timespan': return a.i64();
    case 'Box': return { min: vec3(a, size === 25), max: vec3(a, size === 25), valid: a.u8() !== 0 };
    case 'SoftObjectPath': case 'SoftClassPath': return softObject(a);
    case 'CustomItemDataRef':
      if (size !== null && size !== 16) return undefined;
      return [a.i32(), a.i32(), a.i32(), a.i32()];
    case 'UniqueNetIdRepl': {
      const kind = a.u8();
      if (kind === 0 && size === 1) return { kind };
      const type = a.string();
      const len = a.u8();
      return { kind, type, id: a.bytes(len).toString('hex') };
    }
  }
  return undefined;
}

function readStruct(a: AsaArchive, name: string, size: number | null, ctx: ReadContext): Value {
  const native = readNativeStruct(a, name, size);
  if (native !== undefined) {
    ctx.saw(`struct ${name}`);
    return native;
  }
  ctx.saw(`struct ${name || '(unnamed)'} as property list`);
  return readAsaProperties(a, ctx);
}

/** One value inside an array, set or map (no tag, no size). */
function readElement(a: AsaArchive, t: TypeName, ctx: ReadContext, elemSize: number | null): Value {
  switch (t.name) {
    case 'BoolProperty': return a.u8() !== 0;
    case 'ByteProperty': return t.params[0] && t.params[0].name !== 'None' ? a.name() : a.u8();
    case 'StructProperty': return readStruct(a, t.params[0]?.name ?? '', elemSize, ctx);
    case 'ArrayProperty': case 'MapProperty': case 'SetProperty':
      throw new RangeError(`nested ${t.name}`);
  }
  return readScalar(a, t.name, ctx);
}

function evenSize(total: number | null, n: number): number | null {
  return total !== null && n > 0 && total % n === 0 ? total / n : null;
}

function readArray(a: AsaArchive, type: TypeName, size: number, prop: string, ctx: ReadContext): Value {
  let elem = type.params[0] ?? T('');
  const n = a.i32();
  if (n < 0 || n > size) throw new RangeError(`array ${prop} claims ${n} elements in ${size} bytes`);
  let body = size - 4;
  if (elem.name === 'StructProperty' && !a.format.ue55) {
    // Older layout: one inner tag for all elements, carrying the struct name.
    const start = a.pos;
    a.name(); a.name();
    const innerSize = a.i32();
    a.i32();
    elem = T('StructProperty', T(a.name() ?? ''));
    a.skip(16);
    if (a.u8() !== 0) a.skip(16);
    body = innerSize;
    if (innerSize !== size - 4 - (a.pos - start)) ctx.note('struct array inner size mismatch');
  }
  if (elem.name === 'ByteProperty' && size === n + 4) {
    // Plain bytes. Cryopods keep a whole serialized creature in here.
    const bytes = a.bytes(n);
    const decoded = ctx.decodeBytes ? ctx.decodeBytes(prop, bytes, ctx) : null;
    if (decoded !== null) return decoded;
    if (n) ctx.keepRaw(`byte array ${prop} (${ctx.owner || '?'})`, n);
    return new Blob(bytes, 'bytes');
  }
  const elemSize = evenSize(body, n);
  const out: Value[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = readElement(a, elem, ctx, elemSize);
  return out;
}

function readSet(a: AsaArchive, type: TypeName, ctx: ReadContext): Value {
  const elem = type.params[0] ?? T('');
  const removed = a.i32();
  if (removed !== 0) ctx.note('set with elements to remove');
  for (let i = 0; i < removed; i++) readElement(a, elem, ctx, null);
  const n = a.i32();
  if (n < 0 || n > a.remaining) throw new RangeError(`set claims ${n} elements`);
  const out: Value[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = readElement(a, elem, ctx, null);
  return out;
}

/** Maps become a list of { key, value } (keys can be structs). */
function readMap(a: AsaArchive, type: TypeName, ctx: ReadContext): Value {
  const k = type.params[0] ?? T('');
  const v = type.params[1] ?? T('');
  const removed = a.i32();
  if (removed !== 0) ctx.note('map with keys to remove');
  for (let i = 0; i < removed; i++) readElement(a, k, ctx, null);
  const n = a.i32();
  if (n < 0 || n > a.remaining) throw new RangeError(`map claims ${n} entries`);
  const out: Value[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const key = readElement(a, k, ctx, null);
    out[i] = { key, value: readElement(a, v, ctx, null) };
  }
  return out;
}

function readTop(a: AsaArchive, tag: Tag, prop: string, ctx: ReadContext): Value {
  switch (tag.type.name) {
    case 'BoolProperty': return tag.bool;
    case 'ByteProperty': return tag.size === 1 ? a.u8() : a.name();
    case 'StructProperty': return readStruct(a, tag.type.params[0]?.name ?? '', tag.size, ctx);
    case 'ArrayProperty': return readArray(a, tag.type, tag.size, prop, ctx);
    case 'SetProperty': return readSet(a, tag.type, ctx);
    case 'MapProperty': return readMap(a, tag.type, ctx);
  }
  return readScalar(a, tag.type.name, ctx);
}

/** Error messages without positions and counts, so the issue list groups them. */
const generic = (e: unknown): string => String((e as Error).message ?? e).replace(/\d+/g, 'N');

/** Reads properties until the terminating "None" name. */
export function readAsaProperties(a: AsaArchive, ctx: ReadContext): Props {
  const props: Props = {};
  for (;;) {
    let name = a.name();
    if (name === null || name === 'None') return props;
    const tag = a.format.ue55 ? readTag55(a, ctx) : readTagLegacy(a, ctx);
    if (tag.index !== 0) name = `${name}[${tag.index}]`;
    if (name in props) {
      ctx.note('duplicate property name');
      name = `${name}#${a.pos}`;
    }
    const start = a.pos;
    const end = start + tag.size;
    if (tag.size < 0 || end > a.length) throw new RangeError(`property ${name} with size ${tag.size} beyond the end`);
    const ts = typeString(tag.type);
    ctx.saw(ts);
    let value: Value;
    if (tag.flags & SKIPPED) {
      ctx.note(`skipped-serialize ${ts}`);
      ctx.keepRaw(`skipped-serialize ${ts}`, tag.size);
      value = new Blob(a.bytes(tag.size), `${ts}: skipped`);
    } else {
      try {
        value = readTop(a, tag, name, ctx);
      } catch (e) {
        // Keep the bytes and carry on with the next property: the size tells us where it starts.
        ctx.note(`unreadable ${ts}: ${generic(e)}`);
        ctx.keepRaw(`unreadable ${ts}`, tag.size);
        a.pos = start;
        value = new Blob(a.bytes(tag.size), `${ts}: ${(e as Error).message}`);
      }
    }
    if (a.pos !== end) {
      ctx.note(`size mismatch in ${ts}`);
      if (a.pos < end) ctx.keepRaw(`size mismatch in ${ts}`, end - a.pos);
      a.pos = end;
    }
    props[name] = value;
  }
}

