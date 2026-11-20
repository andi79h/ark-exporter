// Classes of a save and where they come from, for swapping or removing mods.
//
// The object table of an ASE save names the class of every object by its short name only
// ("StorageBox_Huge_C"); the game finds the class by that name among the loaded packages. Full
// paths ("/Game/Mods/StructuresPlusMod/.../StorageBox_Huge.StorageBox_Huge_C") occur only in
// properties: ObjectProperty paths (ItemArchetype, engram lists, crafting recipes), strings
// (buff class strings, Dino Storage data) and the embedded archives of cryopods and soul traps.
//
// Short names are not unique: mods ship copies of core assets under the same name (Primitive Plus
// has PrimalItemConsumable_RawMeat_Fish, Primal Fear Extras a Campfire). Rewriting "every object
// called X" would hit both. Paths are rewritten only when the full path matches. Short names in
// object headers are rewritten only when the name is proven to belong to the old package alone
// (ClassEvidence: paths found in the save plus an optional asset list of all loaded packages).
import { itemArchetype } from './cluster.ts';
import type { SaveEditor } from './editor.ts';
import { archiveRoot, componentFlags, decodeBlob, encodeBlob } from './embedded.ts';
import type { ObjectValue, Property, TreeContainer, TreeValue } from './tree.ts';
import { numberProp, prop, stringProp } from './world.ts';

// ---------------------------------------------------------------- paths and origins

/** "/Game/A/B.B_C" from any spelling of a class path (see itemArchetype). */
export function classPath(spec: string): string {
  try {
    return itemArchetype(spec).slice('BlueprintGeneratedClass '.length);
  } catch {
    throw new RangeError(`not a class path: ${spec}`);
  }
}

/** Short class name of an object or class path: "/Game/A/B.B" and "/Game/A/B.B_C" are both "B_C". */
export function classOfPath(path: string): string {
  const s = pathPart(path);
  const slash = s.lastIndexOf('/');
  const tail = s.slice(slash + 1);
  const dot = tail.lastIndexOf('.');
  const obj = dot === -1 ? tail : tail.slice(dot + 1);
  return /_C$/i.test(obj) ? obj : `${obj}_C`;
}

/** The "/Game/..." part of a stored path ("BlueprintGeneratedClass /Game/A/B.B_C" -> "/Game/A/B.B_C"); the text itself otherwise. */
export function pathPart(s: string): string {
  const m = /\/Game\/\S+/i.exec(s);
  return m ? m[0] : s;
}

/** Package root a path belongs to: "/Game/Mods/<Name>" for mods (and the official mod maps), "/Game" for the core game. */
export function originOf(path: string): string {
  const m = /^\/Game\/Mods\/[^/.]+/i.exec(pathPart(path));
  return m ? m[0] : '/Game';
}

/** Whether a path lies inside an origin or package prefix ("/Game" = core = not under /Game/Mods/). */
export function inOrigin(path: string, origin: string): boolean {
  const p = pathPart(path).toLowerCase();
  const o = origin.toLowerCase().replace(/\/+$/, '');
  if (o === '/game') return p.startsWith('/game/') && !p.startsWith('/game/mods/');
  return p.startsWith(`${o}/`) || p.startsWith(`${o}.`);
}

/** "/Game/Mods/X" for "X", "/Game/Mods/X/" or "/Game/Mods/X". */
export function packagePrefix(spec: string): string {
  const s = spec.trim().replace(/\/+$/, '');
  if (!s) throw new RangeError('empty package');
  if (!s.startsWith('/')) {
    if (!/^[\w-]+$/.test(s)) throw new RangeError(`not a package: ${spec}`);
    return `/Game/Mods/${s}`;
  }
  if (!/^\/Game(\/[\w-]+)*$/i.test(s)) throw new RangeError(`not a package path: ${spec}`);
  return s;
}

/** Object paths inside any text ("BlueprintGeneratedClass /Game/A/B.B_C", ",/Game/A/B.B|0"). */
const PATH_IN_TEXT = /\/Game\/[\w\-/]+\.[\w-]+/gi;

const hasGamePath = (s: string): boolean => s.indexOf('/Game/') !== -1 || s.indexOf('/game/') !== -1;

/** ObjectProperty value that names a path (class or asset), not an object index. */
export const isPathValue = (v: unknown): v is { path: string } =>
  v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !Array.isArray(v) && 'path' in v && typeof (v as { path: unknown }).path === 'string';

