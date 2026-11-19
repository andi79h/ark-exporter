// Player profiles (.arkprofile), tribes (.arktribe) and tribute tribes (.arktributetribe).
// Profiles and tribes are small inline-named archives: int32 version, int32 count, object headers,
// property lists at offsets relative to the start of the file.
import { Archive } from './archive.ts';
import { loadProperties, readObjectHeader } from './objects.ts';
import { enableCryopods } from './savegame.ts';
import { type GameObject, ReadContext, type Value } from './types.ts';

export interface Container { version: number; objects: GameObject[]; }

export function readContainer(buf: Buffer, ctx = new ReadContext()): Container {
  enableCryopods(ctx);
  const a = new Archive(buf, null);
  const version = a.i32();
  if (version !== 1) ctx.note(`container version ${version}`);
  const count = a.i32();
  if (count < 0 || count > 100_000) throw new RangeError(`container claims ${count} objects`);
  const objects: GameObject[] = [];
  for (let i = 0; i < count; i++) objects.push(readObjectHeader(a, i, ctx));
  loadProperties(objects, a, 0, buf.length, ctx);
  return { version, objects };
}

/**
 * .arktributetribe: int32 version, int32 tribe id, then int32 words (24–104 bytes in the saves examined).
 * The meaning of the words is not known yet, so they are kept as numbers.
 */
export function readTributeTribe(buf: Buffer): Value {
  const a = new Archive(buf, null);
  const version = a.i32();
  const tribeId = a.i32();
  const words: Value[] = [];
  while (a.remaining >= 4) words.push(a.i32());
  return { version, tribeId, words, trailing: a.remaining };
}
