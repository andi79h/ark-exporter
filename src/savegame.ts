// .ark world save (ARK: Survival Evolved, save version 9; version 10/11 header fields are read too).
//
// Layout: header, data files, embedded data, data-file object map, object table, hibernation,
// name table, property block. The coverage list accounts for every byte of the file.
import { Archive } from './archive.ts';
import { loadProperties, readEmbeddedArchive, readObjectHeader, readSerializedProperties } from './objects.ts';
import { type GameObject, ReadContext, type Value } from './types.ts';

export interface Section { name: string; bytes: number; decoded: boolean; }

export interface SaveFile {
  version: number;
  gameTime: number | string;
  saveCount: number;
  /** First entry is the map name, the rest are sublevels. */
  dataFiles: (string | null)[];
  embeddedData: { path: string | null; bytes: number }[];
  dataFileObjects: { index: number; names: (string | null)[] }[];
  storedData: { offset: string; size: string }[];
  hibernation: {
    tribeStore: Value; playerStore: Value; classes: (string | null)[]; indices: number[]; entries: number;
  };
  nameCount: number;
  objects: GameObject[];
  sections: Section[];
  ctx: ReadContext;
}

/** Version 2 chunked store (tribe and player data since game version 349.10; empty in ASE saves). */
function readChunkedStore(a: Archive): Value {
  if (a.i32() !== -1) throw new RangeError('chunked store without version marker');
  const version = a.i32();
  if (version !== 2) throw new RangeError(`chunked store version ${version}`);
  const chain = (elementSize: number): Value => {
    const total = a.i64n() * BigInt(elementSize);
    let remaining = total;
    const chunks: Value[] = [];
    while (remaining > 0n) {
      const chunk = { archive: a.i32(), offset: a.i64(), unknown: a.i64(), size: a.i64() };
      remaining -= BigInt(chunk.size);
      chunks.push(chunk);
    }
    return { bytes: total.toString(), chunks };
  };
  return { data: chain(1), index: chain(24) };
}

/** Byte arrays are tried as embedded archive (cryopods) first, then as a single property list. */
export function enableCryopods(ctx: ReadContext): void {
  ctx.decodeBytes = (_name, bytes) => readEmbeddedArchive(bytes, ctx) ?? readSerializedProperties(bytes, ctx);
}