// ---------------------------------------------------------------- evidence for short names

export interface EvidenceEntry {
  /** Full path, or null for a bare name from an asset list (counts as core). */
  path: string | null;
  origin: string;
  /** Occurrences in the scanned files. */
  seen: number;
  /** Listed in the asset list. */
  listed: boolean;
}

export type ShortNameStatus = 'verified' | 'ambiguous' | 'unverified';

export interface ShortNameCheck {
  status: ShortNameStatus;
  origin: string;
  /** Paths inside the origin (proof that the class comes from there). */
  own: string[];
  /** Paths of the same short name from other packages. */
  others: string[];
}

/** Which packages a short class name occurs in, from paths in the save and an optional asset list. */
export class ClassEvidence {
  private readonly byClass = new Map<string, Map<string, EvidenceEntry>>();
  /** True once an asset list was loaded. */
  hasAssetList = false;

  private entry(cls: string, key: string, path: string | null, origin: string): EvidenceEntry {
    const k = cls.toLowerCase();
    let m = this.byClass.get(k);
    if (!m) { m = new Map(); this.byClass.set(k, m); }
    let e = m.get(key);
    if (!e) { e = { path, origin, seen: 0, listed: false }; m.set(key, e); }
    return e;
  }

  /** Object or class path found in a file. */
  seen(path: string): void {
    this.entry(classOfPath(path), path.replace(/_C$/i, '').toLowerCase(), path, originOf(path)).seen++;
  }

  /** Every object path inside a text. */
  seenInText(s: string): void {
    if (!hasGamePath(s)) return;
    for (const m of s.matchAll(PATH_IN_TEXT)) this.seen(m[0]);
  }

  /**
   * Asset list: one asset per line, as full path (/Game/Mods/X/Dir/Asset, also with .Asset or
   * .Asset_C) or as bare name, which counts as core asset (core_assets.txt of the modding analysis).
   * Only the package root of a path is used, so "<root>/<asset>" is enough for mods.
   */
  loadAssetList(text: string): number {
    let n = 0;
    for (const raw of text.split(/\r?\n/)) {
      let s = raw.trim();
      if (!s || s.startsWith('#')) continue;
      s = s.replace(/^BlueprintGeneratedClass\s+/, '').replace(/^\w+'(.*)'$/, '$1').replace(/\.(uasset|umap)$/i, '');
      if (s.startsWith('/')) {
        this.entry(classOfPath(s), s.replace(/_C$/i, '').toLowerCase(), s, originOf(s)).listed = true;
      } else {
        this.entry(/_C$/i.test(s) ? s : `${s}_C`, `core:${s.toLowerCase()}`, null, '/Game').listed = true;
      }
      n++;
    }
    this.hasAssetList = true;
    return n;
  }

  entries(cls: string): EvidenceEntry[] {
    return [...(this.byClass.get(cls.toLowerCase())?.values() ?? [])];
  }

  /** Origins a short name was seen or listed in. */
  origins(cls: string): string[] {
    return [...new Set(this.entries(cls).map((e) => e.origin))].sort();
  }

  /**
   * verified: the name occurs in the expected package and nowhere else; ambiguous: also in another
   * package; unverified: no evidence either way (no path in the save, not in the asset list).
   */
  check(cls: string, origin: string): ShortNameCheck {
    const own: string[] = [];
    const others: string[] = [];
    for (const e of this.entries(cls)) {
      const inside = e.path === null ? origin.toLowerCase() === '/game' : inOrigin(e.path, origin);
      (inside ? own : others).push(e.path ?? `${e.origin} (asset list: ${cls})`);
    }
    const status: ShortNameStatus = others.length ? 'ambiguous' : own.length ? 'verified' : 'unverified';
    return { status, origin, own: own.sort(), others: others.sort() };
  }

  /** All classes with evidence inside an origin. */
  classesIn(origin: string): string[] {
    const out: string[] = [];
    for (const m of this.byClass.values()) {
      for (const e of m.values()) {
        if (e.path !== null && inOrigin(e.path, origin)) { out.push(classOfPath(e.path)); break; }
      }
    }
    return out;
  }

  /** Paths seen in the scanned files inside an origin, with counts, by class. */
  seenIn(origin: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const m of this.byClass.values()) {
      for (const e of m.values()) {
        if (e.path !== null && e.seen > 0 && inOrigin(e.path, origin)) {
          const c = classOfPath(e.path);
          out.set(c, (out.get(c) ?? 0) + e.seen);
        }
      }
    }
    return out;
  }
}

