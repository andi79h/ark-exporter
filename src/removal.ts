// Removing every object of some classes from a world save (a mod that goes away), with a refund
// list per tribe so admins can hand out replacements.
//
// What goes:
// - World objects of the classes: structures, creatures and other actors with their components and
//   inventory items (deleteObjects), and items of the classes in any inventory, also foreign ones.
// - Inside embedded archives (cryopods, soul traps, Dino Storage's recovery list): items of the
//   classes are taken out of the archive; a creature of the classes takes its whole container with
//   it (the cryopod or soul item, or the entry of a list such as "CCA Misc Data").
// What stays and is reported: components of the classes on actors that stay, path references to
// the classes in other objects (crafting recipes, logs; the game resolves them to nothing), bytes
// that do not encode back identically.
import { ClassEvidence, classOfPath, gatherEvidence, inOrigin, isPathValue, OwnerIndex, packagePrefix, teamOf, type TeamInfo, topCounts } from './classes.ts';
import type { SaveEditor, Transform } from './editor.ts';
import { archiveRoot, blobRoundTrips, componentFlags, decodeBlob, encodeBlob } from './embedded.ts';
import { deleteObjects, syncItemCounts } from './operations.ts';
import { findProperty, type Property, remapRefs, type TreeContainer, type TreeObject } from './tree.ts';
import { classify, classMatcher, numberProp, ownedClosure, prop } from './world.ts';

export interface RemovalTarget {
  /** Short class names, * as wildcard. */
  classes?: string[];
  /** Packages (/Game/Mods/X or X): every class proven to come from there. */
  packages?: string[];
  /** Asset list (see ClassEvidence.loadAssetList); needed to know all classes of a package. */
  assetList?: string;
  /** Also remove classes whose short name occurs in another package too. */
  trustShortNames?: boolean;
}

export interface RefundEntry {
  team: number | null;
  tribeName: string | null;
  /** class: the object is of a removed class; content: it was inside or on something removed. */
  reason: 'class' | 'content';
  kind: string;
  cls: string;
  blueprint: boolean;
  quantity: number;
  /** Where it was: the actor holding it, for embedded objects the chain of containers. */
  holder: string;
  at: { x: number; y: number; z: number } | null;
}

export interface RefundRow extends Omit<RefundEntry, 'quantity' | 'at'> {
  objects: number;
  quantity: number;
  x: number | null;
  y: number | null;
  z: number | null;
}

export interface ClassDecision {
  cls: string;
  /** Objects in the world and inside embedded archives. */
  world: number;
  embedded: number;
  origins: string[];
  removed: boolean;
  why?: string;
}

export interface RemovalReport {
  classes: ClassDecision[];
  /** World objects removed (with components and contents). */
  removed: number;
  /** World items of the classes that sat in inventories of actors that stay. */
  itemsInOtherInventories: number;
  /** Objects whose references to removed objects were cleaned. */
  cleaned: number;
  mayCollapseCount: number;
  mayCollapse: { index: number; cls: string; name: string; via: string[] }[];
  embedded: {
    /** Byte arrays rewritten with items taken out. */
    archivesChanged: number;
    /** Objects taken out of embedded archives. */
    objectsRemoved: number;
    /** List entries dropped from actors (e.g. Dino Storage recovery entries). */
    entriesDropped: Record<string, number>;
    /** Byte arrays that would change but do not encode back identically (left as they are). */
    notRewritable: number;
    /** Removed creatures inside property values that cannot be dropped (left as they are). */
    unremovable: number;
  };
  /** Components of the classes on actors that stay (not removed). */
  componentsKept: Record<string, number>;
  /** Path references to removed classes left in other objects, by property. */
  pathReferencesLeft: Record<string, number>;
  engramsRemoved: number;
  /** Container counters (CurrentItemCount, ResourceCount) set to what is left. */
  countersSynced: number;
  assetList: boolean;
}

