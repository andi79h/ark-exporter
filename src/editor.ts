// Editing .ark world saves (ARK: Survival Evolved, save version 9) and writing them back.
//
// The editor keeps the original file in memory and only decodes what is touched:
// - Unchanged objects keep their header and property bytes. Only the property offset in the header
//   is rewritten, and object references are patched in place when deleted objects shift the indices.
// - Changed and new objects are kept as lossless property trees (tree.ts) and encoded on write,
//   names through the file's name table (new names are appended, the old order stays).
// - Everything else (data files, embedded data, data file object map, hibernation) is copied.
//
// Object references (ObjectProperty) are indices into the object table. The editor works in one
// index space: original objects keep their index, added objects get count, count + 1, ... and on
// write every reference is translated to the final table, references to deleted objects become -1.
//
// Layout written (same as the game): header, data files, embedded data, data file object map,
// object table, hibernation, name table, property block.
import { Archive } from './archive.ts';
import { NameTable } from './nametable.ts';
import { nativeArrayStruct } from './properties.ts';
import { forEachRef, isNativeStruct, type Property, readPropertyList, remapRefs, type TreeNotes, writePropertyList } from './tree.ts';
import { BinaryWriter } from './writer.ts';

export interface Transform { x: number; y: number; z: number; pitch: number; yaw: number; roll: number; }

/** One entry of the object table with its property list, decoded for editing. */
export interface SaveObject {
  /** 16 bytes, all zero for nearly every object. */
  guid: Buffer;
  cls: string;
  /** int32 as stored (1 for items). */
  isItem: number;
  /** Object name first, then its outer objects (components: the actor they belong to). */
  names: string[];
  fromDataFile: number;
  dataFile: number;
  /** World position and rotation in degrees; null for objects without one (items, components). */
  location: Transform | null;
  /** int32 after the property offset, 0 in all files seen. */
  headerTail: number;
  props: Property[];
  /** Bytes after the property list up to the next one (usually int32 0; foliage, player vectors). */
  extra: Buffer;
}

export interface WriteOptions {
  /**
   * Decode and re-encode every object instead of copying unchanged ones. Slow; used to prove that
   * the encoder reproduces the file byte for byte.
   */
  reencodeAll?: boolean;
  /** Patch references in unchanged objects even when no index moves (tests the patcher). */
  patchAll?: boolean;
}

const HEADER_V9 = 2 + 4 + 4 + 4 + 4 + 4 + 4;

export class SaveEditor {
  readonly buf: Buffer;
  readonly version: number;
  readonly table: NameTable;
  /** Objects in the file. Indices >= count belong to added objects. */
  readonly count: number;
  /** Game time of the save (seconds); all time stamps in the file are relative to it. */
  readonly gameTime: number;
  readonly saveCount: number;
  /** Class of every original object, by index. */
  readonly classes: string[];

  private readonly hibernationOffset: number;
  private readonly nameTableOffset: number;
  private readonly propertiesOffset: number;
  private readonly objectTableStart: number;
  private readonly objectTableEnd: number;
  private readonly hdrStart: Uint32Array;
  private readonly hdrEnd: Uint32Array;
  private readonly bodyStart: Uint32Array;
  private readonly bodyEnd: Uint32Array;
  /** Original object indices in the order their property lists are stored. */
  private readonly physOrder: Uint32Array;

  private readonly edits = new Map<number, SaveObject>();
  private readonly added: SaveObject[] = [];
  private readonly deleted = new Set<number>();

