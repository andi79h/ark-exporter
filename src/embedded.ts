// Byte arrays that hold data of their own: an embedded archive (the creature in a cryopod or soul
// trap, DinoData of cluster uploads) or a single serialized property list (item net infos, e.g. the
// soul traps in Dino Storage's recovery list). Both use inline names (no name table).
import { Archive } from './archive.ts';
import { type Property, readContainerTree, readPropertyList, type TreeContainer, type TreeObject, writeContainerTree, writePropertyList } from './tree.ts';
import { BinaryWriter } from './writer.ts';

export type DecodedBlob = { kind: 'archive'; tree: TreeContainer } | { kind: 'list'; list: Property[] };

/** Decodes a byte array as embedded archive or property list; null for anything else (kept as bytes). */
export function decodeBlob(bytes: Buffer): DecodedBlob | null {
  if (bytes.length >= 40) {
    const count = bytes.readInt32LE(0);
    if (count > 0 && count <= 10_000) {
      try {
        return { kind: 'archive', tree: readContainerTree(bytes, { version: false }) };
      } catch { /* not an archive */ }
    }
  }
  if (bytes.length >= 16) {
    // A property list starts with the length of the first property name.
    const first = bytes.readInt32LE(0);
    if (first > 1 && first <= 256) {
      try {
        const a = new Archive(bytes, null);
        const list = readPropertyList(a);
        if (a.pos === bytes.length) return { kind: 'list', list };
      } catch { /* not a property list */ }
    }
  }
  return null;
}

export function encodeBlob(d: DecodedBlob): Buffer {
  if (d.kind === 'archive') return writeContainerTree(d.tree);
  const w = new BinaryWriter(1024);
  writePropertyList(w, d.list);
  return w.toBuffer();
}

/** True when the bytes decode and encode back to exactly the same bytes (safe to rewrite). */
export function blobRoundTrips(bytes: Buffer): boolean {
  const d = decodeBlob(bytes);
  return d !== null && encodeBlob(d).equals(bytes);
}

/**
 * Which objects of an archive are components of another object in it. Actors in cryopods and soul
 * traps carry their level in the name list ("Raptor_Character_BP_C_5", "PersistentLevel", "Gen2",
 * "/Game/Maps/Genesis2/Gen2"); a component names its actor second.
 */
export function componentFlags(objects: TreeObject[]): boolean[] {
  const names = new Set(objects.map((o) => o.names[0]));
  return objects.map((o) => o.names.length > 1 && o.names[1] !== null && names.has(o.names[1]));
}

/** The creature (or other actor) an archive holds: the first object that is neither item nor component. */
export function archiveRoot(objects: TreeObject[]): TreeObject | undefined {
  const comp = componentFlags(objects);
  return objects.find((o, k) => !o.isItem && !comp[k]);
}