interface Where {
  owner: () => TeamInfo;
  holder: () => string;
  at: () => Transform | null;
  /** Inside an item (cryopod, soul trap): an item of a removed class only empties its slot there. */
  inItem: boolean;
}

interface Ctx {
  isClass: (cls: string | null) => boolean;
  isPath: (path: string) => boolean;
  refunds: RefundEntry[];
  silent: boolean;
  archivesChanged: number;
  objectsRemoved: number;
  notRewritable: number;
  unremovable: number;
  entriesDropped: Map<string, number>;
  componentsKept: Map<string, number>;
  pathRefs: Map<string, number>;
  topName: string;
}

const inc = (m: Map<string, number>, k: string, n = 1): void => { m.set(k, (m.get(k) ?? 0) + n); };

/** Counters and refunds, to undo what was recorded for something that goes as a whole after all. */
type Mark = [number, number, number, number, number];
const mark = (c: Ctx): Mark => [c.refunds.length, c.archivesChanged, c.objectsRemoved, c.notRewritable, c.unremovable];
const reset = (c: Ctx, m: Mark): void => { [c.refunds.length, c.archivesChanged, c.objectsRemoved, c.notRewritable, c.unremovable] = m; };

function quantityOf(props: Property[]): number {
  const q = numberProp(props, 'ItemQuantity');
  return q !== null && q > 0 ? q : 1;
}

function itemKey(props: Property[]): string | null {
  const id = prop(props, 'ItemId');
  if (!Array.isArray(id)) return null;
  return `${String(prop(id as Property[], 'ItemID1'))}:${String(prop(id as Property[], 'ItemID2'))}`;
}

function refund(ctx: Ctx, e: RefundEntry): void {
  if (!ctx.silent) ctx.refunds.push(e);
}

/** An object of an embedded archive, recorded as lost; nested archives too. Components go with their actor. */
function refundObject(ctx: Ctx, o: { cls: string | null; isItem: number; props: Property[] }, owner: TeamInfo, holder: string, at: Transform | null): void {
  if (o.isItem && prop(o.props, 'bIsEngram') === true) return;
  const cls = o.cls ?? '';
  refund(ctx, {
    team: owner.team, tribeName: owner.name, reason: ctx.isClass(cls) ? 'class' : 'content',
    kind: o.isItem ? 'item' : findProperty(o.props, 'DinoID1') ? 'dino' : 'actor', cls,
    blueprint: prop(o.props, 'bIsBlueprint') === true, quantity: o.isItem ? quantityOf(o.props) : 1, holder,
    at: at ? { x: at.x, y: at.y, z: at.z } : null,
  });
  refundBlobs(ctx, o.props, owner, `${cls} in ${holder}`, at);
}

function refundBlobs(ctx: Ctx, list: Property[], owner: TeamInfo, holder: string, at: Transform | null): void {
  for (const p of list) {
    if (p.opaque) continue;
    const v = p.value;
    if (p.type === 'StructProperty' && Array.isArray(v)) refundBlobs(ctx, v as Property[], owner, holder, at);
    if (p.type !== 'ArrayProperty') continue;
    if (Buffer.isBuffer(v)) refundBlob(ctx, v, owner, holder, at);
    else if (p.inner === 'StructProperty' && !p.elementStruct && Array.isArray(v)) for (const e of v) refundBlobs(ctx, e as Property[], owner, holder, at);
  }
}

