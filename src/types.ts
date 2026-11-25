// Value model shared by all readers. Everything is plain JSON except the marker classes below.
// Their toJSON methods render them while JSON.stringify runs; references need the stable keys of
// the archive being serialized, which the normalizer puts into jsonContext beforehand.

export const jsonContext: {
  /** Stable key per object index of the archive currently being serialized. */
  keys: (string | null)[];
  /** Called for embedded archives; returns what to write in their place (their keys). */
  onEmbedded: ((e: Embedded) => Value) | null;
} = { keys: [], onEmbedded: null };

/** ObjectProperty pointing at an object by its position in the object table of the same archive. */
export class ObjectRef {
  readonly index: number;
  constructor(index: number) { this.index = index; }
  toJSON(): Value {
    if (this.index === -1) return null;
    const key = jsonContext.keys[this.index];
    return key == null ? { $index: this.index } : { $ref: key };
  }
}

/** ObjectProperty pointing at an object by its GUID (ARK: Survival Ascended world saves). */
export class GuidRef {
  readonly guid: string;
  constructor(guid: string) { this.guid = guid; }
  toJSON(): Value { return /^0+$/.test(this.guid) ? null : { $guid: this.guid }; }
}

/** ObjectProperty pointing at an object by path name (classes, assets). */
export class PathRef {
  readonly path: string | null;
  constructor(path: string | null) { this.path = path; }
  toJSON(): Value { return { $path: this.path }; }
}

/** Bytes kept undecoded (byte arrays that are not an embedded archive, unknown data). */
export class Blob {
  readonly bytes: Buffer;
  readonly note: string;
  constructor(bytes: Buffer, note: string) { this.bytes = bytes; this.note = note; }
  toJSON(): Value {
    const b64 = this.bytes.toString('base64');
    return this.note === 'bytes' ? { $bytes: b64 } : { $bytes: b64, $note: this.note };
  }
}

/** A byte array that turned out to be a complete embedded archive (e.g. a creature inside a cryopod). */
export class Embedded {
  readonly objects: GameObject[];
  constructor(objects: GameObject[]) { this.objects = objects; }
  toJSON(): Value {
    return jsonContext.onEmbedded ? jsonContext.onEmbedded(this) : { $objects: this.objects.length };
  }
}

export type Value =
  | null | boolean | number | string
  | Value[] | { [key: string]: Value }
  | ObjectRef | GuidRef | PathRef | Blob | Embedded;

export type Props = { [key: string]: Value };

export interface Location { x: number | string; y: number | string; z: number | string; pitch: number | string; yaw: number | string; roll: number | string; }

export interface GameObject {
  /** Position in the object table of its archive. */
  index: number;
  /** Hex GUID, null when all zero. */
  guid: string | null;
  cls: string;
  /** ASA: full class path from the name table (cls is its last segment). */
  clsPath?: string;
  isItem: boolean;
  /** Actor name first, then the names of its outer objects. */
  names: string[];
  fromDataFile: boolean;
  dataFile: number;
  loc: Location | null;
  propOffset: number;
  props: Props;
  /** Data stored after the property list (foliage, terminators, unknown bytes). */
  extra: Value | undefined;
  /** Set when the property list could not be read completely. */
  error: string | undefined;
}

/** Counts everything that was not decoded cleanly so the coverage report can show it. */
export class ReadContext {
  readonly issues = new Map<string, number>();
  readonly rawBytes = new Map<string, number>();
  /** What was read, for the coverage report (property and struct types; filled by the ASA reader). */
  readonly seen = new Map<string, number>();
  /** Decodes byte arrays (cryopods); returns null to keep the bytes. Set by the container readers. */
  decodeBytes: ((propName: string, bytes: Buffer, ctx: ReadContext) => Value | null) | null = null;
  /** Class of the object being read, so raw bytes in the report name their owner. */
  owner = '';

  note(what: string, n = 1): void {
    this.issues.set(what, (this.issues.get(what) ?? 0) + n);
  }

  saw(what: string, n = 1): void {
    this.seen.set(what, (this.seen.get(what) ?? 0) + n);
  }

  /** Folds the counters of a nested read (embedded archive) into this one. */
  absorb(other: ReadContext, prefix: string): void {
    for (const [k, v] of other.issues) this.note(`${prefix}${k}`, v);
    for (const [k, v] of other.rawBytes) this.keepRaw(`${prefix}${k}`, v);
    for (const [k, v] of other.seen) this.saw(`${prefix}${k}`, v);
  }

  keepRaw(what: string, bytes: number): void {
    this.rawBytes.set(what, (this.rawBytes.get(what) ?? 0) + bytes);
  }
}