  private constructor(buf: Buffer) {
    this.buf = buf;
    const a = new Archive(buf);
    this.version = a.i16();
    if (this.version !== 9) throw new RangeError(`writing supports save version 9 only, file has ${this.version}`);
    this.hibernationOffset = a.i32();
    a.i32();
    this.nameTableOffset = a.i32();
    this.propertiesOffset = a.i32();
    this.gameTime = a.f32raw();
    this.saveCount = a.i32();
    if (a.pos !== HEADER_V9) throw new RangeError('unexpected header size');

    a.pos = this.nameTableOffset;
    const names: string[] = [];
    for (let n = a.i32(); n > 0; n--) names.push(a.string() ?? '');
    if (a.pos !== this.propertiesOffset) throw new RangeError(`name table ends at ${a.pos}, properties start at ${this.propertiesOffset}`);
    this.table = new NameTable(names);

    // Data files, embedded data, data file object map: skipped here, copied on write.
    a.pos = HEADER_V9;
    for (let n = a.i32(); n > 0; n--) a.string();
    for (let e = a.i32(); e > 0; e--) {
      a.string();
      for (let part = a.i32(); part > 0; part--) for (let blob = a.i32(); blob > 0; blob--) a.skip(a.i32() * 4);
    }
    for (let m = a.i32(); m > 0; m--) {
      a.i32();
      for (let s = a.i32(); s > 0; s--) a.string();
    }
    this.objectTableStart = a.pos;

    a.names = names;
    const count = a.i32();
    this.count = count;
    this.hdrStart = new Uint32Array(count);
    this.hdrEnd = new Uint32Array(count);
    this.classes = new Array(count);
    const offsets = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      this.hdrStart[i] = a.pos;
      a.skip(16);
      this.classes[i] = a.name() ?? '';
      a.skip(4);
      const nameCount = a.i32();
      if (nameCount < 0 || nameCount > 64) throw new RangeError(`object ${i} has ${nameCount} names`);
      a.skip(nameCount * 8 + 8);
      if (a.i32() !== 0) a.skip(24);
      offsets[i] = a.i32();
      a.skip(4);
      this.hdrEnd[i] = a.pos;
    }
    this.objectTableEnd = a.pos;
    if (this.objectTableEnd !== this.hibernationOffset) {
      throw new RangeError(`object table ends at ${this.objectTableEnd}, hibernation starts at ${this.hibernationOffset}`);
    }
    if (this.nameTableOffset < this.hibernationOffset) throw new RangeError('name table before hibernation data');

