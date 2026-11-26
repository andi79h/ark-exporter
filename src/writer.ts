// Little-endian binary writer, the counterpart of Archive. Without a name table, names are written
// inline as FStrings (profiles, tribes, cluster files, cryopod contents); with one (.ark files) as
// index into the table plus instance number.
import type { NameTable } from './nametable.ts';

/** UE4 writes an FString as single bytes only when every character is 7-bit ASCII, otherwise as UTF-16LE. */
export function isPureAnsi(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

export class BinaryWriter {
  private buf: Buffer;
  private size = 0;
  /** Name table of a .ark file; null writes names inline. */
  readonly names: NameTable | null;

  constructor(initial = 4096, names: NameTable | null = null) {
    this.buf = Buffer.allocUnsafe(initial);
    this.names = names;
  }

  get length(): number { return this.size; }

  private room(n: number): number {
    if (this.size + n > this.buf.length) {
      const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.size + n));
      this.buf.copy(next, 0, 0, this.size);
      this.buf = next;
    }
    const at = this.size;
    this.size += n;
    return at;
  }

  // room() may replace this.buf, so it has to run before this.buf is read.
  bytes(b: Uint8Array): this { const at = this.room(b.length); this.buf.set(b, at); return this; }
  u8(v: number): this { const at = this.room(1); this.buf.writeUInt8(v, at); return this; }
  i8(v: number): this { const at = this.room(1); this.buf.writeInt8(v, at); return this; }
  i16(v: number): this { const at = this.room(2); this.buf.writeInt16LE(v, at); return this; }
  u16(v: number): this { const at = this.room(2); this.buf.writeUInt16LE(v, at); return this; }
  i32(v: number): this { const at = this.room(4); this.buf.writeInt32LE(v, at); return this; }
  u32(v: number): this { const at = this.room(4); this.buf.writeUInt32LE(v, at); return this; }
  i64(v: bigint): this { const at = this.room(8); this.buf.writeBigInt64LE(v, at); return this; }
  u64(v: bigint): this { const at = this.room(8); this.buf.writeBigUInt64LE(v, at); return this; }
  f32(v: number): this { const at = this.room(4); this.buf.writeFloatLE(v, at); return this; }
  f64(v: number): this { const at = this.room(8); this.buf.writeDoubleLE(v, at); return this; }

  /** Overwrites an int32 written earlier (sizes and offsets that are only known afterwards). */
  patchI32(at: number, v: number): void { this.buf.writeInt32LE(v, at); }

  /** FString: null = length 0, ASCII = positive length incl. NUL, anything else = negative length, UTF-16LE. */
  string(s: string | null): this {
    if (s === null) return this.i32(0);
    if (isPureAnsi(s)) {
      this.i32(s.length + 1);
      const at = this.room(s.length + 1);
      this.buf.write(s, at, 'latin1');
      this.buf[at + s.length] = 0;
      return this;
    }
    this.i32(-(s.length + 1));
    const at = this.room((s.length + 1) * 2);
    this.buf.write(s, at, 'utf16le');
    this.buf.writeUInt16LE(0, at + s.length * 2);
    return this;
  }

  /** FName: inline string, or (index, instance) when the writer has a name table. */
  name(s: string | null): this {
    if (this.names === null) return this.string(s);
    if (s === null) throw new TypeError('a name table cannot store a null name');
    const [index, instance] = this.names.encode(s);
    return this.i32(index).i32(instance);
  }

  toBuffer(): Buffer { return Buffer.from(this.buf.subarray(0, this.size)); }
}