/**
 * Adds every path of a property list to the evidence, embedded archives included, and reports the
 * classes of the objects inside embedded archives.
 */
export function gatherEvidence(list: Property[], ev: ClassEvidence, onEmbeddedClass?: (cls: string) => void): void {
  const text = (v: unknown): void => { if (typeof v === 'string') ev.seenInText(v); };
  for (const p of list) {
    if (p.opaque) continue;
    const v = p.value;
    if (p.type === 'ObjectProperty') { if (isPathValue(v)) text(v.path); continue; }
    if (p.type === 'StrProperty' || p.type === 'NameProperty') { text(v); continue; }
    if (p.type === 'StructProperty') { if (Array.isArray(v)) gatherEvidence(v as Property[], ev, onEmbeddedClass); continue; }
    if (p.type !== 'ArrayProperty') continue;
    if (Buffer.isBuffer(v)) {
      const d = decodeBlob(v);
      if (d?.kind === 'archive') {
        for (const o of d.tree.objects) {
          if (o.cls && onEmbeddedClass) onEmbeddedClass(o.cls);
          gatherEvidence(o.props, ev, onEmbeddedClass);
        }
      } else if (d) {
        gatherEvidence(d.list, ev, onEmbeddedClass);
      }
      continue;
    }
    if (!Array.isArray(v)) continue;
    if (p.inner === 'ObjectProperty') for (const e of v) { if (isPathValue(e)) text(e.path); }
    else if (p.inner === 'StrProperty' || p.inner === 'NameProperty') for (const e of v) text(e);
    else if (p.inner === 'StructProperty' && !p.elementStruct) for (const e of v) gatherEvidence(e as Property[], ev, onEmbeddedClass);
  }
}

// ---------------------------------------------------------------- owners

export interface TeamInfo { team: number | null; name: string | null; }

/** Who holds an object: actors hold themselves, components their actor, items the actor of their inventory. */
export class OwnerIndex {
  private readonly ed: SaveEditor;
  private actorsByName: Map<string, number> | null = null;
  private readonly teams = new Map<number, TeamInfo>();

  constructor(ed: SaveEditor) { this.ed = ed; }

  private actors(): Map<string, number> {
    if (!this.actorsByName) {
      const m = new Map<string, number>();
      for (let i = 0; i < this.ed.size; i++) {
        if (!this.ed.exists(i)) continue;
        const h = this.ed.header(i);
        if (!h.isItem && h.names.length === 1 && !m.has(h.names[0])) m.set(h.names[0], i);
      }
      this.actorsByName = m;
    }
    return this.actorsByName;
  }

  /** Actor holding the object, null for items lying loose or components without actor. */
  holder(i: number, depth = 0): number | null {
    if (!this.ed.exists(i) || depth > 4) return null;
    const h = this.ed.header(i);
    if (h.isItem) {
      const inv = prop(this.ed.props(i), 'OwnerInventory');
      if (inv && typeof inv === 'object' && 'index' in inv && typeof inv.index === 'number' && inv.index >= 0) return this.holder(inv.index, depth + 1);
      return null;
    }
    if (h.names.length > 1) return this.actors().get(h.names[1]) ?? null;
    return i;
  }

  /** TargetingTeam and owner name of the actor that holds the object. */
  team(i: number): TeamInfo {
    const a = this.holder(i);
    if (a === null) return { team: null, name: null };
    let t = this.teams.get(a);
    if (!t) {
      t = teamOf(this.ed.props(a));
      this.teams.set(a, t);
    }
    return t;
  }
}

/** TargetingTeam and the owner name an object carries itself. */
export function teamOf(props: Property[]): TeamInfo {
  return {
    team: numberProp(props, 'TargetingTeam'),
    name: stringProp(props, 'OwnerName') ?? stringProp(props, 'TribeName') ?? stringProp(props, 'OwningPlayerName') ?? stringProp(props, 'PlayerName'),
  };
}

// ---------------------------------------------------------------- mapping file

export interface ClassRow {
  /** Line in the mapping file. */
  line: number;
  oldClass: string;
  newClass: string;
  /** Class paths, "/Game/A/B.B_C". */
  oldPath: string;
  newPath: string;
  /** Package the old class must come from (default: the package root of old_path). */
  onlyPackage: string | null;
}

