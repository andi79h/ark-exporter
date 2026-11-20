// Little-endian binary reader for ARK: Survival Evolved archives (.ark, .arkprofile, .arktribe,
// and the archives embedded in cryopods).

/** Shortest decimal that converts back to exactly the same float32. Keeps the JSON small and lossless. */
export function float32(v: number): number | string {
  if (Number.isInteger(v) && Math.abs(v) <= 16_777_216) return v;
  if (!Number.isFinite(v)) return String(v); // JSON has no NaN/Infinity
  for (let p = 6; p < 9; p++) {
    const x = +v.toPrecision(p);
    if (Math.fround(x) === v) return x;
  }
  return +v.toPrecision(9);
}

/** Doubles keep full precision; only non-finite values need a stand-in for JSON. */
export function float64(v: number): number | string {
  return Number.isFinite(v) ? v : String(v);
}

export class Archive {
  readonly buf: Buffer;
  readonly dv: DataView;
  pos: number;
  /** Name table of a .ark file. null means names are stored inline as strings (profiles, tribes, cryopods). */
  names: string[] | null;

  constructor(buf: Buffer, names: string[] | null = null, pos = 0) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.names = names;
    this.pos = pos;
  }

  get length(): number { return this.buf.length; }
  get remaining(): number { return this.buf.length - this.pos; }

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new RangeError(`read of ${n} bytes at ${this.pos} beyond end ${this.buf.length}`);
    }
  }

  u8(): number { this.need(1); return this.buf[this.pos++]; }
  i8(): number { this.need(1); return this.dv.getInt8(this.pos++); }
  i16(): number { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i32(): number { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  /** 64-bit integers are returned as decimal strings: most IDs exceed 2^53. */
  i64(): string { this.need(8); const v = this.dv.getBigInt64(this.pos, true); this.pos += 8; return v.toString(); }
  u64(): string { this.need(8); const v = this.dv.getBigUint64(this.pos, true); this.pos += 8; return v.toString(); }
  i64n(): bigint { this.need(8); const v = this.dv.getBigInt64(this.pos, true); this.pos += 8; return v; }
  f32raw(): number { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  f32(): number | string { return float32(this.f32raw()); }
  f64(): number | string { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return float64(v); }
  bool(): boolean { return this.i32() !== 0; }

  bytes(n: number): Buffer {
    this.need(n);
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  skip(n: number): void { this.need(n); this.pos += n; }

  /** FString: positive length = Latin-1 incl. NUL, negative length = UTF-16LE incl. NUL, 0 = null. */
  string(): string | null {
    const n = this.i32();
    if (n === 0) return null;
    if (n > 0) {
      this.need(n);
      const s = this.buf.toString('latin1', this.pos, this.pos + n - 1);
      this.pos += n;
      return s;
    }
    const len = -n * 2;
    this.need(len);
    const s = this.buf.toString('utf16le', this.pos, this.pos + len - 2);
    this.pos += len;
    return s;
  }

  /** FName: index into the name table plus instance number (rendered as name_N), or an inline string. */
  name(): string | null {
    if (this.names === null) return this.string();
    this.need(8);
    const idx = this.dv.getInt32(this.pos, true);
    const inst = this.dv.getInt32(this.pos + 4, true);
    this.pos += 8;
    const s = this.names[idx - 1];
    if (s === undefined) throw new RangeError(`name index ${idx} outside name table at ${this.pos - 8}`);
    return inst ? `${s}_${inst - 1}` : s;
  }
}
