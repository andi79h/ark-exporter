// Name table of a .ark file. Every FName in the file is stored as (index into this table, instance
// number); the reader renders it as "Name" (instance 0) or "Name_N" (instance N + 1).
//
// Writing needs the way back. Unreal splits a trailing "_<number>" off when it creates a name, so
// "Wall_Wood_C_12" is ("Wall_Wood_C", 13). The table keeps that rule, falls back to the whole string
// when the base is unknown, and appends names it has never seen (the old order is kept, as the game
// and Qowyn's toolkit do). Encodings observed while reading take precedence, so a name that the
// table holds in two spellings is written back exactly as it was read.

/** A trailing instance number as Unreal parses it: no leading zeros, fits into int32. */
const INSTANCE = /^(.*)_(0|[1-9]\d{0,9})$/;

export class NameTable {
  readonly names: string[];
  private readonly lookup = new Map<string, number>();
  /** Rendered name -> encoding seen while reading, only for names the default rule gets wrong. */
  private readonly overrides = new Map<string, [number, number]>();
  /** Number of names the file had; everything after that was added by encode(). */
  readonly originalSize: number;

  constructor(names: string[]) {
    this.names = names.slice();
    this.originalSize = names.length;
    for (let i = 0; i < this.names.length; i++) {
      if (!this.lookup.has(this.names[i])) this.lookup.set(this.names[i], i + 1);
    }
  }

  get added(): string[] { return this.names.slice(this.originalSize); }

  /** Rendered string of (1-based index, instance). */
  decode(index: number, instance: number): string {
    const s = this.names[index - 1];
    if (s === undefined) throw new RangeError(`name index ${index} outside name table`);
    return instance ? `${s}_${instance - 1}` : s;
  }

  /** Remembers how a name was stored when the default rule would store it differently. */
  observe(rendered: string, index: number, instance: number): void {
    const [i, n] = this.find(rendered) ?? [0, 0];
    if (i !== index || n !== instance) this.overrides.set(rendered, [index, instance]);
  }

  /** Encoding of an existing name, or null if the table cannot express it without a new entry. */
  find(s: string): [number, number] | null {
    const o = this.overrides.get(s);
    if (o) return o;
    const m = INSTANCE.exec(s);
    if (m) {
      const n = Number(m[2]) + 1;
      const base = this.lookup.get(m[1]);
      if (base !== undefined && n <= 0x7fffffff) return [base, n];
    }
    const whole = this.lookup.get(s);
    return whole === undefined ? null : [whole, 0];
  }

  /** Encoding of any name; unknown names are appended (base part only, like Unreal). */
  encode(s: string): [number, number] {
    const found = this.find(s);
    if (found) return found;
    const m = INSTANCE.exec(s);
    const n = m ? Number(m[2]) + 1 : 0;
    const base = m && n <= 0x7fffffff ? m[1] : s;
    this.names.push(base);
    this.lookup.set(base, this.names.length);
    return [this.names.length, base === s ? 0 : n];
  }
}