function refundBlob(ctx: Ctx, bytes: Buffer, owner: TeamInfo, holder: string, at: Transform | null): void {
  const d = decodeBlob(bytes);
  if (!d) return;
  if (d.kind === 'archive') {
    const own = archiveOwner(d.tree, owner);
    const comp = componentFlags(d.tree.objects);
    d.tree.objects.forEach((o, k) => { if (!comp[k]) refundObject(ctx, o, own, holder, at); });
    return;
  }
  const arch = prop(d.list, 'ItemArchetype');
  if (isPathValue(arch)) {
    const cls = classOfPath(arch.path);
    // A soul trap in a shared list belongs to the tribe of the creature inside.
    if (owner.team === null) owner = innerOwner(d.list) ?? owner;
    refund(ctx, {
      team: owner.team, tribeName: owner.name, reason: ctx.isPath(arch.path) ? 'class' : 'content', kind: 'item', cls,
      blueprint: prop(d.list, 'bIsBlueprint') === true, quantity: quantityOf(d.list), holder, at: at ? { x: at.x, y: at.y, z: at.z } : null,
    });
    refundBlobs(ctx, d.list, owner, `${cls} in ${holder}`, at);
  } else {
    refundBlobs(ctx, d.list, owner, holder, at);
  }
}

/** Team of the first creature in the embedded archives of a property list. */
function innerOwner(list: Property[]): TeamInfo | null {
  for (const p of list) {
    if (p.opaque) continue;
    const v = p.value;
    if (p.type === 'ArrayProperty' && Buffer.isBuffer(v)) {
      const d = decodeBlob(v);
      if (d?.kind === 'archive') {
        const t = archiveOwner(d.tree, { team: null, name: null });
        if (t.team !== null) return t;
      }
    } else if (p.type === 'StructProperty' && Array.isArray(v)) {
      const t = innerOwner(v as Property[]);
      if (t) return t;
    } else if (p.type === 'ArrayProperty' && p.inner === 'StructProperty' && !p.elementStruct && Array.isArray(v)) {
      for (const e of v as Property[][]) {
        const t = innerOwner(e);
        if (t) return t;
      }
    }
  }
  return null;
}

/** Creatures in cryopods and soul traps keep their tribe; everything else belongs to the outer owner. */
function archiveOwner(tree: TreeContainer, outer: TeamInfo): TeamInfo {
  const root = archiveRoot(tree.objects);
  const t = root ? teamOf(root.props) : null;
  return t && t.team !== null ? t : outer;
}

/** doom: a creature of a removed class (its container goes); doomItem: an item info of a removed class. */
type Prune = 'keep' | 'changed' | 'doom' | 'doomItem';

/**
 * Top level of an object or item info. In items, anything doomed inside dooms the item. Elsewhere
 * the element of a struct array holding it is dropped (a recovery entry), otherwise it stays.
 */
function pruneTop(list: Property[], isItem: boolean, ctx: Ctx, where: Where): Prune {
  let changed = false;
  for (const p of list) {
    if (p.opaque) continue;
    ctx.topName = p.name;
    if (p.type === 'ArrayProperty' && p.inner === 'StructProperty' && !p.elementStruct && Array.isArray(p.value)) {
      const items = p.value as Property[][];
      const out: Property[][] = [];
      for (const e of items) {
        const m = mark(ctx);
        const r = pruneDeep(e, ctx, where);
        if (r === 'doom' || r === 'doomItem') {
          if (isItem) return 'doom';
          reset(ctx, m); // the whole entry goes, recorded below
          refundBlobs(ctx, e, where.owner(), where.holder(), where.at());
          inc(ctx.entriesDropped, p.name);
          changed = true;
          continue;
        }
        if (r === 'changed') changed = true;
        out.push(e);
      }
      if (out.length !== items.length) p.value = out;
      continue;
    }
    const r = pruneDeep([p], ctx, where);
    if (r === 'doom' || r === 'doomItem') {
      if (isItem) return 'doom';
      ctx.unremovable++;
      continue;
    }
    if (r === 'changed') changed = true;
  }
  return changed ? 'changed' : 'keep';
}

function countPath(ctx: Ctx, path: string): void {
  if (ctx.isPath(path)) inc(ctx.pathRefs, ctx.topName);
}