    const order = Array.from({ length: count }, (_, i) => i);
    order.sort((x, y) => offsets[x] - offsets[y] || x - y);
    this.physOrder = Uint32Array.from(order);
    this.bodyStart = new Uint32Array(count);
    this.bodyEnd = new Uint32Array(count);
    for (let k = 0; k < count; k++) {
      const i = order[k];
      const start = this.propertiesOffset + offsets[i];
      const end = k + 1 < count ? this.propertiesOffset + offsets[order[k + 1]] : buf.length;
      if (start < this.propertiesOffset || end > buf.length || end < start) throw new RangeError(`property list of object ${i} out of range`);
      this.bodyStart[i] = start;
      this.bodyEnd[i] = end;
    }
  }

  static open(buf: Buffer): SaveEditor { return new SaveEditor(buf); }

  /**
   * True when the hibernation block holds only the two empty stores of version 9 (48 bytes), as in
   * every save seen. Otherwise creatures may sit there, invisible to the editor (copied unchanged).
   */
  get hibernationEmpty(): boolean { return this.nameTableOffset - this.hibernationOffset <= 48; }

  /** Objects in the editor's index space, including added and deleted ones. */
  get size(): number { return this.count + this.added.length; }

  exists(i: number): boolean { return i >= 0 && i < this.size && !this.deleted.has(i); }
  isDeleted(i: number): boolean { return this.deleted.has(i); }
  isModified(i: number): boolean { return this.edits.has(i) || i >= this.count; }

  /** Class without decoding anything else. */
  cls(i: number): string {
    if (i >= this.count) return this.added[i - this.count].cls;
    return this.edits.get(i)?.cls ?? this.classes[i];
  }

  /** Header fields only (no property list). */
  header(i: number): Omit<SaveObject, 'props' | 'extra'> {
    const o = i >= this.count ? this.added[i - this.count] : this.edits.get(i);
    if (o) return o;
    return this.readHeader(i, false);
  }

  /** Property list, decoded on demand. Changing it requires edit(i) first. */
  props(i: number): Property[] {
    const o = i >= this.count ? this.added[i - this.count] : this.edits.get(i);
    if (o) return o.props;
    return this.readBody(i, false).props;
  }

  /** Full object, decoded fresh (a copy for unchanged objects). notes collects what stayed undecoded. */
  get(i: number, notes?: TreeNotes): SaveObject {
    const o = i >= this.count ? this.added[i - this.count] : this.edits.get(i);
    if (o) return o;
    return { ...this.readHeader(i, false), ...this.readBody(i, false, notes) };
  }

  /** Object to change in place; it is encoded from this tree on write. */
  edit(i: number): SaveObject {
    if (!this.exists(i)) throw new RangeError(`object ${i} does not exist`);
    if (i >= this.count) return this.added[i - this.count];
    let o = this.edits.get(i);
    if (!o) {
      o = { ...this.readHeader(i, true), ...this.readBody(i, true) };
      this.edits.set(i, o);
    }
    return o;
  }

  /** Appends an object; returns its index. References inside must use the editor's index space. */
  add(o: SaveObject): number {
    this.added.push(o);
    return this.size - 1;
  }

  remove(i: number): void {
    if (!this.exists(i)) throw new RangeError(`object ${i} does not exist`);
    this.deleted.add(i);
  }

  /** Indices referenced by an object (ObjectProperty, also inside structs and arrays). */
  refs(i: number): number[] {
    const out: number[] = [];
    const o = i >= this.count ? this.added[i - this.count] : this.edits.get(i);
    if (o) {
      forEachRef(o.props, (s) => { if (s.index !== -1) out.push(s.index); });
      return out;
    }
    scanRefs(this.buf, this.bodyStart[i], this.table, (pos) => {
      const v = this.buf.readInt32LE(pos);
      if (v !== -1) out.push(v);
    });
    return out;
  }

  /** Stored bytes of an original object: header, property list with extra data, property offset. */
  rawObject(i: number): { header: Buffer; body: Buffer; propOffset: number } {
    if (i < 0 || i >= this.count) throw new RangeError(`object ${i} is not in the file`);
    return {
      header: this.buf.subarray(this.hdrStart[i], this.hdrEnd[i]),
      body: this.buf.subarray(this.bodyStart[i], this.bodyEnd[i]),
      propOffset: this.bodyStart[i] - this.propertiesOffset,
    };
  }

  /** Header bytes as the editor writes them. */
  encodeHeader(o: Omit<SaveObject, 'props' | 'extra'>, propOffset: number): Buffer {
    const w = new BinaryWriter(256, this.table);
    writeHeader(w, o, propOffset);
    return w.toBuffer();
  }

  private readHeader(i: number, observe: boolean): Omit<SaveObject, 'props' | 'extra'> {
    const a = observe ? Archive.withTable(this.buf, this.table, this.hdrStart[i]) : new Archive(this.buf, this.table.names, this.hdrStart[i]);
    const guid = Buffer.from(a.bytes(16));
    const cls = a.name() ?? '';
    const isItem = a.i32();
    const names: string[] = [];
    for (let n = a.i32(); n > 0; n--) names.push(a.name() ?? '');
    const fromDataFile = a.i32();
    const dataFile = a.i32();
    const location = a.i32() !== 0
      ? { x: a.f32raw(), y: a.f32raw(), z: a.f32raw(), pitch: a.f32raw(), yaw: a.f32raw(), roll: a.f32raw() }
      : null;
    a.skip(4);
    const headerTail = a.i32();
    return { guid, cls, isItem, names, fromDataFile, dataFile, location, headerTail };
  }

  private readBody(i: number, observe: boolean, notes?: TreeNotes): { props: Property[]; extra: Buffer } {
    const a = observe ? Archive.withTable(this.buf, this.table, this.bodyStart[i]) : new Archive(this.buf, this.table.names, this.bodyStart[i]);
    const props = readPropertyList(a, notes);
    if (a.pos > this.bodyEnd[i]) throw new RangeError(`property list of object ${i} overlaps the next one`);
    return { props, extra: Buffer.from(this.buf.subarray(a.pos, this.bodyEnd[i])) };
  }

  /** Final index of every object in the editor's index space (-1 = deleted). */
  private indexMap(): Int32Array {
    const map = new Int32Array(this.size);
    let next = 0;
    for (let i = 0; i < this.size; i++) map[i] = this.deleted.has(i) ? -1 : next++;
    return map;
  }

  /** Writes the save. Returns the file as one buffer. */
  write(opts: WriteOptions = {}): Buffer {
    return Buffer.concat(this.writeChunks(opts));
  }

  /** Writes the save as a list of buffers (avoids one more copy of a large file). */
  writeChunks(opts: WriteOptions = {}): Buffer[] {
    const map = this.indexMap();
    let shifted = false;
    for (let i = 0; i < this.count; i++) if (map[i] !== i) { shifted = true; break; }
    const patch = shifted || opts.patchAll === true;
    const mapRef = (idx: number): number => {
      if (idx < 0 || idx >= map.length) throw new RangeError(`reference to object ${idx} outside the save`);
      return map[idx];
    };

    // Property bodies in storage order: original order, added objects at the end.
    const bodies: { index: number; data: Buffer }[] = [];
    const encode = (o: SaveObject): Buffer => {
      const w = new BinaryWriter(256, this.table);
      const props = o.props;
      if (map.length) remapRefs(props, mapRef);
      writePropertyList(w, props);
      w.bytes(o.extra);
      return w.toBuffer();
    };
    const encodeCopy = (o: SaveObject): Buffer => {
      // Remapping changes the tree; edits stay in editor index space for later writes.
      const copy: SaveObject = { ...o, props: structuredCloneProps(o.props) };
      return encode(copy);
    };
    for (let k = 0; k < this.count; k++) {
      const i = this.physOrder[k];
      if (this.deleted.has(i)) continue;
      const edited = this.edits.get(i);
      if (edited) {
        bodies.push({ index: i, data: encodeCopy(edited) });
      } else if (opts.reencodeAll) {
        bodies.push({ index: i, data: encode({ ...this.readHeader(i, true), ...this.readBody(i, true) }) });
      } else if (patch) {
        const data = Buffer.from(this.buf.subarray(this.bodyStart[i], this.bodyEnd[i]));
        const base = this.bodyStart[i];
        scanRefs(this.buf, base, this.table, (pos) => {
          const v = this.buf.readInt32LE(pos);
          if (v !== -1) data.writeInt32LE(mapRef(v), pos - base);
        });
        bodies.push({ index: i, data });
      } else {
        bodies.push({ index: i, data: this.buf.subarray(this.bodyStart[i], this.bodyEnd[i]) });
      }
    }
    for (let k = 0; k < this.added.length; k++) {
      const i = this.count + k;
      if (!this.deleted.has(i)) bodies.push({ index: i, data: encodeCopy(this.added[k]) });
    }
    const offsetOf = new Map<number, number>();
    let off = 0;
    for (const b of bodies) { offsetOf.set(b.index, off); off += b.data.length; }

    // Object table in index order; header bytes of unchanged objects are copied.
    const objects = new BinaryWriter(Math.max(1024, this.objectTableEnd - this.objectTableStart + 4096), this.table);
    let live = 0;
    for (let i = 0; i < this.size; i++) if (map[i] !== -1) live++;
    objects.i32(live);
    for (let i = 0; i < this.size; i++) {
      if (map[i] === -1) continue;
      const o = i >= this.count ? this.added[i - this.count] : this.edits.get(i);
      const propOffset = offsetOf.get(i)!;
      if (!o && !opts.reencodeAll) {
        objects.bytes(this.buf.subarray(this.hdrStart[i], this.hdrEnd[i]));
        objects.patchI32(objects.length - 8, propOffset);
        continue;
      }
      writeHeader(objects, o ?? this.readHeader(i, true), propOffset);
    }

    // Name table: the original bytes plus any names the encoding added.
    const added = this.table.added;
    let nameTable: Buffer;
    if (added.length === 0) {
      nameTable = this.buf.subarray(this.nameTableOffset, this.propertiesOffset);
    } else {
      const w = new BinaryWriter(this.propertiesOffset - this.nameTableOffset + 4096);
      w.bytes(this.buf.subarray(this.nameTableOffset, this.propertiesOffset));
      w.patchI32(0, this.table.names.length);
      for (const n of added) w.string(n);
      nameTable = w.toBuffer();
    }

    const front = this.buf.subarray(HEADER_V9, this.objectTableStart);
    const table = objects.toBuffer();
    const hibernation = this.buf.subarray(this.hibernationOffset, this.nameTableOffset);
    const hibernationOffset = HEADER_V9 + front.length + table.length;
    const nameTableOffset = hibernationOffset + hibernation.length;
    const propertiesOffset = nameTableOffset + nameTable.length;
    const head = Buffer.from(this.buf.subarray(0, HEADER_V9));
    head.writeInt32LE(hibernationOffset, 2);
    head.writeInt32LE(nameTableOffset, 10);
    head.writeInt32LE(propertiesOffset, 14);
    if (propertiesOffset + off > 0x7fffffff) throw new RangeError('save would exceed 2 GB');
    return [head, front, table, hibernation, nameTable, ...bodies.map((b) => b.data)];
  }
}

