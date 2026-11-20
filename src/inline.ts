// Objects of a .ark save as an inline-named archive: count, object headers, property lists, names as
// strings. That is the form the game uses for creatures in cryopods and soul traps and for DinoData
// in cluster uploads, so a creature living in a world save can be packed for those places.
import type { SaveEditor } from './editor.ts';
import { dropRawBytes, forEachRef, type Property, remapRefs, type TreeContainer, type TreeObject, writeContainerTree } from './tree.ts';
import { cloneObject } from './operations.ts';
import { ownedClosure } from './world.ts';

export interface InlineArchive {
  /** count, headers, property lists (no leading version): the payload of a byte array. */
  bytes: Buffer;
  /** Editor indices in archive order; the roots come first in the order given. */
  indices: number[];
  /** References that pointed outside the group and were removed, by property path. */
  droppedRefs: Record<string, number>;
}

/**
 * Packs the actors with everything they own (status and inventory components, with items: true also
 * the items) into an inline archive. References inside the group are renumbered to archive order;
 * references to anything else (the bed a creature sleeps in, the player who tamed it) are removed.
 * Same-name double entries (the game writes some actors twice) are merged.
 */
export function toInlineArchive(ed: SaveEditor, roots: number[], opts: { items?: boolean } = {}): InlineArchive {
  if (roots.length === 0) throw new Error('nothing to pack');
  const set = ownedClosure(ed, roots, { items: opts.items === true });
  const order = [...roots, ...[...set].filter((i) => !roots.includes(i)).sort((a, b) => a - b)];
  const first = new Map<string, number>();
  const alias = new Map<number, number>();
  for (const i of order) {
    const h = ed.header(i);
    const key = `${h.cls}|${h.names.join('/')}`;
    const kept = first.get(key);
    if (kept === undefined) first.set(key, i);
    else alias.set(i, kept);
  }
  const indices = order.filter((i) => !alias.has(i));
  const local = new Map(indices.map((i, k) => [i, k]));
  for (const [dup, kept] of alias) local.set(dup, local.get(kept)!);

  const dropped = new Map<string, number>();
  const objects: TreeObject[] = indices.map((i) => {
    const o = cloneObject(ed.get(i));
    forEachRef(o.props, (s) => {
      if (s.index !== -1 && !local.has(s.index)) dropped.set(s.path.join('.'), (dropped.get(s.path.join('.')) ?? 0) + 1);
    });
    remapRefs(o.props, (t) => local.get(t) ?? -1, true);
    dropRawBytes(o.props); // name-table bytes are no use in an inline archive
    let location: Buffer | null = null;
    if (o.location) {
      location = Buffer.alloc(24);
      const l = o.location;
      [l.x, l.y, l.z, l.pitch, l.yaw, l.roll].forEach((v, k) => location!.writeFloatLE(v, k * 4));
    }
    return {
      guid: o.guid, cls: o.cls, isItem: o.isItem, names: o.names, fromDataFile: o.fromDataFile, dataFile: o.dataFile,
      hasLocation: location ? 1 : 0, location, headerTail: o.headerTail, props: o.props as Property[], extra: o.extra,
    };
  });
  const container: TreeContainer = { version: null, objects, gap: Buffer.alloc(0), order: [] };
  return { bytes: writeContainerTree(container), indices, droppedRefs: Object.fromEntries(dropped) };
}