function pruneDeep(list: Property[], ctx: Ctx, where: Where): Prune {
  let changed = false;
  for (const p of list) {
    if (p.opaque) continue;
    const v = p.value;
    if (p.type === 'ObjectProperty') { if (isPathValue(v)) countPath(ctx, v.path); continue; }
    if (p.type === 'StructProperty') {
      if (!Array.isArray(v)) continue;
      const r = pruneDeep(v as Property[], ctx, where);
      if (r === 'doom' || r === 'doomItem') return 'doom';
      if (r === 'changed') changed = true;
      continue;
    }
    if (p.type !== 'ArrayProperty') continue;
    if (Buffer.isBuffer(v)) {
      const r = pruneBlob(v, ctx, where);
      if (r === 'doom') return 'doom';
      if (r === 'doomItem') {
        // A saddle or costume next to the creature in a cryopod: the slot is emptied, the creature stays.
        if (!where.inItem) return 'doom';
        refundBlob(ctx, v, where.owner(), where.holder(), where.at());
        p.value = Buffer.alloc(0);
        ctx.objectsRemoved++;
        changed = true;
        continue;
      }
      if (Buffer.isBuffer(r)) { p.value = r; changed = true; }
      continue;
    }
    if (!Array.isArray(v)) continue;
    if (p.inner === 'ObjectProperty') {
      for (const e of v) if (isPathValue(e)) countPath(ctx, e.path);
    } else if (p.inner === 'StructProperty' && !p.elementStruct) {
      for (const e of v as Property[][]) {
        const r = pruneDeep(e, ctx, where);
        if (r === 'doom' || r === 'doomItem') return 'doom';
        if (r === 'changed') changed = true;
      }
    }
  }
  return changed ? 'changed' : 'keep';
}

function pruneBlob(bytes: Buffer, ctx: Ctx, where: Where): 'keep' | 'doom' | 'doomItem' | Buffer {
  const d = decodeBlob(bytes);
  if (!d) return 'keep';
  const m = mark(ctx);
  const r = d.kind === 'archive' ? pruneArchive(d.tree, ctx, where) : pruneItemInfo(d.list, ctx, where);
  if (r !== 'changed') return r;
  if (!blobRoundTrips(bytes)) {
    reset(ctx, m);
    ctx.notRewritable++;
    return 'keep';
  }
  ctx.archivesChanged++;
  return encodeBlob(d);
}

function pruneItemInfo(list: Property[], ctx: Ctx, where: Where): Prune {
  const arch = prop(list, 'ItemArchetype');
  if (isPathValue(arch)) {
    if (ctx.isPath(arch.path)) return 'doomItem';
    const cls = classOfPath(arch.path);
    return pruneTop(list, true, ctx, { ...where, holder: () => `${cls} in ${where.holder()}`, inItem: true });
  }
  return pruneTop(list, false, ctx, where);
}

function pruneArchive(tree: TreeContainer, ctx: Ctx, where: Where): Prune {
  const objs = tree.objects;
  const comp = componentFlags(objs);
  if (objs.some((o, k) => !o.isItem && !comp[k] && ctx.isClass(o.cls))) return 'doom';
  const root = archiveRoot(objs);
  const owner = (): TeamInfo => archiveOwner(tree, where.owner());
  const holder = (): string => (root ? `${root.cls} in ${where.holder()}` : where.holder());
  const remove = new Set<number>();
  let changed = false;
  objs.forEach((o, k) => {
    if (ctx.isClass(o.cls)) {
      if (o.isItem) remove.add(k);
      else inc(ctx.componentsKept, o.cls ?? '');
      return;
    }
    const m = mark(ctx);
    const r = pruneTop(o.props, o.isItem !== 0, ctx, { owner, holder, at: where.at, inItem: o.isItem !== 0 });
    if (r === 'doom' || r === 'doomItem') {
      // Doom comes back from items only (pruneTop); the item goes as a whole, recorded below.
      reset(ctx, m);
      remove.add(k);
    } else if (r === 'changed') {
      changed = true;
    }
  });
  if (remove.size === 0) return changed ? 'changed' : 'keep';
  for (const k of remove) refundObject(ctx, objs[k], owner(), holder(), where.at());
  const map = new Map<number, number>();
  let next = 0;
  objs.forEach((_, k) => { if (!remove.has(k)) map.set(k, next++); });
  const kept: TreeObject[] = objs.filter((_, k) => !remove.has(k));
  for (const o of kept) remapRefs(o.props, (t) => map.get(t) ?? -1, true);
  tree.order = tree.order.filter((k) => !remove.has(k)).map((k) => map.get(k)!);
  tree.objects = kept;
  ctx.objectsRemoved += remove.size;
  return 'changed';
}

