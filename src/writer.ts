// Little-endian binary writer, the counterpart of Archive for inline-named archives (profiles,
// tribes, cluster files, cryopod contents). Names are written as FStrings; name tables are not supported.

/** UE4 writes an FString as single bytes only when every character is 7-bit ASCII, otherwise as UTF-16LE. */
export function isPureAnsi(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

export class BinaryWriter {
  private buf: Buffer;
  private size = 0;

  constructor(initial = 4096) { this.buf = Buffer.allocUnsafe(initial); }

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

  /** Inline FName. */
  name(s: string | null): this { return this.string(s); }

  toBuffer(): Buffer { return Buffer.from(this.buf.subarray(0, this.size)); }
}
