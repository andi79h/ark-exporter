// .arkprofile and .arktribe files of ARK: Survival Ascended, and the same archives inside the world
// save when the server runs with -usestore (custom row GameModeCustomBytes).
//
// Archive: int32 version (0x1bedead marks a second int32 with the real version), [8 bytes from
// version 7], int32 count, object headers, property lists at the header offsets. Names are inline
// strings; version 7 uses the UE 5.5 property tags.
import { type GameObject, ReadContext } from '../types.ts';
import { AsaArchive, ZERO_UUID } from './archive.ts';
import { readKnownBytes, readTemplate } from './bytes.ts';
import { type CryoCoverage, readCryopod, readItemArchive } from './cryopod.ts';
import { readAsaProperties } from './properties.ts';

export interface AsaContainer {
  version: number;
  /** 0x1bedead marker in front of the version. */
  marker: boolean;
  objects: GameObject[];
  /** Bytes read structurally (headers, property lists, known tails). */
  decoded: number;
  /** Bytes after property lists that were kept raw. */
  raw: number;
}

function readArchiveObject(a: AsaArchive, index: number): GameObject {
  const guid = a.uuid();
  const cls = a.string() ?? '';
  const isItem = a.bool();
  const nameCount = a.u32();
  if (nameCount > 64) throw new RangeError(`object ${index} has ${nameCount} names`);
  const names: string[] = [];
  for (let i = 0; i < nameCount; i++) names.push(a.string() ?? '');
  const fromDataFile = a.bool();
  const dataFile = a.i32();
  const loc = a.bool()
    ? { x: a.f64(), y: a.f64(), z: a.f64(), pitch: a.f64(), yaw: a.f64(), roll: a.f64() }
    : null;
  const propOffset = a.i32();
  if (a.i32() !== 0) a.ctx.note('archive: non-zero value after property offset');
  return {
    index, guid: guid === ZERO_UUID ? null : guid, cls, isItem, names, fromDataFile, dataFile, loc, propOffset,
    props: {}, extra: undefined, error: undefined,
  };
}

/** Byte arrays inside archives and world saves: cryopod payloads, saddles, costumes, templates, bunker cells. */
export function enableAsaBytes(ctx: ReadContext, cov: CryoCoverage): void {
  ctx.decodeBytes = (name, bytes, current) =>
    readKnownBytes(name, bytes, current) ?? readCryopod(bytes, ctx, cov) ?? readTemplate(bytes, ctx)
    ?? readItemArchive(bytes, ctx, cov);
}

export function readAsaContainer(buf: Buffer, ctx: ReadContext, start = 0, end = buf.length): AsaContainer {
  const view = buf.subarray(start, end);
  let version = view.readInt32LE(0);
  let pos = 4;
  const marker = version === 0x1bedead;
  if (marker) { version = view.readInt32LE(4); pos = 8; }
  if (version < 5 || version > 7) throw new RangeError(`unsupported archive version ${version}`);
  const a = new AsaArchive(view, { names: { kind: 'inline' }, ue55: version >= 7, refs: 'archive' }, ctx, pos);
  if (version >= 7) a.skip(8);
  const count = a.i32();
  if (count < 0 || count > 10_000) throw new RangeError(`archive with ${count} objects`);
  const objects: GameObject[] = [];
  for (let i = 0; i < count; i++) objects.push(readArchiveObject(a, i));
  let decoded = a.pos;
  let raw = 0;
  const order = [...objects].sort((x, y) => x.propOffset - y.propOffset);
  for (let k = 0; k < order.length; k++) {
    const o = order[k];
    const next = k + 1 < order.length ? order[k + 1].propOffset : view.length;
    a.pos = o.propOffset;
    ctx.owner = o.cls.split('.').pop() ?? '';
    if (version >= 7 && a.remaining && a.u8() !== 0) ctx.note('archive: serialization control byte not 0');
    o.props = readAsaProperties(a, ctx);
    // UObject tail: int32 "has GUID" (0 or 1) [+ GUID].
    if (next - a.pos >= 4 && (a.peekI32() === 0 || a.peekI32() === 1)) {
      if (a.i32() === 1 && next - a.pos >= 16) o.extra = { guid: a.uuid() };
    }
    decoded += a.pos - o.propOffset;
    if (a.pos < next) {
      ctx.note(`archive: raw data after properties (${o.cls})`);
      raw += next - a.pos;
    } else if (a.pos > next) {
      ctx.note('archive: property list overlaps the next object');
    }
  }
  return { version, marker, objects, decoded, raw };
}

export interface AsaStore {
  tribes: { id: string; bytes: number; container: AsaContainer | null; error?: string }[];
  players: { id: string; bytes: number; container: AsaContainer | null; error?: string }[];
  /** Bytes of tribe and player archives read structurally. */
  decoded: number;
  raw: number;
}

/**
 * GameModeCustomBytes (-usestore): int32 flag, offset and count of the tribe directory, offset and
 * count of the player directory, then the archives. Directory entries: tribe id, int32, offset, size;
 * player: int64 id, offset, size. Layout from ark-sa-save-tools (Kakoen); not yet checked against a save.
 */
export function readStore(buf: Buffer, ctx: ReadContext): AsaStore {
  const a = new AsaArchive(buf, { names: { kind: 'inline' }, ue55: true, refs: 'archive' }, ctx);
  const store: AsaStore = { tribes: [], players: [], decoded: 0, raw: 0 };
  a.i32();
  const tribeDir = a.i32() + 12;
  const tribeCount = a.i32();
  const tribeData = a.pos;
  const read = (id: string, offset: number, size: number, list: AsaStore['tribes']) => {
    if (offset < 0 || size < 0 || offset + size > buf.length) {
      list.push({ id, bytes: size, container: null, error: 'outside the data' });
      return;
    }
    try {
      const c = readAsaContainer(buf, ctx, offset, offset + size);
      list.push({ id, bytes: size, container: c });
      store.decoded += c.decoded;
      store.raw += size - c.decoded;
    } catch (e) {
      list.push({ id, bytes: size, container: null, error: (e as Error).message });
      store.raw += size;
    }
  };
  if (tribeCount > 0) {
    a.pos = tribeDir;
    for (let i = 0; i < tribeCount; i++) {
      const id = String(a.u32());
      a.i32();
      const offset = a.i32() + tribeData;
      const size = a.i32();
      const back = a.pos;
      read(id, offset, size, store.tribes);
      a.pos = back;
    }
  }
  const playerDir = a.i32();
  const playerAt = playerDir + a.pos + 4;
  const playerCount = a.i32();
  const playerData = a.pos;
  if (playerCount > 0) {
    a.pos = playerAt;
    for (let i = 0; i < playerCount; i++) {
      const id = a.i64();
      const offset = a.i32() + playerData;
      const size = a.i32();
      const back = a.pos;
      read(id, offset, size, store.players);
      a.pos = back;
    }
  }
  return store;
}
