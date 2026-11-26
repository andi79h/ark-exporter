// Proves that the editor writes a save back byte for byte, on any real file:
// - unchanged write (copy path), forced reference patching, complete re-encoding of every object,
// - per object: header and property list re-encoded, reference scanner agrees with the tree,
// - embedded archives in byte arrays (cryopods, soul traps) and serialized property lists re-encoded.
import { Archive } from './archive.ts';
import { SaveEditor } from './editor.ts';
import {
  forEachRef, type Property, readContainerTree, readPropertyList, type TreeNotes, writeContainerTree, writePropertyList,
} from './tree.ts';
import { BinaryWriter } from './writer.ts';

export interface VerifyReport {
  bytes: number;
  objects: number;
  names: number;
  identical: { copy: boolean; patchAll: boolean; reencodeAll: boolean };
  objectMismatches: number;
  refMismatches: number;
  /** Properties kept as undecoded bytes, by reason (should be empty for ASE saves). */
  opaque: Record<string, number>;
  refs: number;
  embedded: { archives: number; archivesIdentical: number; propertyLists: number; propertyListsIdentical: number; raw: number };
  firstProblems: string[];
  seconds: { open: number; copy: number; patch: number; reencode: number; objects: number };
}

function firstDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function sameAsFile(chunks: Buffer[], buf: Buffer): number {
  let pos = 0;
  for (const c of chunks) {
    if (pos + c.length > buf.length) return pos + firstDiff(c, buf.subarray(pos));
    const d = firstDiff(c, buf.subarray(pos, pos + c.length));
    if (d !== -1) return pos + d;
    pos += c.length;
  }
  return pos === buf.length ? -1 : pos;
}

type Embedded = VerifyReport['embedded'];

/** Byte arrays inside a property tree: embedded archives and serialized property lists. */
function checkBytes(list: Property[], stats: Embedded, problems: string[], where: string): void {
  for (const p of list) {
    if (p.opaque) continue;
    if (p.type === 'StructProperty' && Array.isArray(p.value)) checkBytes(p.value as Property[], stats, problems, where);
    if (p.type !== 'ArrayProperty') continue;
    if (Buffer.isBuffer(p.value)) { checkBlob(p.value, stats, problems, `${where}.${p.name}`); continue; }
    if (p.inner === 'StructProperty' && !p.elementStruct && Array.isArray(p.value)) {
      for (const e of p.value) checkBytes(e as Property[], stats, problems, where);
    }
  }
}

function checkBlob(bytes: Buffer, stats: Embedded, problems: string[], where: string): void {
  if (bytes.length >= 40) {
    const count = bytes.readInt32LE(0);
    if (count > 0 && count <= 10_000) {
      try {
        const c = readContainerTree(bytes, { version: false });
        stats.archives++;
        if (writeContainerTree(c).equals(bytes)) stats.archivesIdentical++;
        else if (problems.length < 20) problems.push(`embedded archive differs in ${where}`);
        for (const o of c.objects) checkBytes(o.props, stats, problems, `${where}/${o.cls}`);
        return;
      } catch { /* not an archive */ }
    }
  }
  if (bytes.length >= 16) {
    const first = bytes.readInt32LE(0);
    if (first > 1 && first <= 256) {
      try {
        const a = new Archive(bytes, null);
        const list = readPropertyList(a);
        if (a.pos === bytes.length) {
          stats.propertyLists++;
          const w = new BinaryWriter(bytes.length + 64);
          writePropertyList(w, list);
          if (w.toBuffer().equals(bytes)) stats.propertyListsIdentical++;
          else if (problems.length < 20) problems.push(`serialized property list differs in ${where}`);
          checkBytes(list, stats, problems, where);
          return;
        }
      } catch { /* not a property list */ }
    }
  }
  stats.raw++;
}