/** Classes to remove, after the short-name check. */
function decideClasses(ed: SaveEditor, target: RemovalTarget, ev: ClassEvidence): {
  decisions: ClassDecision[]; isClass: (cls: string | null) => boolean; isPath: (path: string) => boolean;
} {
  const packages = (target.packages ?? []).map(packagePrefix);
  const patterns = target.classes ?? [];
  if (!packages.length && !patterns.length) throw new Error('nothing to remove: give --class or --package');
  const byPattern = patterns.length ? classMatcher(patterns) : () => false;
  const world = new Map<string, { cls: string; n: number }>();
  const embedded = new Map<string, { cls: string; n: number }>();
  const note = (m: typeof world, cls: string): void => {
    const k = cls.toLowerCase();
    const e = m.get(k);
    if (e) e.n++;
    else m.set(k, { cls, n: 1 });
  };
  for (let i = 0; i < ed.size; i++) {
    if (!ed.exists(i)) continue;
    note(world, ed.cls(i));
    gatherEvidence(ed.props(i), ev, (c) => note(embedded, c));
  }
  const fromPackage = new Set<string>();
  for (const pkg of packages) for (const c of ev.classesIn(pkg)) fromPackage.add(c.toLowerCase());
  const all = new Set([...world.keys(), ...embedded.keys()]);
  const decisions: ClassDecision[] = [];
  const doomed = new Set<string>();
  const refused = new Set<string>();
  for (const k of all) {
    const cls = world.get(k)?.cls ?? embedded.get(k)!.cls;
    const inPkg = fromPackage.has(k);
    if (!inPkg && !byPattern(cls)) continue;
    const origins = ev.origins(cls);
    let removed = true;
    let why: string | undefined;
    if (inPkg) {
      const pkg = packages.find((p) => ev.check(cls, p).own.length > 0)!;
      const chk = ev.check(cls, pkg);
      if (chk.status === 'ambiguous' && !target.trustShortNames) { removed = false; why = `short name also in ${chk.others.slice(0, 3).join(', ')}`; }
    } else if (origins.length > 1 && !target.trustShortNames) {
      removed = false;
      why = `short name occurs in ${origins.join(', ')}`;
    }
    (removed ? doomed : refused).add(k);
    decisions.push({ cls, world: world.get(k)?.n ?? 0, embedded: embedded.get(k)?.n ?? 0, origins, removed, ...(why ? { why } : {}) });
  }
  decisions.sort((a, b) => b.world + b.embedded - a.world - a.embedded || (a.cls < b.cls ? -1 : 1));
  const isClass = (cls: string | null): boolean => cls !== null && doomed.has(cls.toLowerCase());
  // Classes that occur only as paths (items inside item infos) follow the same short-name rule.
  const isPath = (path: string): boolean => {
    if (packages.some((p) => inOrigin(path, p))) return true;
    const c = classOfPath(path);
    if (!byPattern(c)) return false;
    return isClass(c) || (!refused.has(c.toLowerCase()) && (target.trustShortNames === true || ev.origins(c).length <= 1));
  };
  return { decisions, isClass, isPath };
}