function writeHeader(w: BinaryWriter, o: Omit<SaveObject, 'props' | 'extra'>, propOffset: number): void {
  if (o.guid.length !== 16) throw new RangeError('object GUID must have 16 bytes');
  w.bytes(o.guid).name(o.cls).i32(o.isItem).i32(o.names.length);
  for (const n of o.names) w.name(n);
  w.i32(o.fromDataFile).i32(o.dataFile);
  if (o.location) {
    const l = o.location;
    w.i32(1).f32(l.x).f32(l.y).f32(l.z).f32(l.pitch).f32(l.yaw).f32(l.roll);
  } else {
    w.i32(0);
  }
  w.i32(propOffset).i32(o.headerTail);
}

function structuredCloneProps(list: Property[]): Property[] {
  // Buffers inside property trees are copied as Uint8Array by structuredClone; keep them Buffers.
  const fix = (v: unknown): unknown => {
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) (v as Record<string, unknown>)[k] = fix((v as Record<string, unknown>)[k]);
    }
    return v;
  };
  return fix(structuredClone(list)) as Property[];
}

// ---------------------------------------------------------------- reference scanner

/**
 * Walks a property list stored with a name table and reports the byte position of every object index
 * (ObjectProperty of kind 0, in structs and arrays too). Used to patch unchanged objects without
 * decoding them. Throws on anything it cannot follow, so a write never patches blindly.
 */
