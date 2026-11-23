// Unreal property lists as stored by ARK: Survival Evolved (save version 9).
//
// Every property is: name, type, int32 size, int32 index, [type-specific header], value.
// Struct, Array and Byte properties carry one extra name (struct type, element type, enum type)
// before the value; BoolProperty stores its value in one byte after a size of 0. The value
// always ends at (start + size), which lets the reader resynchronise after anything unknown.
import { Archive } from './archive.ts';
import { Blob, ObjectRef, PathRef, type Props, type ReadContext, type Value } from './types.ts';

/** Struct arrays do not store their element type; these names are known to hold native structs. */
const ARRAY_NAME_TO_STRUCT: Record<string, string> = {
  CustomColors: 'Color',
  CustomColours_60_7D3267C846B277953C0C41AEBD54FBCB: 'LinearColor',
};

function objectRef(a: Archive, size: number, ctx: ReadContext): Value {
  if (size >= 8) {
    const kind = a.i32();
    if (kind === 0) return new ObjectRef(a.i32());
    if (kind === 1) return new PathRef(a.name());
    ctx.note(`ObjectProperty with unknown reference kind ${kind}`);
    a.pos -= 4;
    return new PathRef(a.name());
  }
  if (size === 4) return new ObjectRef(a.i32());
  ctx.note(`ObjectProperty with size ${size}`);
  a.skip(size);
  return null;
}

/** Native structs have a fixed binary layout; everything else is a nested property list. */
export function readStruct(a: Archive, structType: string | null, ctx: ReadContext): Value {
  switch (structType) {
    case 'Vector': return { x: a.f32(), y: a.f32(), z: a.f32() };
    case 'Rotator': return { pitch: a.f32(), yaw: a.f32(), roll: a.f32() };
    case 'Vector2D': return { x: a.f32(), y: a.f32() };
    case 'Quat': return { x: a.f32(), y: a.f32(), z: a.f32(), w: a.f32() };
    case 'LinearColor': return { r: a.f32(), g: a.f32(), b: a.f32(), a: a.f32() };
    case 'Color': {
      const b = a.u8(), g = a.u8(), r = a.u8(), alpha = a.u8();
      return { r, g, b, a: alpha };
    }
    case 'UniqueNetIdRepl': {
      const kind = a.i32();
      return { kind, id: a.string() };
    }
  }
  return readProperties(a, ctx);
}

function readArray(a: Archive, elementType: string | null, size: number, propName: string, ctx: ReadContext): Value {
  const n = a.i32();
  if (n < 0 || n > size) throw new RangeError(`array ${propName} claims ${n} elements in ${size} bytes`);
  const out: Value[] = new Array(n);
  switch (elementType) {
    case 'StructProperty': {
      let structType: string | null = ARRAY_NAME_TO_STRUCT[propName] ?? null;
      if (structType === null) {
        // Arrays of native structs are recognised by their exact byte size.
        if (n * 4 + 4 === size) structType = 'Color';
        else if (n * 12 + 4 === size) structType = 'Vector';
        else if (n * 16 + 4 === size) structType = 'LinearColor';
      }
      for (let i = 0; i < n; i++) out[i] = readStruct(a, structType, ctx);
      return out;
    }
    case 'IntProperty': for (let i = 0; i < n; i++) out[i] = a.i32(); return out;
    case 'UInt32Property': for (let i = 0; i < n; i++) out[i] = a.u32(); return out;
    case 'Int16Property': for (let i = 0; i < n; i++) out[i] = a.i16(); return out;
    case 'UInt16Property': for (let i = 0; i < n; i++) out[i] = a.u16(); return out;
    case 'Int8Property': for (let i = 0; i < n; i++) out[i] = a.i8(); return out;
    case 'Int64Property': for (let i = 0; i < n; i++) out[i] = a.i64(); return out;
    case 'UInt64Property': for (let i = 0; i < n; i++) out[i] = a.u64(); return out;
    case 'FloatProperty': for (let i = 0; i < n; i++) out[i] = a.f32(); return out;
    case 'DoubleProperty': for (let i = 0; i < n; i++) out[i] = a.f64(); return out;
    case 'BoolProperty': for (let i = 0; i < n; i++) out[i] = a.u8() !== 0; return out;
    case 'StrProperty': for (let i = 0; i < n; i++) out[i] = a.string(); return out;
    case 'NameProperty': for (let i = 0; i < n; i++) out[i] = a.name(); return out;
    case 'ObjectProperty': for (let i = 0; i < n; i++) out[i] = objectRef(a, 8, ctx); return out;
    case 'ByteProperty': {
      if (size === n + 4) {
        // Plain bytes. Cryopods keep a whole serialized creature in here.
        const bytes = a.bytes(n);
        const decoded = ctx.decodeBytes ? ctx.decodeBytes(propName, bytes, ctx) : null;
        if (decoded !== null) return decoded;
        ctx.keepRaw(`byte array ${propName}`, n);
        return new Blob(bytes, 'bytes');
      }
      for (let i = 0; i < n; i++) out[i] = a.name(); // enum values
      return out;
    }
  }
  ctx.note(`unknown array type ${elementType}`);
  a.pos -= 4;
  ctx.keepRaw(`unknown array type ${elementType}`, size);
  return new Blob(a.bytes(size), `Array<${elementType}>`);
}