/** Removes the classes; the editor holds the result (write it, or drop it for a dry run). */
export function removeClasses(ed: SaveEditor, target: RemovalTarget): { report: RemovalReport; refunds: RefundEntry[] } {
  const ev = new ClassEvidence();
  if (target.assetList !== undefined) ev.loadAssetList(target.assetList);
  const { decisions, isClass, isPath } = decideClasses(ed, target, ev);
  const owners = new OwnerIndex(ed);
  const ctx: Ctx = {
    isClass, isPath, refunds: [], silent: false, archivesChanged: 0, objectsRemoved: 0, notRewritable: 0, unremovable: 0,
    entriesDropped: new Map(), componentsKept: new Map(), pathRefs: new Map(), topName: '',
  };

  // 1. World objects of the classes.
  const roots = new Set<number>();
  const components: number[] = [];
  for (let i = 0; i < ed.size; i++) {
    if (!ed.exists(i) || !isClass(ed.cls(i))) continue;
    const h = ed.header(i);
    if (!h.isItem && h.names.length > 1) components.push(i);
    else roots.add(i);
  }
  let closure = ownedClosure(ed, roots);
  for (const c of components) if (!closure.has(c)) inc(ctx.componentsKept, ed.cls(c));

  // 2. Embedded archives and entries in everything that stays.
  const holderCls = (i: number): string => {
    const a = owners.holder(i);
    return a === null ? 'loose' : ed.cls(a);
  };
  const atOf = (i: number): Transform | null => {
    const a = owners.holder(i);
    return (a !== null ? ed.header(a).location : null) ?? ed.header(i).location;
  };
  const seenActors = new Set<string>();
  const seenItems = new Set<string>();
  const itemRoots = new Set<number>();
  for (let i = 0; i < ed.size; i++) {
    if (!ed.exists(i) || closure.has(i)) continue;
    const copy = ed.get(i);
    const isItem = copy.isItem !== 0;
    // The game writes some actors twice; both copies change, the refund counts once.
    const key = isItem ? itemKey(copy.props) : copy.names.length === 1 ? `${copy.cls}|${copy.names[0]}` : null;
    const seen = key !== null && (isItem ? seenItems : seenActors).has(key);
    if (key !== null) (isItem ? seenItems : seenActors).add(key);
    ctx.silent = seen;
    const where: Where = {
      owner: () => owners.team(i),
      holder: () => (isItem ? `${copy.cls} in ${holderCls(i)}` : copy.cls),
      at: () => atOf(i),
      inItem: isItem,
    };
    const m = mark(ctx);
    const outer = ctx.pathRefs;
    ctx.pathRefs = new Map();
    const r = pruneTop(copy.props, isItem, ctx, where);
    if (r === 'doom') {
      reset(ctx, m); // the item goes as a whole, recorded with the closure below
      itemRoots.add(i);
    } else {
      for (const [k, n] of ctx.pathRefs) inc(outer, k, n);
      if (r === 'changed') {
        const o = ed.edit(i);
        if (o !== copy) o.props = copy.props;
      }
    }
    ctx.pathRefs = outer;
  }
  ctx.silent = false;
  if (itemRoots.size) {
    for (const i of itemRoots) roots.add(i);
    closure = ownedClosure(ed, roots);
  }

  // 3. Refund list for everything that goes, holders whose counters need an update.
  const holders = new Set<number>();
  let engramsRemoved = 0;
  let itemsInOtherInventories = 0;
  const seenRefund = new Set<string>();
  for (const i of [...closure].sort((a, b) => a - b)) {
    const h = ed.header(i);
    if (!h.isItem && h.names.length > 1) continue;
    const props = ed.props(i);
    if (h.isItem) {
      const a = owners.holder(i);
      if (a !== null && !closure.has(a)) {
        holders.add(a);
        if (isClass(h.cls)) itemsInOtherInventories++;
      }
      if (prop(props, 'bIsEngram') === true) { engramsRemoved++; continue; }
    }
    const key = h.isItem ? itemKey(props) : `${h.cls}|${h.names[0]}`;
    if (key !== null) {
      if (seenRefund.has(key)) continue;
      seenRefund.add(key);
    }
    const owner = owners.team(i);
    const at = atOf(i);
    const holder = h.isItem ? holderCls(i) : '';
    refund(ctx, {
      team: owner.team, tribeName: owner.name, reason: isClass(h.cls) ? 'class' : 'content', kind: classify(ed, i, props), cls: h.cls,
      blueprint: prop(props, 'bIsBlueprint') === true, quantity: h.isItem ? quantityOf(props) : 1, holder,
      at: at ? { x: at.x, y: at.y, z: at.z } : null,
    });
    refundBlobs(ctx, props, owner, h.isItem ? `${h.cls} in ${holder}` : h.cls, at);
  }

  // 4. Remove, then let containers count what is left.
  const del = deleteObjects(ed, roots);
  let countersSynced = 0;
  for (const a of holders) if (ed.exists(a)) { syncItemCounts(ed, a); countersSynced++; }

  return {
    report: {
      classes: decisions, removed: del.removed, itemsInOtherInventories, cleaned: del.cleaned,
      mayCollapseCount: del.mayCollapse.length, mayCollapse: del.mayCollapse.slice(0, 50),
      embedded: {
        archivesChanged: ctx.archivesChanged, objectsRemoved: ctx.objectsRemoved, entriesDropped: Object.fromEntries(ctx.entriesDropped),
        notRewritable: ctx.notRewritable, unremovable: ctx.unremovable,
      },
      componentsKept: Object.fromEntries(ctx.componentsKept), pathReferencesLeft: topCounts(ctx.pathRefs, 100),
      engramsRemoved, countersSynced, assetList: ev.hasAssetList,
    },
    refunds: ctx.refunds,
  };
}