const COLUMNS = ['old_class', 'new_class', 'old_path', 'new_path', 'only_mod_package'] as const;

/**
 * Mapping file, as TSV or JSON. TSV: tab-separated old_class, new_class, old_path, new_path and
 * optionally only_mod_package; a header line with these names may give another column order. Empty
 * lines and lines starting with # are skipped. JSON (text starting with "["): an array of objects
 * with the same keys, for programs calling the CLI. Rows apply simultaneously (A→B and B→C turn A
 * into B, not C). Line numbers in errors and reports are the TSV line or the 1-based array position.
 */
export function parseMapping(text: string): ClassRow[] {
  const rows: ClassRow[] = [];
  if (text.trimStart().startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new RangeError(`mapping is not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(data)) throw new RangeError('mapping JSON must be an array of rows');
    data.forEach((e, k) => {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new RangeError(`mapping entry ${k + 1}: expected an object`);
      const o = e as Record<string, unknown>;
      for (const key of Object.keys(o)) if (!(COLUMNS as readonly string[]).includes(key)) throw new RangeError(`mapping entry ${k + 1}: unknown key ${key}`);
      const get = (c: string): string => {
        const v = o[c];
        if (v === undefined || v === null) return '';
        if (typeof v !== 'string') throw new RangeError(`mapping entry ${k + 1}: ${c} must be a string`);
        return v.trim();
      };
      rows.push(mappingRow(get, k + 1, `mapping entry ${k + 1}`, rows));
    });
  } else {
    let cols: string[] = [...COLUMNS];
    let first = true;
    const lines = text.split(/\r?\n/);
    for (let n = 0; n < lines.length; n++) {
      const raw = lines[n];
      if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
      const cells = raw.split('\t').map((c) => c.trim());
      if (first && cells.includes('old_class')) {
        cols = cells.map((c) => c.toLowerCase());
        for (const need of COLUMNS.slice(0, 4)) if (!cols.includes(need)) throw new RangeError(`mapping header lacks column ${need}`);
        first = false;
        continue;
      }
      first = false;
      rows.push(mappingRow((c) => cells[cols.indexOf(c)] ?? '', n + 1, `mapping line ${n + 1}`, rows));
    }
  }
  if (!rows.length) throw new RangeError('mapping has no rows');
  return rows;
}

function mappingRow(get: (column: string) => string, line: number, where: string, rows: ClassRow[]): ClassRow {
  const oldClass = get('old_class');
  const newClass = get('new_class');
  for (const [k, v] of [['old_class', oldClass], ['new_class', newClass]]) {
    if (!/^[\w-]+$/.test(v)) throw new RangeError(`${where}: ${k} "${v}" is not a class name`);
  }
  if (!get('old_path') || !get('new_path')) throw new RangeError(`${where}: old_path and new_path are required (full class paths)`);
  const oldPath = classPath(get('old_path'));
  const newPath = classPath(get('new_path'));
  if (classOfPath(oldPath).toLowerCase() !== oldClass.toLowerCase()) throw new RangeError(`${where}: old_path names ${classOfPath(oldPath)}, old_class says ${oldClass}`);
  if (classOfPath(newPath).toLowerCase() !== newClass.toLowerCase()) throw new RangeError(`${where}: new_path names ${classOfPath(newPath)}, new_class says ${newClass}`);
  if (oldPath.toLowerCase() === newPath.toLowerCase()) throw new RangeError(`${where}: old and new path are the same`);
  const pkg = get('only_mod_package');
  const onlyPackage = pkg ? packagePrefix(pkg) : null;
  if (onlyPackage && !inOrigin(oldPath, onlyPackage)) throw new RangeError(`${where}: old_path ${oldPath} is not inside ${onlyPackage}`);
  const dup = rows.find((r) => r.oldClass.toLowerCase() === oldClass.toLowerCase() || r.oldPath.toLowerCase() === oldPath.toLowerCase());
  if (dup) throw new RangeError(`${where}: ${oldClass} is mapped already in line ${dup.line}`);
  return { line, oldClass, newClass, oldPath, newPath, onlyPackage };
}

// ---------------------------------------------------------------- remapping

export type Scope = 'world' | 'profile' | 'tribe' | 'cluster';
export type HitKind = 'header' | 'path' | 'string';

interface Visit {
  mode: 'scan' | 'apply';
  scope: Scope;
  embedded: boolean;
  /** Tribe the hits are counted for. */
  team: () => TeamInfo;
  /** File name for profiles, tribes and cluster files. */
  file?: string;
}

interface RowStats {
  found: Map<string, number>;
  rewritten: Map<string, number>;
  tribes: Map<string, { team: number | null; name: string | null; hits: number }>;
  files: Map<string, number>;
  components: Map<string, number>;
  oldObjects: number;
  oldProps: Map<string, number>;
}

export interface RowReport {
  line: number;
  oldClass: string;
  newClass: string;
  oldPath: string;
  newPath: string;
  onlyPackage: string | null;
  /** Package check of the short name; header rewriting needs "verified" (or --trust-short-names). */
  shortName: ShortNameCheck & { headerRewrite: boolean };
  /** Hits by layer: <scope>[.embedded].<header|path|string>. */
  found: Record<string, number>;
  rewritten: Record<string, number>;
  /** Hits found but left as they were (headers of unproven short names). */
  skipped: Record<string, number>;
  tribes: { team: number | null; name: string | null; hits: number }[];
  files: Record<string, number>;
  /** Component classes of the remapped actors and whether the mapping covers them. */
  components: Record<string, { objects: number; mapped: boolean }>;
  /**
   * Properties of old-class objects that no object of the new class in the same save has; the new
   * class probably ignores them. null when the save has no object of the new class to compare with.
   */
  properties: { oldObjects: number; targetObjects: number; notOnTarget: Record<string, number> | null; oldClassProperties?: string[] };
}

export interface RemapReport {
  rows: RowReport[];
  /** What is left of the packages the mapping takes classes from (objects by class, path references by class). */
  remaining: Record<string, { objects: Record<string, number>; ambiguous: Record<string, number>; references: Record<string, number> }>;
  assetList: boolean;
  embeddedNotRewritten: number;
}

const inc = (m: Map<string, number>, k: string, n = 1): void => { m.set(k, (m.get(k) ?? 0) + n); };
export const topCounts = (m: Map<string, number>, n: number): Record<string, number> =>
  Object.fromEntries([...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n));
const top = topCounts;

/**
 * Rewrites classes in two phases. scan* reads everything (counts hits, collects evidence for the
 * short names), decide() settles which rows may rewrite object headers, apply* changes the trees.
 * Instance names ("BP_CampfirePlus_C_35") stay: other objects refer to them by name.
 */
export class ClassRemapper {
  readonly rows: ClassRow[];
  readonly evidence = new ClassEvidence();
  private readonly trust: boolean;
  private readonly byClass = new Map<string, ClassRow>();
  private readonly byObject = new Map<string, ClassRow>();
  private readonly re: RegExp;
  private readonly stats = new Map<ClassRow, RowStats>();
  private readonly allowed = new Set<ClassRow>();
  /** Short names of the old and new classes, lower case, for the property comparison. */
  private readonly targetProps = new Map<string, { objects: number; names: Set<string> }>();
  /** Header classes seen (world and embedded), by lower-case name. */
  private readonly headerClasses = new Map<string, { cls: string; n: number }>();
  private decided = false;
  /** World objects with hits in their properties (scan), to visit again in apply. */
  private readonly touched = new Set<number>();
  private hitCount = 0;
  embeddedNotRewritten = 0;

  constructor(rows: ClassRow[], opts: { assetList?: string; trustShortNames?: boolean } = {}) {
    this.rows = rows;
    this.trust = opts.trustShortNames === true;
    if (opts.assetList !== undefined) this.evidence.loadAssetList(opts.assetList);
    const alts: string[] = [];
    for (const r of rows) {
      this.byClass.set(r.oldClass.toLowerCase(), r);
      const obj = r.oldPath.replace(/_C$/i, '');
      this.byObject.set(obj.toLowerCase(), r);
      alts.push(obj.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'));
      this.stats.set(r, {
        found: new Map(), rewritten: new Map(), tribes: new Map(), files: new Map(), components: new Map(), oldObjects: 0, oldProps: new Map(),
      });
      this.targetProps.set(r.newClass.toLowerCase(), { objects: 0, names: new Set() });
    }
    // Longest first, so a path that is the prefix of another one cannot win.
    alts.sort((a, b) => b.length - a.length);
    this.re = new RegExp(`(?<![\\w/])(${alts.join('|')})(_C)?(?![\\w/])`, 'gi');
  }

  // ------------------------------------------------------------ hits

  private hit(row: ClassRow, kind: HitKind, v: Visit): void {
    const s = this.stats.get(row)!;
    const key = `${v.scope}${v.embedded ? '.embedded' : ''}.${kind}`;
    this.hitCount++;
    if (v.mode === 'apply') { inc(s.rewritten, key); return; }
    inc(s.found, key);
    if (v.file) inc(s.files, v.file);
    const t = v.team();
    const tk = `${t.team ?? '-'}`;
    const e = s.tribes.get(tk);
    if (e) e.hits++;
    else s.tribes.set(tk, { team: t.team, name: t.name, hits: 1 });
  }

  /** New text, or null when nothing matched. Paths match only with their full package path. */
  private rewriteText(s: string, kind: HitKind, v: Visit): string | null {
    if (v.mode === 'scan') this.evidence.seenInText(s);
    // A bare short name proves no package: it changes only where object headers may change.
    const exact = kind === 'string' ? this.byClass.get(s.toLowerCase()) : undefined;
    if (exact) {
      if (v.mode === 'apply' && !this.allowed.has(exact)) return null;
      this.hit(exact, kind, v);
      return exact.newClass;
    }
    if (!hasGamePath(s)) return null;
    let changed = false;
    const out = s.replace(this.re, (_m, obj: string, c: string | undefined) => {
      const row = this.byObject.get(obj.toLowerCase())!;
      this.hit(row, kind, v);
      changed = true;
      return row.newPath.replace(/_C$/i, '') + (c ? '_C' : '');
    });
    return changed ? out : null;
  }

  private rewritePath(o: ObjectValue, v: Visit): ObjectValue | null {
    if (!isPathValue(o)) return null;
    const s = this.rewriteText(o.path, 'path', v);
    return s === null ? null : { path: s };
  }

  /** Walks a property list; in apply mode it changes it and returns whether anything changed. */
  private visitList(list: Property[], v: Visit): boolean {
    let changed = false;
    for (const p of list) {
      if (p.opaque) continue;
      const val = p.value;
      switch (p.type) {
        case 'ObjectProperty': {
          const n = this.rewritePath(val as ObjectValue, v);
          if (n && v.mode === 'apply') { p.value = n; changed = true; }
          break;
        }
        case 'StrProperty':
        case 'NameProperty':
          if (typeof val === 'string') {
            const n = this.rewriteText(val, 'string', v);
            if (n !== null && v.mode === 'apply') { p.value = n; changed = true; }
          }
          break;
        case 'StructProperty':
          if (Array.isArray(val)) changed = this.visitList(val as Property[], v) || changed;
          break;
        case 'ArrayProperty': {
          if (Buffer.isBuffer(val)) {
            const n = this.visitBlob(val, v);
            if (n) { p.value = n; changed = true; }
            break;
          }
          if (!Array.isArray(val)) break;
          const items = val as TreeValue[];
          if (p.inner === 'ObjectProperty') {
            let any = false;
            const out = items.map((e) => { const n = this.rewritePath(e as ObjectValue, v); if (n) any = true; return n ?? e; });
            if (any && v.mode === 'apply') { p.value = out; changed = true; }
          } else if (p.inner === 'StrProperty' || p.inner === 'NameProperty') {
            let any = false;
            const out = items.map((e) => {
              if (typeof e !== 'string') return e;
              const n = this.rewriteText(e, 'string', v);
              if (n !== null) any = true;
              return n ?? e;
            });
            if (any && v.mode === 'apply') { p.value = out; changed = true; }
          } else if (p.inner === 'StructProperty' && !p.elementStruct) {
            for (const e of items) changed = this.visitList(e as Property[], v) || changed;
          }
          break;
        }
      }
    }
    return changed;
  }

  /** Embedded archive or property list; returns the new bytes in apply mode when something changed. */
  private visitBlob(bytes: Buffer, v: Visit): Buffer | null {
    const d = decodeBlob(bytes);
    if (d === null) return null;
    if (v.mode === 'apply' && !encodeBlob(d).equals(bytes)) {
      // Never rewrite what does not encode back to the same bytes (not seen in ASE saves).
      this.embeddedNotRewritten++;
      return null;
    }
    const inner: Visit = { ...v, embedded: true };
    const changed = d.kind === 'archive' ? this.visitContainer(d.tree, inner) : this.visitList(d.list, inner);
    return changed && v.mode === 'apply' ? encodeBlob(d) : null;
  }

  /** Objects of an inline-named archive (embedded, profile, tribe, cluster file). */
  private visitContainer(c: TreeContainer, v: Visit): boolean {
    let changed = false;
    // Creatures in cryopods carry their own team.
    const root = archiveRoot(c.objects);
    const rootTeam = root ? teamOf(root.props) : null;
    const team = rootTeam && rootTeam.team !== null ? () => rootTeam : v.team;
    const at: Visit = { ...v, team };
    const comp = componentFlags(c.objects);
    const mappedRoots = new Map<string, ClassRow>();
    for (const [k, o] of c.objects.entries()) {
      const row = o.cls ? this.byClass.get(o.cls.toLowerCase()) : undefined;
      if (v.mode === 'scan' && o.cls) {
        this.noteHeader(o.cls, o.props);
        if (row && !o.isItem && !comp[k] && o.names[0]) mappedRoots.set(o.names[0], row);
      }
      if (row) {
        if (v.mode === 'scan' || this.allowed.has(row)) this.hit(row, 'header', at);
        if (v.mode === 'apply' && this.allowed.has(row)) { o.cls = row.newClass; changed = true; }
      }
      changed = this.visitList(o.props, at) || changed;
    }
    if (v.mode === 'scan') {
      for (const [k, o] of c.objects.entries()) {
        const row = comp[k] && o.names[1] ? mappedRoots.get(o.names[1]) : undefined;
        if (row && o.cls) inc(this.stats.get(row)!.components, o.cls);
      }
    }
    return changed;
  }

  private noteHeader(cls: string, props: Property[]): void {
    const k = cls.toLowerCase();
    const h = this.headerClasses.get(k);
    if (h) h.n++;
    else this.headerClasses.set(k, { cls, n: 1 });
    const row = this.byClass.get(k);
    if (row) {
      const s = this.stats.get(row)!;
      s.oldObjects++;
      for (const p of props) inc(s.oldProps, p.name);
    }
    const t = this.targetProps.get(k);
    if (t) {
      t.objects++;
      for (const p of props) t.names.add(p.name);
    }
  }

  // ------------------------------------------------------------ phases

  /** Phase 1 for a world save: counts every hit and collects the paths of all classes. */
  scanWorld(ed: SaveEditor, owners = new OwnerIndex(ed)): void {
    const actorRows = new Map<string, ClassRow>();
    for (let i = 0; i < ed.size; i++) {
      if (!ed.exists(i)) continue;
      const cls = ed.cls(i);
      const props = ed.props(i);
      let team: TeamInfo | undefined;
      const v: Visit = { mode: 'scan', scope: 'world', embedded: false, team: () => (team ??= owners.team(i)) };
      this.noteHeader(cls, props);
      const row = this.byClass.get(cls.toLowerCase());
      if (row) {
        this.hit(row, 'header', v);
        const h = ed.header(i);
        if (!h.isItem && h.names.length === 1) actorRows.set(h.names[0], row);
      }
      const before = this.hitCount;
      this.visitList(props, v);
      if (this.hitCount !== before) this.touched.add(i);
    }
    if (actorRows.size) {
      for (let i = 0; i < ed.size; i++) {
        if (!ed.exists(i)) continue;
        const h = ed.header(i);
        const row = h.names.length > 1 ? actorRows.get(h.names[1]) : undefined;
        if (row) inc(this.stats.get(row)!.components, h.cls);
      }
    }
  }

  /** Phase 1 for a profile, tribe or cluster file. */
  scanContainer(file: string, scope: Scope, c: TreeContainer, team: TeamInfo = { team: null, name: null }): void {
    this.visitContainer(c, { mode: 'scan', scope, embedded: false, team: () => team, file });
  }

  /** Settles which rows may rewrite object headers (short-name check). */
  decide(): void {
    for (const r of this.rows) {
      const chk = this.evidence.check(r.oldClass, r.onlyPackage ?? originOf(r.oldPath));
      if (chk.status === 'verified' || this.trust) this.allowed.add(r);
    }
    this.decided = true;
  }

  /** Phase 2 for a world save: changes the objects with hits. Returns the number of objects edited. */
  applyWorld(ed: SaveEditor): number {
    if (!this.decided) throw new Error('decide() first');
    const candidates = new Set(this.touched);
    for (let i = 0; i < ed.size; i++) {
      if (!ed.exists(i)) continue;
      const row = this.byClass.get(ed.cls(i).toLowerCase());
      if (row && this.allowed.has(row)) candidates.add(i);
    }
    let edited = 0;
    const v: Visit = { mode: 'apply', scope: 'world', embedded: false, team: () => ({ team: null, name: null }) };
    for (const i of [...candidates].sort((a, b) => a - b)) {
      const copy = ed.get(i);
      const row = this.byClass.get(copy.cls.toLowerCase());
      const header = row !== undefined && this.allowed.has(row);
      const changed = this.visitList(copy.props, v);
      if (!changed && !header) continue;
      // edit() decodes once more with the name encodings recorded; the changed tree replaces its own.
      const o = ed.edit(i);
      if (o !== copy) o.props = copy.props;
      if (header) { this.hit(row!, 'header', v); o.cls = row!.newClass; }
      edited++;
    }
    return edited;
  }

  /** Phase 2 for a profile, tribe or cluster file; true when it changed. */
  applyContainer(file: string, scope: Scope, c: TreeContainer): boolean {
    if (!this.decided) throw new Error('decide() first');
    return this.visitContainer(c, { mode: 'apply', scope, embedded: false, team: () => ({ team: null, name: null }), file });
  }

  // ------------------------------------------------------------ report

  report(): RemapReport {
    const mappedOld = new Set(this.rows.map((r) => r.oldClass.toLowerCase()));
    const rows: RowReport[] = this.rows.map((r) => {
      const s = this.stats.get(r)!;
      const chk = this.evidence.check(r.oldClass, r.onlyPackage ?? originOf(r.oldPath));
      const skipped = new Map<string, number>();
      for (const [k, n] of s.found) {
        const d = n - (s.rewritten.get(k) ?? 0);
        if (d > 0) skipped.set(k, d);
      }
      const target = this.targetProps.get(r.newClass.toLowerCase())!;
      let notOnTarget: Record<string, number> | null = null;
      if (target.objects > 0) {
        const m = new Map<string, number>();
        for (const [name, n] of s.oldProps) if (!target.names.has(name)) m.set(name, n);
        notOnTarget = top(m, 200);
      }
      const components: RowReport['components'] = {};
      for (const [cls, n] of [...s.components].sort((a, b) => b[1] - a[1])) components[cls] = { objects: n, mapped: mappedOld.has(cls.toLowerCase()) };
      return {
        line: r.line, oldClass: r.oldClass, newClass: r.newClass, oldPath: r.oldPath, newPath: r.newPath, onlyPackage: r.onlyPackage,
        shortName: { ...chk, own: chk.own.slice(0, 10), others: chk.others.slice(0, 10), headerRewrite: this.allowed.has(r) },
        found: Object.fromEntries(s.found), rewritten: Object.fromEntries(s.rewritten), skipped: Object.fromEntries(skipped),
        tribes: [...s.tribes.values()].sort((a, b) => b.hits - a.hits),
        files: top(s.files, 50), components,
        properties: {
          oldObjects: s.oldObjects, targetObjects: target.objects, notOnTarget,
          ...(notOnTarget === null ? { oldClassProperties: [...s.oldProps.keys()].sort() } : {}),
        },
      };
    });
    // What else of the old packages is still in the save.
    const remaining: RemapReport['remaining'] = {};
    const origins = new Set(this.rows.map((r) => r.onlyPackage ?? originOf(r.oldPath)).filter((o) => o.toLowerCase() !== '/game'));
    const done = new Set(this.rows.filter((r) => this.allowed.has(r)).map((r) => r.oldClass.toLowerCase()));
    for (const origin of origins) {
      // Objects by short name: "objects" belong to the package alone, "ambiguous" may be another package's.
      const objects = new Map<string, number>();
      const ambiguous = new Map<string, number>();
      for (const cls of new Set(this.evidence.classesIn(origin).map((c) => c.toLowerCase()))) {
        const h = this.headerClasses.get(cls);
        if (!h || done.has(cls)) continue;
        (this.evidence.check(h.cls, origin).status === 'ambiguous' ? ambiguous : objects).set(h.cls, h.n);
      }
      const references = new Map<string, number>();
      for (const [cls, n] of this.evidence.seenIn(origin)) if (!mappedOld.has(cls.toLowerCase())) references.set(cls, n);
      remaining[origin] = { objects: top(objects, 100), ambiguous: top(ambiguous, 50), references: top(references, 100) };
    }
    return { rows, remaining, assetList: this.evidence.hasAssetList, embeddedNotRewritten: this.embeddedNotRewritten };
  }
}
