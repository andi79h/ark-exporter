// Byte arrays with a known layout besides cryopods and item archives, ARK: Survival Ascended.
//
// Structure templates (PrimalItem_TemplateTablet, CustomItemDatas "TemplateData", ByteArrays[0]):
//   int32 1, int32 inflated size, zlib stream whose output is packed like a cryopod (unpack()).
//   Inside: int32 version (1), FString author, FString name, FString description, int32 (0),
//   int32 n + n int32 (n = 0 in nearly all templates; meaning unknown), int32 class count + class
//   paths, int32 structure count, then per structure:
//     uint16 class index, int16 skin class index (-1 = none), 3 doubles location relative to the
//     template, 3 doubles rotation (pitch, yaw, roll in degrees), int32 flag (0/1, meaning unknown),
//     FString name ("None" in all templates examined), 36 bytes (zero in all templates examined).
// Bunker cells (BP_Bunker_Base_C, AvailableLocationsBytes / UnavailableLocationsBytes): a struct with
//   one 3-byte array, the x, y and z index of a grid cell.
// Byte lists: one small number per entry. SkillRanks (player data) and UnlockedShipSkillRanks (ships):
//   rank 0-3 per skill index; MembersRankGroups (tribe data): rank group index per member, in the order
//   of MembersPlayerDataID.
import { inflateSync } from 'node:zlib';
import { Archive } from '../archive.ts';
import { Blob, type ReadContext, type Value } from '../types.ts';
import { unpack } from './cryopod.ts';

const STRUCTURE_TAIL = 36;

/** Structure template (blueprint tablet); null if the bytes are not one or do not parse exactly. */
export function readTemplate(bytes: Buffer, ctx: ReadContext): Value | null {
  if (bytes.length < 12 || bytes.readInt32LE(0) !== 1 || bytes[8] !== 0x78) return null;
  let data: Buffer;
  try {
    const inflated = inflateSync(bytes.subarray(8));
    if (inflated.length !== bytes.readInt32LE(4)) return null;
    data = unpack(inflated);
  } catch {
    return null;
  }
  const a = new Archive(data);
  try {
    const version = a.i32();
    if (version !== 1) throw new RangeError(`template version ${version}`);
    const author = a.string();
    const name = a.string();
    const description = a.string();
    const header = [a.i32()];
    const extra = a.i32();
    if (extra < 0 || extra > 64) throw new RangeError(`template header list of ${extra}`);
    for (let i = 0; i < extra; i++) header.push(a.i32());
    if (extra) ctx.saw('template: header list not empty');
    const classCount = a.i32();
    if (classCount < 0 || classCount > 10_000) throw new RangeError(`template with ${classCount} classes`);
    const classes: string[] = [];
    for (let i = 0; i < classCount; i++) classes.push(a.string() ?? '');
    const count = a.i32();
    if (count < 0 || count > 100_000) throw new RangeError(`template with ${count} structures`);
    const structures: Value[] = [];
    for (let i = 0; i < count; i++) {
      const cls = a.u16();
      const skin = a.i16();
      if (cls >= classCount || skin >= classCount) throw new RangeError('template class index outside the class list');
      const s: { [key: string]: Value } = {
        class: cls, skin: skin < 0 ? null : skin,
        x: a.f64(), y: a.f64(), z: a.f64(), pitch: a.f64(), yaw: a.f64(), roll: a.f64(),
        flag: a.i32(), name: a.string(),
      };
      const tail = a.bytes(STRUCTURE_TAIL);
      if (tail.some((b) => b !== 0)) {
        ctx.saw('template: structure tail not zero');
        s.tail = new Blob(tail, 'template structure tail');
      }
      structures.push(s);
    }
    if (a.remaining) throw new RangeError(`${a.remaining} bytes after the structures`);
    ctx.saw('template tablet');
    ctx.saw('template structures', count);
    return { $template: version, author, name, description, header, classes, structures };
  } catch (e) {
    ctx.note(`template unreadable: ${String((e as Error).message).replace(/\d+/g, 'N')}`);
    return null;
  }
}

const BYTE_LISTS = new Set(['SkillRanks', 'UnlockedShipSkillRanks', 'MembersRankGroups']);

/** Small byte arrays whose meaning is known; null for all others. */
export function readKnownBytes(prop: string, bytes: Buffer, ctx: ReadContext): Value | null {
  if (BYTE_LISTS.has(prop)) {
    ctx.saw(`byte list ${prop}`);
    return [...bytes];
  }
  if (bytes.length === 3 && prop.startsWith('Bytes_') && ctx.owner.startsWith('BP_Bunker')) {
    ctx.saw('bunker grid cell');
    return { x: bytes[0], y: bytes[1], z: bytes[2] };
  }
  return null;
}