// ---------------------------------------------------------------- refund list

/** Groups refund entries by tribe, reason, kind, class, holder and area (grid cell of `grid` units). */
export function aggregateRefunds(entries: RefundEntry[], grid = 10_000): RefundRow[] {
  const rows = new Map<string, RefundRow>();
  for (const e of entries) {
    const cell = e.at ? [e.at.x, e.at.y, e.at.z].map((v) => Math.floor(v / grid)).join(',') : '-';
    const k = [e.team, e.tribeName, e.reason, e.kind, e.cls, e.blueprint, e.holder, cell].join('\u0000');
    const r = rows.get(k);
    if (r) { r.objects++; r.quantity += e.quantity; continue; }
    rows.set(k, {
      team: e.team, tribeName: e.tribeName, reason: e.reason, kind: e.kind, cls: e.cls, blueprint: e.blueprint, holder: e.holder,
      objects: 1, quantity: e.quantity,
      x: e.at ? Math.round(e.at.x) : null, y: e.at ? Math.round(e.at.y) : null, z: e.at ? Math.round(e.at.z) : null,
    });
  }
  const cmp = (a: string | number | null, b: string | number | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);
  return [...rows.values()].sort((a, b) => cmp(a.team, b.team) || cmp(a.reason, b.reason) || cmp(a.kind, b.kind) || cmp(a.cls, b.cls)
    || cmp(a.holder, b.holder) || cmp(a.x, b.x) || cmp(a.y, b.y) || cmp(a.z, b.z));
}

const csvCell = (v: string | number | boolean | null): string => {
  const s = v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const REFUND_COLUMNS = ['map', 'tribe_id', 'tribe_name', 'reason', 'kind', 'class', 'blueprint', 'objects', 'quantity', 'holder', 'x', 'y', 'z'];

/** CSV (comma, RFC 4180 quoting, header line) of the aggregated refund list. */
export function refundCsv(map: string, rows: RefundRow[]): string {
  const lines = [REFUND_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([map, r.team, r.tribeName, r.reason, r.kind, r.cls, r.blueprint ? 1 : 0, r.objects, r.quantity, r.holder, r.x, r.y, r.z].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