function readSimple(a: Archive, type: string | null, size: number, ctx: ReadContext): Value {
  switch (type) {
    case 'IntProperty': return a.i32();
    case 'FloatProperty': return a.f32();
    case 'ObjectProperty': return objectRef(a, size, ctx);
    case 'StrProperty': return a.string();
    case 'NameProperty': return a.name();
    case 'UInt32Property': return a.u32();
    case 'Int64Property': return a.i64();
    case 'UInt64Property': return a.u64();
    case 'DoubleProperty': return a.f64();
    case 'Int16Property': return a.i16();
    case 'UInt16Property': return a.u16();
    case 'Int8Property': return a.i8();
  }
  ctx.note(`unknown property type ${type}`);
  ctx.keepRaw(`unknown property type ${type}`, size);
  return new Blob(a.bytes(size), String(type));
}

/** Reads properties until the terminating "None" name. */
export function readProperties(a: Archive, ctx: ReadContext): Props {
  const props: Props = {};
  for (;;) {
    let name = a.name();
    if (name === null || name === 'None') return props;
    const type = a.name();
    const size = a.i32();
    const index = a.i32();
    if (index !== 0) name = `${name}[${index}]`;
    if (name in props) {
      ctx.note('duplicate property name');
      name = `${name}#${a.pos}`;
    }
    if (type === 'BoolProperty') {
      props[name] = a.u8() !== 0;
      continue;
    }
    let start: number;
    let value: Value;
    if (type === 'StructProperty' || type === 'ArrayProperty') {
      const inner = a.name();
      start = a.pos;
      try {
        value = type === 'StructProperty' ? readStruct(a, inner, ctx) : readArray(a, inner, size, name, ctx);
      } catch (e) {
        // Keep the bytes and carry on with the next property: the size tells us where it starts.
        ctx.note(`unreadable ${type === 'StructProperty' ? `struct ${inner}` : `array of ${inner}`}`);
        ctx.keepRaw(`unreadable ${type}`, size);
        a.pos = start;
        value = new Blob(a.bytes(size), `${type}<${inner}>: ${(e as Error).message}`);
      }
    } else if (type === 'ByteProperty') {
      const enumType = a.name();
      start = a.pos;
      value = enumType === 'None' ? a.u8() : a.name();
    } else {
      start = a.pos;
      value = readSimple(a, type, size, ctx);
    }
    const end = start + size;
    if (a.pos !== end) {
      ctx.note(`size mismatch in ${type}`);
      a.pos = end;
    }
    props[name] = value;
  }
}