export function verifySave(buf: Buffer, opts: { reencodeAll?: boolean } = {}): VerifyReport {
  const t = (): number => performance.now() / 1000;
  const problems: string[] = [];
  let t0 = t();
  const ed = SaveEditor.open(buf);
  const seconds = { open: t() - t0, copy: 0, patch: 0, reencode: 0, objects: 0 };

  t0 = t();
  let d = sameAsFile(ed.writeChunks(), buf);
  const copy = d === -1;
  if (!copy) problems.push(`copy write differs at byte ${d}`);
  seconds.copy = t() - t0;

  t0 = t();
  d = sameAsFile(ed.writeChunks({ patchAll: true }), buf);
  const patchAll = d === -1;
  if (!patchAll) problems.push(`patched write differs at byte ${d}`);
  seconds.patch = t() - t0;

  let reencodeAll = false;
  if (opts.reencodeAll !== false) {
    t0 = t();
    d = sameAsFile(ed.writeChunks({ reencodeAll: true }), buf);
    reencodeAll = d === -1;
    if (!reencodeAll) problems.push(`re-encoded write differs at byte ${d}`);
    seconds.reencode = t() - t0;
  }

  t0 = t();
  let objectMismatches = 0;
  let refMismatches = 0;
  let refs = 0;
  const embedded: Embedded = { archives: 0, archivesIdentical: 0, propertyLists: 0, propertyListsIdentical: 0, raw: 0 };
  const notes: TreeNotes = new Map();
  for (let i = 0; i < ed.count; i++) {
    const o = ed.get(i, notes);
    const w = new BinaryWriter(256, ed.table);
    writePropertyList(w, o.props);
    w.bytes(o.extra);
    const original = ed.rawObject(i);
    if (!w.toBuffer().equals(original.body) || !ed.encodeHeader(o, original.propOffset).equals(original.header)) {
      objectMismatches++;
      if (problems.length < 20) problems.push(`object ${i} (${o.cls}) re-encodes differently`);
    }
    let treeRefs = 0;
    forEachRef(o.props, () => { treeRefs++; });
    const scanned = ed.refs(i).length + countMinusOne(o.props);
    refs += treeRefs;
    if (scanned !== treeRefs) {
      refMismatches++;
      if (problems.length < 20) problems.push(`object ${i} (${o.cls}): scanner finds ${scanned} references, tree ${treeRefs}`);
    }
    checkBytes(o.props, embedded, problems, `object ${i} ${o.cls}`);
  }
  seconds.objects = t() - t0;

  return {
    bytes: buf.length, objects: ed.count, names: ed.table.names.length,
    identical: { copy, patchAll, reencodeAll }, objectMismatches, refMismatches,
    opaque: Object.fromEntries([...notes].filter(([k]) => k.startsWith('opaque'))), refs, embedded,
    firstProblems: problems, seconds,
  };
}

/** refs() leaves out -1 (no object); the tree walker reports them. */
function countMinusOne(list: Property[]): number {
  let n = 0;
  forEachRef(list, (s) => { if (s.index === -1) n++; });
  return n;
}

// ---------------------------------------------------------------- consistency of a save

export interface Consistency {
  objects: number;
  /** References to indices outside the object table. */
  refsOutOfRange: number;
  /** Components whose actor (names[1]) does not exist. */
  orphanComponents: number;
  /** Items whose ItemId occurs more than once (the game expects unique ids). */
  duplicateItemIds: number;
  duplicateDinoIds: number;
  /** Actor names that occur more than once (live saves have some; new ones are a problem). */
  duplicateActorNames: number;
  /** LinkedStructures entries without the link back. */
  oneWayLinks: number;
}

/** Counts what would confuse the game; compare a save before and after an edit. */
export function checkConsistency(ed: SaveEditor): Consistency {
  const actors = new Map<string, number>();
  const items = new Map<string, number>();
  const dinos = new Map<string, number>();
  let refsOutOfRange = 0;
  let orphanComponents = 0;
  let oneWayLinks = 0;
  let objects = 0;
  const links = new Map<number, Set<number>>();
  const live = (i: number): boolean => ed.exists(i);
  for (let i = 0; i < ed.size; i++) {
    if (!live(i)) continue;
    objects++;
    const h = ed.header(i);
    if (h.names.length === 1) actors.set(h.names[0], (actors.get(h.names[0]) ?? 0) + 1);
    for (const t of ed.refs(i)) if (t < -1 || t >= ed.size || !live(t)) refsOutOfRange++;
  }
  for (let i = 0; i < ed.size; i++) {
    if (!live(i)) continue;
    const h = ed.header(i);
    if (h.names.length === 2 && !actors.has(h.names[1])) orphanComponents++;
    if (h.names.length > 1) continue;
    if (!h.isItem && !h.location) continue;
    const props = ed.props(i);
    const get = (l: Property[], n: string): unknown => l.find((p) => p.name === n && p.index === 0)?.value;
    if (h.isItem) {
      const id = get(props, 'ItemId');
      if (Array.isArray(id)) {
        const k = `${String(get(id as Property[], 'ItemID1'))}:${String(get(id as Property[], 'ItemID2'))}`;
        items.set(k, (items.get(k) ?? 0) + 1);
      }
      continue;
    }
    const d1 = get(props, 'DinoID1');
    if (typeof d1 === 'number') {
      const k = `${d1}:${String(get(props, 'DinoID2'))}`;
      dinos.set(k, (dinos.get(k) ?? 0) + 1);
    }
    const ls = get(props, 'LinkedStructures');
    if (Array.isArray(ls)) {
      links.set(i, new Set((ls as { index?: number }[]).map((e) => e?.index ?? -1).filter((x) => x >= 0)));
    }
  }
  for (const [i, set] of links) for (const t of set) if (!links.get(t)?.has(i)) oneWayLinks++;
  const dup = (m: Map<string, number>): number => [...m.values()].filter((n) => n > 1).reduce((s, n) => s + n, 0);
  return {
    objects, refsOutOfRange, orphanComponents, duplicateItemIds: dup(items), duplicateDinoIds: dup(dinos),
    duplicateActorNames: dup(actors), oneWayLinks,
  };
}