export function readSave(buf: Buffer, ctx = new ReadContext()): SaveFile {
  enableCryopods(ctx);
  const a = new Archive(buf);
  const sections: Section[] = [];
  const version = a.i16();
  if (version < 5 || version > 11) throw new RangeError(`unsupported save version ${version}`);
  const storedData: SaveFile['storedData'] = [];
  if (version > 10) for (let i = 0; i < 4; i++) storedData.push({ offset: a.i64(), size: a.i64() });
  const hibernationOffset = version > 6 ? a.i32() : 0;
  if (version > 6 && a.i32() !== 0) ctx.note('header: non-zero value after hibernation offset');
  const nameTableOffset = version > 5 ? a.i32() : 0;
  const propertiesOffset = a.i32();
  const gameTime = a.f32();
  const saveCount = version > 8 ? a.i32() : 0;
  sections.push({ name: 'header', bytes: a.pos, decoded: true });

  // Name table first: everything after the header uses it.
  const headerEnd = a.pos;
  const names: string[] = [];
  if (nameTableOffset > 0) {
    a.pos = nameTableOffset;
    for (let n = a.i32(); n > 0; n--) names.push(a.string() ?? '');
    sections.push({ name: `name table (${names.length} names)`, bytes: a.pos - nameTableOffset, decoded: true });
  }
  a.pos = headerEnd;

  let s0 = a.pos;
  const dataFiles: (string | null)[] = [];
  for (let n = a.i32(); n > 0; n--) dataFiles.push(a.string());
  sections.push({ name: `data files (${dataFiles.length})`, bytes: a.pos - s0, decoded: true });

  s0 = a.pos;
  const embeddedData: SaveFile['embeddedData'] = [];
  for (let e = a.i32(); e > 0; e--) {
    const path = a.string();
    const start = a.pos;
    for (let part = a.i32(); part > 0; part--) {
      for (let blob = a.i32(); blob > 0; blob--) a.skip(a.i32() * 4);
    }
    embeddedData.push({ path, bytes: a.pos - start });
  }
  const embeddedBytes = embeddedData.reduce((sum, e) => sum + e.bytes, 0);
  if (embeddedBytes > 0) {
    ctx.note('embedded data blobs kept raw');
    ctx.keepRaw('embedded data', embeddedBytes);
  }
  sections.push({ name: `embedded data (${embeddedData.length})`, bytes: a.pos - s0, decoded: embeddedBytes === 0 });

  s0 = a.pos;
  const dataFileObjects: SaveFile['dataFileObjects'] = [];
  for (let m = a.i32(); m > 0; m--) {
    const index = a.i32();
    const objNames: (string | null)[] = [];
    for (let s = a.i32(); s > 0; s--) objNames.push(a.string());
    dataFileObjects.push({ index, names: objNames });
  }
  sections.push({ name: `data file object map (${dataFileObjects.length})`, bytes: a.pos - s0, decoded: true });

  a.names = names.length ? names : null;
  s0 = a.pos;
  const count = a.i32();
  const objects: GameObject[] = new Array(count);
  for (let i = 0; i < count; i++) objects[i] = readObjectHeader(a, i, ctx);
  sections.push({ name: `object table (${count} objects)`, bytes: a.pos - s0, decoded: true });

  const hibernation: SaveFile['hibernation'] = { tribeStore: null, playerStore: null, classes: [], indices: [], entries: 0 };
  if (hibernationOffset > 0) {
    a.pos = hibernationOffset;
    const end = nameTableOffset > hibernationOffset ? nameTableOffset : buf.length;
    if (version > 8 && a.dv.getInt32(a.pos, true) === -1 && a.dv.getInt32(a.pos + 4, true) === 2) {
      hibernation.tribeStore = readChunkedStore(a);
      hibernation.playerStore = readChunkedStore(a);
    } else if (version > 7) {
      a.skip(16);
    }
    let decoded = true;
    if (a.pos < end) {
      a.skip(8);
      for (let n = a.i32(); n > 0; n--) hibernation.classes.push(a.string());
      for (let n = a.i32(); n > 0; n--) hibernation.indices.push(a.i32());
      hibernation.entries = a.i32();
      if (hibernation.entries > 0) {
        decoded = false;
        ctx.note('hibernation entries kept raw');
        ctx.keepRaw('hibernation entries', end - a.pos);
      }
    }
    sections.push({ name: 'hibernation', bytes: end - hibernationOffset, decoded });
  }

  const blockEnd = storedData.length && storedData[0].offset !== '0' ? Number(storedData[0].offset) : buf.length;
  const cov = loadProperties(objects, a, propertiesOffset, blockEnd, ctx);
  sections.push({ name: 'property lists', bytes: cov.properties, decoded: true });
  sections.push({ name: 'data after property lists (decoded)', bytes: cov.extraDecoded, decoded: true });
  if (cov.extraRaw) sections.push({ name: 'data after property lists (raw)', bytes: cov.extraRaw, decoded: false });
  if (cov.failed) sections.push({ name: 'unreadable property lists', bytes: cov.failed, decoded: false });
  const accounted = sections.reduce((sum, s) => sum + s.bytes, 0);
  if (accounted !== buf.length) sections.push({ name: 'unaccounted', bytes: buf.length - accounted, decoded: false });

  return {
    version, gameTime, saveCount, dataFiles, embeddedData, dataFileObjects, storedData, hibernation,
    nameCount: names.length, objects, sections, ctx,
  };
}