const typeIds = new WeakMap<NameTable, Record<'NONE' | 'OBJ' | 'STRUCT' | 'ARRAY' | 'BOOL' | 'BYTE', number>>();

function idsOf(table: NameTable): Record<'NONE' | 'OBJ' | 'STRUCT' | 'ARRAY' | 'BOOL' | 'BYTE', number> {
  let ids = typeIds.get(table);
  if (!ids) {
    const id = (s: string): number => table.find(s)?.[0] ?? -2;
    ids = {
      NONE: id('None'), OBJ: id('ObjectProperty'), STRUCT: id('StructProperty'),
      ARRAY: id('ArrayProperty'), BOOL: id('BoolProperty'), BYTE: id('ByteProperty'),
    };
    if (ids.NONE < 0) throw new RangeError('name table has no "None"');
    typeIds.set(table, ids);
  }
  return ids;
}

export function scanRefs(buf: Buffer, start: number, table: NameTable, onRef: (pos: number) => void): number {
  const { NONE, OBJ, STRUCT, ARRAY, BOOL, BYTE } = idsOf(table);
  const names = table.names;
  const nameAt = (p: number): string => {
    const s = names[buf.readInt32LE(p) - 1];
    if (s === undefined) throw new RangeError(`name index outside name table at ${p}`);
    const inst = buf.readInt32LE(p + 4);
    return inst ? `${s}_${inst - 1}` : s;
  };
  const list = (p: number): number => {
    for (;;) {
      const nameIdx = buf.readInt32LE(p);
      if (nameIdx === NONE && buf.readInt32LE(p + 4) === 0) return p + 8;
      const namePos = p;
      const type = buf.readInt32LE(p + 8);
      if (buf.readInt32LE(p + 12) !== 0) throw new RangeError(`property type with instance number at ${p}`);
      const size = buf.readInt32LE(p + 16);
      p += 24;
      if (type === BOOL) { p += 1; continue; }
      let inner = -1;
      let innerName = '';
      if (type === STRUCT || type === ARRAY || type === BYTE) {
        inner = buf.readInt32LE(p);
        innerName = nameAt(p);
        p += 8;
      }
      const end = p + size;
      if (size < 0 || end > buf.length) throw new RangeError(`property of ${size} bytes at ${p} beyond end`);
      if (type === OBJ) {
        if (size === 4) onRef(p);
        else if (buf.readInt32LE(p) === 0) onRef(p + 4);
      } else if (type === STRUCT) {
        if (!isNativeStruct(innerName)) {
          if (list(p) !== end) throw new RangeError(`struct at ${p} does not end at its size`);
        }
      } else if (type === ARRAY) {
        const n = buf.readInt32LE(p);
        let q = p + 4;
        if (inner === OBJ) {
          for (let e = 0; e < n; e++) {
            const kind = buf.readInt32LE(q);
            if (kind === 0) onRef(q + 4);
            else if (kind !== 1) throw new RangeError(`object reference of kind ${kind} at ${q}`);
            q += kind === 0 ? 8 : 12; // index, or a path name (index + instance)
          }
          if (q !== end) throw new RangeError(`object array at ${p} does not end at its size`);
        } else if (inner === STRUCT && n > 0 && !nativeArrayStruct(nameAt(namePos), n, size)) {
          for (let e = 0; e < n; e++) q = list(q);
          if (q !== end) throw new RangeError(`struct array at ${p} does not end at its size`);
        }
      }
      p = end;
    }
  };
  return list(start);
}
