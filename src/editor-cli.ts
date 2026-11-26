// `ark-export edit ...`: change .ark world saves (ASE, version 9). Always writes a new file; the
// input is never touched. Every written file is read back with the export reader before it counts.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ClassRemapper, OwnerIndex, parseMapping, type Scope, type TeamInfo } from './classes.ts';
import { diffSaves, extraByClass, indexSave, lostKeys } from './diff.ts';
import { SaveEditor } from './editor.ts';
import { clearInventories, deleteObjects, moveObjects, type Owner, type Placement, refreshDecay } from './operations.ts';
import { checkPlacement, copyObjects, exportPattern, parsePattern, placePattern } from './pattern.ts';
import { aggregateRefunds, refundCsv, refundJson, removeClasses } from './removal.ts';
import { readSave } from './savegame.ts';
import { findProperty, type Property, readContainerTree, type TreeContainer, writeContainerTree } from './tree.ts';
import { ReadContext } from './types.ts';
import { checkConsistency, verifySave } from './verify.ts';
import { bounds, type Entry, indexWorld, type Kind, select, type Selection } from './world.ts';

export const EDIT_USAGE = `Editing world saves (.ark, ASE save version 9) – writes a new file, never the input:
  ark-export edit verify <Map.ark>...              prove a byte-identical write (reads only)
  ark-export edit check <Map.ark>...               consistency: references, unique ids, components (reads only)
  ark-export edit list <Map.ark> SELECTION [--full] selected actors: counts by class and owner, bounds
  ark-export edit delete <Map.ark> SELECTION --out FILE
                                                   remove actors with components and items
  ark-export edit decay <Map.ark> SELECTION --out FILE [--days N]
                                                   restart the decay timer (LastInAllyRangeTime = now + N days)
  ark-export edit clear-inventory <Map.ark> SELECTION --out FILE [--engrams] [--equipped]
                                                   remove inventory items (engrams stay unless --engrams)
  ark-export edit move <Map.ark> SELECTION (--by DX,DY,DZ | --to X,Y,Z) [--rotate DEG] [--pivot X,Y,Z]
                       [--with-dinos] [--with-players] --out FILE
                                                   move and turn a base around the pivot
  ark-export edit copy <Map.ark> SELECTION (--by DX,DY,DZ | --to X,Y,Z) [--rotate DEG] [--pivot X,Y,Z]
                       [--items] [OWNER] [--force] --out FILE
  ark-export edit pattern-save <Map.ark> SELECTION --pattern FILE [--anchor X,Y,Z[,YAW]] [--items] [--name N]
                                                   cut a building pattern out of a save (reads only)
  ark-export edit pattern-show FILE                summary of a pattern
  ark-export edit pattern-place <Map.ark> --pattern FILE --at X,Y,Z[,YAW] OWNER [--check] [--force]
                       [--limit N] [--limit-radius R] [--margin M] --out FILE
                                                   place a pattern; --check only reports
  ark-export edit remap-classes <Map.ark> --mapping FILE [--assets FILE] [--no-profiles] [--cluster DIR]
                       [--trust-short-names] [--report FILE] (--dry-run | --out FILE [--out-dir DIR])
                                                   rewrite classes to replacements in every layer:
                                                   object table, paths, strings, cryopods, profiles, tribes
  ark-export edit remove-classes <Map.ark> (--class C | --package P)... [--assets FILE] [--trust-short-names]
                       [--refund FILE.csv|.json] [--grid UNITS] [--report FILE] (--dry-run | --out FILE)
                                                   remove classes everywhere (also foreign inventories,
                                                   cryopods, soul traps) with a refund list per tribe
  ark-export edit diff-classes <before.ark> <after.ark> [--baseline FILE --baseline-after FILE]
                       [--refund FILE.csv|.json] [--grid UNITS] [--report FILE] [--full]
                                                   what the game dropped on load, per class (reads only):
                                                   before = save put in place, after = what the game wrote;
                                                   the baseline pair (unedited save, its re-save) takes out
                                                   what the game drops by itself; extra loss as refund list
  ark-export edit asset-list <Content/Mods>...     asset paths of installed mods, input for --assets

SELECTION (at least one of tribe, owner, box, radius, class):
  --tribe ID             TargetingTeam (tribe id, or player id of solo players)
  --owner NAME           OwnerName / TribeName, exact (case-insensitive)
  --box X1,Y1,Z1,X2,Y2,Z2   axis-aligned box in world units (100 units = 1 m)
  --radius X,Y,R | X,Y,Z,R  vertical cylinder or sphere
  --class C              class name, * as wildcard; repeatable
  --kind K,K             structure (default), dino, pawn, actor
OWNER (copy, pattern-place): --team ID [--tribe-name S] [--player-id N] [--player-name S]
Coordinates are Unreal units as shown by the in-game command "ccc" (x y z pitch yaw roll).
MAPPING (remap-classes): tab-separated old_class, new_class, old_path, new_path [, only_mod_package],
or a JSON array of objects with these keys.
Reports are JSON on stdout; with ARK_EXPORT_ERRORS=json errors are {"error": "..."} on stderr.
Short class names in object headers change only when the save (or --assets) proves the name belongs
to the old package alone; --trust-short-names overrides that. Full paths always need a full match.`;

const print = (v: unknown): void => {
  process.stdout.write(`${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)}\n`);
};

function numbers(s: string | undefined, what: string, counts: number[]): number[] | undefined {
  if (s === undefined) return undefined;
  const v = s.split(',').map((x) => Number(x.trim()));
  if (!counts.includes(v.length) || v.some((x) => !Number.isFinite(x))) throw new Error(`${what}: expected ${counts.join(' or ')} numbers, got "${s}"`);
  return v;
}

function number(s: string | undefined, what: string): number | undefined {
  if (s === undefined) return undefined;
  const v = Number(s);
  if (!Number.isFinite(v)) throw new Error(`${what}: not a number: ${s}`);
  return v;
}

const SELECTION_OPTIONS = {
  tribe: { type: 'string' }, owner: { type: 'string' }, box: { type: 'string' }, radius: { type: 'string' },
  class: { type: 'string', multiple: true }, kind: { type: 'string' },
} as const;

const OWNER_OPTIONS = {
  team: { type: 'string' }, 'tribe-name': { type: 'string' }, 'player-id': { type: 'string' }, 'player-name': { type: 'string' },
} as const;

type Values = Record<string, string | boolean | string[] | undefined>;

function selection(v: Values): Selection {
  const sel: Selection = {};
  if (v.tribe !== undefined) sel.tribe = number(v.tribe as string, '--tribe');
  if (v.owner !== undefined) sel.owner = v.owner as string;
  const box = numbers(v.box as string | undefined, '--box', [6]);
  if (box) {
    sel.box = {
      min: { x: Math.min(box[0], box[3]), y: Math.min(box[1], box[4]), z: Math.min(box[2], box[5]) },
      max: { x: Math.max(box[0], box[3]), y: Math.max(box[1], box[4]), z: Math.max(box[2], box[5]) },
    };
  }
  const r = numbers(v.radius as string | undefined, '--radius', [3, 4]);
  if (r) sel.radius = r.length === 3 ? { x: r[0], y: r[1], r: r[2] } : { x: r[0], y: r[1], z: r[2], r: r[3] };
  if (v.class) sel.classes = v.class as string[];
  if (v.kind) sel.kinds = (v.kind as string).split(',').map((k) => k.trim() as Kind);
  if (sel.tribe === undefined && sel.owner === undefined && !sel.box && !sel.radius && !sel.classes) {
    throw new Error('no selection: give at least one of --tribe, --owner, --box, --radius, --class');
  }
  return sel;
}

function owner(v: Values): Owner {
  const team = number(v.team as string | undefined, '--team');
  if (team === undefined) throw new Error('--team ID is required (tribe id of the new owner)');
  return {
    team, name: v['tribe-name'] as string | undefined, playerId: number(v['player-id'] as string | undefined, '--player-id'),
    playerName: v['player-name'] as string | undefined,
  };
}

function load(file: string): { buf: Buffer; ed: SaveEditor; world: Entry[] } {
  const buf = readFileSync(file);
  const ed = SaveEditor.open(buf);
  if (!ed.hibernationEmpty) process.stderr.write('warning: the save has hibernation entries; creatures stored there are not seen by the editor\n');
  return { buf, ed, world: indexWorld(ed) };
}

function summary(entries: Entry[]): Record<string, unknown> {
  const byClass: Record<string, number> = {};
  const byOwner: Record<string, number> = {};
  for (const e of entries) {
    byClass[e.cls] = (byClass[e.cls] ?? 0) + 1;
    const k = `${e.team ?? '-'} ${e.ownerName ?? ''}`.trim();
    byOwner[k] = (byOwner[k] ?? 0) + 1;
  }
  const b = bounds(entries.filter((e) => e.location).map((e) => e.location!));
  // The game writes some actors twice under one name; they are one actor in game.
  const unique = new Set(entries.map((e) => `${e.cls}|${e.name}`)).size;
  return { count: entries.length, uniqueNames: unique, bounds: b, byOwner, byClass };
}

/** Writes next to the target, flushes, then renames. Refuses to overwrite the input or (without force) any file. */
function writeOut(input: string, out: string | undefined, data: Buffer[], force: boolean): string {
  if (!out) throw new Error('--out FILE is required');
  const target = resolve(out);
  if (target === resolve(input)) throw new Error('--out must not be the input file: the editor never changes a save in place');
  if (existsSync(target) && !force) throw new Error(`${target} exists (--force overwrites it)`);
  const tmp = `${target}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o644);
  try {
    for (const c of data) {
      let off = 0;
      while (off < c.length) off += writeSync(fd, c, off, c.length - off);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
  return target;
}

/** Undecoded bytes per section name, as the export reader reports them. */
function undecoded(buf: Buffer): { objects: number; raw: Map<string, number>; failed: boolean; issues: Record<string, number> } {
  const ctx = new ReadContext();
  const s = readSave(buf, ctx);
  const raw = new Map<string, number>();
  for (const x of s.sections) if (!x.decoded) raw.set(x.name, (raw.get(x.name) ?? 0) + x.bytes);
  return { objects: s.objects.length, raw, failed: s.objects.some((o) => o.error), issues: Object.fromEntries(ctx.issues) };
}

/**
 * Reads the written file with the export reader. Every byte must be accounted for as well as in the
 * input: undecoded parts may not grow beyond what the input had plus the extra data of new objects.
 */
function readBack(input: Buffer, file: string, expectedObjects: number, addedExtra: number): Record<string, unknown> {
  const before = undecoded(input);
  const after = undecoded(readFileSync(file));
  const problems: string[] = [];
  if (after.objects !== expectedObjects) problems.push(`expected ${expectedObjects} objects, read ${after.objects}`);
  if (after.failed) problems.push('unreadable property lists');
  for (const [name, bytes] of after.raw) {
    const allowed = (before.raw.get(name) ?? 0) + (name.startsWith('data after property lists') ? addedExtra : 0);
    if (bytes > allowed) problems.push(`${name}: ${bytes} bytes undecoded, input had ${before.raw.get(name) ?? 0}`);
  }
  if (problems.length) throw new Error(`written file does not read back cleanly: ${problems.join('; ')}`);
  return { objects: after.objects, undecoded: Object.fromEntries(after.raw), issues: after.issues };
}

function finish(input: string, ed: SaveEditor, v: Values, report: Record<string, unknown>): number {
  const chunks = ed.writeChunks();
  let live = 0;
  let addedExtra = 0;
  for (let i = 0; i < ed.size; i++) {
    if (!ed.exists(i)) continue;
    live++;
    if (i >= ed.count) addedExtra += ed.get(i).extra.length;
  }
  const file = writeOut(input, v.out as string | undefined, chunks, v.force === true);
  const check = readBack(ed.buf, file, live, addedExtra);
  const consistency = { before: checkConsistency(SaveEditor.open(ed.buf)), after: checkConsistency(SaveEditor.open(readFileSync(file))) };
  const out = { ...report, consistency, out: file, bytes: chunks.reduce((n, c) => n + c.length, 0), objects: live, readBack: check, addedNames: ed.table.added.length };
  writeReport(v, input, out);
  print(out);
  return 0;
}

function placementFrom(v: Values, chosen: Entry[]): Placement {
  const b = bounds(chosen.filter((e) => e.location).map((e) => e.location!));
  if (!b) throw new Error('selection has no positions');
  const center = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: b.min.z };
  const p = numbers(v.pivot as string | undefined, '--pivot', [3]);
  const pivot = p ? { x: p[0], y: p[1], z: p[2] } : center;
  const by = numbers(v.by as string | undefined, '--by', [3]);
  const to = numbers(v.to as string | undefined, '--to', [3]);
  if (!by === !to) throw new Error('give either --by DX,DY,DZ or --to X,Y,Z');
  const d = by ?? [to![0] - pivot.x, to![1] - pivot.y, to![2] - pivot.z];
  return { dx: d[0], dy: d[1], dz: d[2], yaw: number(v.rotate as string | undefined, '--rotate') ?? 0, pivot };
}

/** Tamed dinos / player characters of the selected teams inside the selection's bounding box (+ margin). */
function companions(world: Entry[], chosen: Entry[], kind: Kind): Entry[] {
  const teams = new Set(chosen.map((e) => e.team));
  const b = bounds(chosen.filter((e) => e.location).map((e) => e.location!));
  if (!b) return [];
  const m = 500;
  return world.filter((e) => e.kind === kind && teams.has(e.team) && e.location
    && e.location.x >= b.min.x - m && e.location.x <= b.max.x + m && e.location.y >= b.min.y - m && e.location.y <= b.max.y + m
    && e.location.z >= b.min.z - m && e.location.z <= b.max.z + 2 * m);
}

// ---------------------------------------------------------------- classes

/** Tribe of a profile (MyData.TribeId, else the player) or a tribe file (TribeData.TribeId). */
function containerTeam(c: TreeContainer): TeamInfo {
  for (const o of c.objects) {
    const md = findProperty(o.props, 'MyData') ?? findProperty(o.props, 'TribeData');
    if (!md || !Array.isArray(md.value)) continue;
    const l = md.value as Property[];
    const num = (n: string): number | null => { const v = findProperty(l, n)?.value; return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null; };
    const text = (n: string): string | null => { const v = findProperty(l, n)?.value; return typeof v === 'string' ? v : null; };
    const tribe = num('TribeId');
    return { team: tribe || num('PlayerDataID'), name: text('TribeName') ?? text('PlayerName') };
  }
  return { team: null, name: null };
}

interface ContainerFile { name: string; scope: Scope; path: string; out: string; buf: Buffer; tree: TreeContainer; }

/** .arkprofile and .arktribe files next to the save; every file in a cluster directory. */
function readContainers(dir: string, scope: 'profiles' | 'cluster', outDir: string | null): { files: ContainerFile[]; skipped: string[] } {
  const files: ContainerFile[] = [];
  const skipped: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    let sc: Scope;
    if (scope === 'cluster') sc = 'cluster';
    else if (name.endsWith('.arkprofile')) sc = 'profile';
    else if (name.endsWith('.arktribe')) sc = 'tribe';
    else continue;
    if (!statSync(path).isFile()) continue;
    const buf = readFileSync(path);
    if (buf.length === 0) continue; // players without uploads
    try {
      const tree = readContainerTree(buf);
      // Only files that encode back to the same bytes are ever rewritten.
      if (!writeContainerTree(tree).equals(buf)) { skipped.push(`${name}: does not encode back identically`); continue; }
      const out = outDir ? (scope === 'cluster' ? join(outDir, 'cluster', name) : join(outDir, name)) : '';
      files.push({ name, scope: sc, path, out, buf, tree });
    } catch (e) {
      skipped.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { files, skipped };
}

/** Asset paths of installed mods: <id>.mod names the package root, <id>/ holds the cooked assets. */
export function assetListOf(modsDir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(modsDir).sort()) {
    const m = /^(\d+)\.mod$/.exec(f);
    if (!m) continue;
    const meta = readFileSync(join(modsDir, f)).toString('latin1');
    const root = /\/Game\/Mods\/([^/\x00-\x1f]+)\//.exec(meta)?.[1] ?? m[1];
    const base = join(modsDir, m[1]);
    if (!existsSync(base)) continue;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(uasset|umap)$/i.test(e.name)) out.push(`/Game/Mods/${root}/${relative(base, p).replace(/\\/g, '/').replace(/\.(uasset|umap)$/i, '')}`);
      }
    };
    walk(base);
  }
  return out;
}

function writeReport(v: Values, input: string, report: Record<string, unknown>): void {
  if (!v.report) return;
  writeOut(input, v.report as string, [Buffer.from(`${JSON.stringify(report, null, 2)}\n`)], v.force === true);
}

export async function editCommand(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  const opts = {
    ...SELECTION_OPTIONS, ...OWNER_OPTIONS,
    out: { type: 'string' }, force: { type: 'boolean', default: false }, full: { type: 'boolean', default: false },
    days: { type: 'string' }, engrams: { type: 'boolean', default: false }, equipped: { type: 'boolean', default: false },
    by: { type: 'string' }, to: { type: 'string' }, rotate: { type: 'string' }, pivot: { type: 'string' },
    'with-dinos': { type: 'boolean', default: false }, 'with-players': { type: 'boolean', default: false },
    items: { type: 'boolean', default: false }, pattern: { type: 'string' }, anchor: { type: 'string' }, name: { type: 'string' },
    at: { type: 'string' }, check: { type: 'boolean', default: false }, limit: { type: 'string' }, 'limit-radius': { type: 'string' },
    margin: { type: 'string' }, 'no-reencode': { type: 'boolean', default: false },
    mapping: { type: 'string' }, assets: { type: 'string' }, 'no-profiles': { type: 'boolean', default: false },
    cluster: { type: 'string' }, 'trust-short-names': { type: 'boolean', default: false }, report: { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, 'out-dir': { type: 'string' }, package: { type: 'string', multiple: true },
    refund: { type: 'string' }, grid: { type: 'string' }, baseline: { type: 'string' }, 'baseline-after': { type: 'string' },
  } as const;
  const { values: v, positionals } = parseArgs({ args, options: opts, allowPositionals: true });
  const values = v as Values;
  const input = positionals[0];
  switch (sub) {
    case 'verify': {
      if (!positionals.length) throw new Error('verify needs at least one .ark file');
      let failed = 0;
      for (const f of positionals) {
        const r = verifySave(readFileSync(f), { reencodeAll: !values['no-reencode'] });
        const ok = r.identical.copy && r.identical.patchAll && (values['no-reencode'] || r.identical.reencodeAll)
          && r.objectMismatches === 0 && r.refMismatches === 0
          && r.embedded.archives === r.embedded.archivesIdentical && r.embedded.propertyLists === r.embedded.propertyListsIdentical;
        if (!ok) failed++;
        print({ file: basename(f), ok, ...r });
      }
      return failed ? 1 : 0;
    }
    case 'check': {
      for (const f of positionals) print({ file: basename(f), ...checkConsistency(SaveEditor.open(readFileSync(f))) });
      return 0;
    }
    case 'list': {
      const { world } = load(input);
      const chosen = select(world, selection(values));
      print(values.full ? { ...summary(chosen), entries: chosen } : summary(chosen));
      return 0;
    }
    case 'delete': {
      const { ed, world } = load(input);
      const chosen = select(world, selection(values));
      const r = deleteObjects(ed, chosen.map((e) => e.index));
      return finish(input, ed, values, {
        operation: 'delete', selected: chosen.length, removed: r.removed, cleaned: r.cleaned,
        mayCollapseCount: r.mayCollapse.length, mayCollapse: r.mayCollapse.slice(0, 50),
      });
    }
    case 'decay': {
      const { ed, world } = load(input);
      const sel = selection(values);
      const chosen = select(world, { ...sel, kinds: ['structure'] });
      const days = number(values.days as string | undefined, '--days') ?? 0;
      const r = refreshDecay(ed, chosen.map((e) => e.index), { extraSeconds: days * 86_400 });
      return finish(input, ed, values, { operation: 'decay', selected: chosen.length, days, ...r });
    }
    case 'clear-inventory': {
      const { ed, world } = load(input);
      const chosen = select(world, selection(values));
      const r = clearInventories(ed, chosen.map((e) => e.index), { keepEngrams: !values.engrams, equipped: values.equipped === true });
      return finish(input, ed, values, { operation: 'clear-inventory', selected: chosen.length, ...r });
    }
    case 'move': {
      const { ed, world } = load(input);
      const chosen = select(world, selection(values));
      const t = placementFrom(values, chosen);
      const extra = [
        ...(values['with-dinos'] ? companions(world, chosen, 'dino') : []),
        ...(values['with-players'] ? companions(world, chosen, 'pawn') : []),
      ].filter((e) => !chosen.includes(e));
      const r = moveObjects(ed, [...chosen, ...extra].map((e) => e.index), t);
      return finish(input, ed, values, { operation: 'move', selected: chosen.length, companions: extra.length, placement: t, ...r });
    }
    case 'copy': {
      const { ed, world } = load(input);
      const chosen = select(world, selection(values));
      const t = placementFrom(values, chosen);
      const r = copyObjects(ed, chosen.map((e) => e.index), {
        by: t, owner: owner(values), items: values.items === true, force: values.force === true,
        margin: number(values.margin as string | undefined, '--margin'),
      });
      return finish(input, ed, values, { operation: 'copy', selected: chosen.length, placement: t, added: r.indices.length, warnings: r.warnings, blocking: r.blocking, overlapping: r.overlapping.length });
    }
    case 'pattern-save': {
      if (!values.pattern) throw new Error('--pattern FILE is required');
      const { ed, world } = load(input);
      const chosen = select(world, selection(values));
      const a = numbers(values.anchor as string | undefined, '--anchor', [3, 4]);
      const map = basename(input).replace(/\.ark$/, '');
      const p = exportPattern(ed, chosen.map((e) => e.index), {
        name: (values.name as string | undefined) ?? map, items: values.items === true, map,
        anchor: a ? { x: a[0], y: a[1], z: a[2], yaw: a[3] ?? 0 } : undefined,
      });
      const text = `${JSON.stringify(p)}\n`;
      const target = writeOut(input, values.pattern as string, [Buffer.from(text)], values.force === true);
      const { objects: _o, ...meta } = p;
      print({ operation: 'pattern-save', pattern: target, bytes: text.length, selected: chosen.length, objects: p.objects.length, ...meta });
      return 0;
    }
    case 'pattern-show': {
      const p = parsePattern(readFileSync(input, 'utf8'));
      const { objects, ...meta } = p;
      print({ ...meta, objects: objects.length });
      return 0;
    }
    case 'pattern-place': {
      if (!values.pattern) throw new Error('--pattern FILE is required');
      const at = numbers(values.at as string | undefined, '--at', [3, 4]);
      if (!at) throw new Error('--at X,Y,Z[,YAW] is required');
      const p = parsePattern(readFileSync(values.pattern as string, 'utf8'));
      const { ed, world } = load(input);
      const placeOpts = {
        at: { x: at[0], y: at[1], z: at[2], yaw: at[3] ?? 0 }, owner: owner(values), force: values.force === true,
        limit: number(values.limit as string | undefined, '--limit'), limitRadius: number(values['limit-radius'] as string | undefined, '--limit-radius'),
        margin: number(values.margin as string | undefined, '--margin'),
      };
      if (values.check) {
        const c = checkPlacement(ed, p, placeOpts, world);
        print({ operation: 'pattern-check', pattern: p.name, ...c, overlapping: c.overlapping.slice(0, 50), overlappingCount: c.overlapping.length });
        return c.blocking.length ? 2 : 0;
      }
      const r = placePattern(ed, p, placeOpts);
      return finish(input, ed, values, {
        operation: 'pattern-place', pattern: p.name, at: placeOpts.at, added: r.indices.length, warnings: r.warnings,
        blocking: r.blocking, overlapping: r.overlapping.length, nearbyZ: r.nearbyZ, structuresInRange: r.structuresInRange,
      });
    }
    case 'remap-classes': {
      if (!values.mapping) throw new Error('--mapping FILE is required');
      const dry = values['dry-run'] === true;
      if (!dry && !values.out) throw new Error('--out FILE is required (or --dry-run)');
      const rows = parseMapping(readFileSync(values.mapping as string, 'utf8'));
      const outDir = values['out-dir'] ? resolve(values['out-dir'] as string) : null;
      const profiles = values['no-profiles'] ? { files: [], skipped: [] } : readContainers(dirname(resolve(input)), 'profiles', outDir);
      const cluster = values.cluster ? readContainers(values.cluster as string, 'cluster', outDir) : { files: [], skipped: [] };
      const containers = [...profiles.files, ...cluster.files];
      if (outDir) {
        for (const d of [dirname(resolve(input)), values.cluster ? resolve(values.cluster as string) : null]) {
          if (d && (outDir === d || join(outDir, 'cluster') === d)) throw new Error('--out-dir must not be a directory the files are read from');
        }
      }
      const buf = readFileSync(input);
      const ed = SaveEditor.open(buf);
      if (!ed.hibernationEmpty) process.stderr.write('warning: the save has hibernation entries; creatures stored there are not seen by the editor\n');
      const remapper = new ClassRemapper(rows, {
        assetList: values.assets ? readFileSync(values.assets as string, 'utf8') : undefined, trustShortNames: values['trust-short-names'] === true,
      });
      remapper.scanWorld(ed, new OwnerIndex(ed));
      for (const c of containers) remapper.scanContainer(c.name, c.scope, c.tree, containerTeam(c.tree));
      remapper.decide();
      const edited = remapper.applyWorld(ed);
      const changedFiles = containers.filter((c) => remapper.applyContainer(c.name, c.scope, c.tree));
      if (!dry && changedFiles.length && !outDir) throw new Error(`${changedFiles.length} profile, tribe or cluster files change: --out-dir DIR is required (or --no-profiles)`);
      const r = remapper.report();
      const report: Record<string, unknown> = {
        operation: 'remap-classes', dryRun: dry, map: basename(input), objectsEdited: edited, addedNames: ed.table.added.length,
        filesChanged: changedFiles.map((c) => (c.scope === 'cluster' ? `cluster/${c.name}` : c.name)), filesSkipped: [...profiles.skipped, ...cluster.skipped],
        ...r,
      };
      if (!r.assetList) (report as { warnings?: string[] }).warnings = ['no --assets: short names were checked only against paths found in the scanned files'];
      if (dry) {
        writeReport(values, input, report);
        print(report);
        return 0;
      }
      const written: string[] = [];
      for (const c of changedFiles) {
        const data = writeContainerTree(c.tree);
        mkdirSync(dirname(c.out), { recursive: true });
        written.push(writeOut(c.path, c.out, [data], values.force === true));
        readContainerTree(readFileSync(c.out)); // reads back
      }
      report.filesWritten = written;
      return finish(input, ed, values, report);
    }
    case 'remove-classes': {
      const dry = values['dry-run'] === true;
      if (!dry && !values.out) throw new Error('--out FILE is required (or --dry-run)');
      const packages = (values.package as string[] | undefined) ?? [];
      if (packages.length && !values.assets) process.stderr.write('warning: --package without --assets finds only classes whose paths occur in the save\n');
      const buf = readFileSync(input);
      const ed = SaveEditor.open(buf);
      if (!ed.hibernationEmpty) process.stderr.write('warning: the save has hibernation entries; creatures stored there are not seen by the editor\n');
      const { report: r, refunds } = removeClasses(ed, {
        classes: values.class as string[] | undefined, packages,
        assetList: values.assets ? readFileSync(values.assets as string, 'utf8') : undefined, trustShortNames: values['trust-short-names'] === true,
      });
      const map = basename(input).replace(/\.ark$/i, '');
      const grid = number(values.grid as string | undefined, '--grid') ?? 10_000;
      if (grid <= 0) throw new Error('--grid must be positive');
      const rows = aggregateRefunds(refunds, grid);
      const tribes = new Set(rows.map((x) => x.team));
      const report: Record<string, unknown> = { operation: 'remove-classes', dryRun: dry, map: basename(input), ...r, refund: { rows: rows.length, tribes: tribes.size, entries: refunds.length } };
      if (values.refund) {
        const file = values.refund as string;
        const text = /\.json$/i.test(file) ? `${JSON.stringify(refundJson(map, rows), null, 1)}\n` : refundCsv(map, rows);
        report.refundFile = writeOut(input, file, [Buffer.from(text)], values.force === true);
      }
      if (dry) { writeReport(values, input, report); print(report); return 0; }
      return finish(input, ed, values, report);
    }
    case 'diff-classes': {
      if (positionals.length !== 2) throw new Error('diff-classes needs two saves: <before.ark> <after.ark>');
      const [beforeFile, afterFile] = positionals;
      const base = values.baseline as string | undefined;
      const baseAfter = values['baseline-after'] as string | undefined;
      if ((base === undefined) !== (baseAfter === undefined)) throw new Error('--baseline and --baseline-after go together');
      const grid = number(values.grid as string | undefined, '--grid') ?? 10_000;
      if (grid <= 0) throw new Error('--grid must be positive');
      // One save at a time in memory: the baseline pair shrinks to the keys it lost.
      const baselineLost = base && baseAfter
        ? lostKeys(indexSave(SaveEditor.open(readFileSync(base))), indexSave(SaveEditor.open(readFileSync(baseAfter))))
        : undefined;
      const after = indexSave(SaveEditor.open(readFileSync(afterFile)));
      const ed = SaveEditor.open(readFileSync(beforeFile));
      if (!ed.hibernationEmpty) process.stderr.write('warning: the save has hibernation entries; creatures stored there are not compared\n');
      const { report: r, refunds } = diffSaves(ed, after, baselineLost);
      const map = basename(beforeFile).replace(/\.ark$/i, '');
      const rows = aggregateRefunds(refunds, grid);
      const report: Record<string, unknown> = {
        operation: 'diff-classes', before: basename(beforeFile), after: basename(afterFile),
        ...(base && baseAfter ? { baselineFiles: [basename(base), basename(baseAfter)] } : {}),
        ...r, extraByClass: extraByClass(refunds),
        refund: { rows: rows.length, tribes: new Set(rows.map((x) => x.team)).size, entries: refunds.length },
      };
      if (!baselineLost) report.warnings = ['no baseline: what the game drops by itself (spoiling, decay, wild creatures) counts as extra loss'];
      if (values.refund) {
        const file = values.refund as string;
        const text = /\.json$/i.test(file) ? `${JSON.stringify(refundJson(map, rows), null, 1)}\n` : refundCsv(map, rows);
        report.refundFile = writeOut(beforeFile, file, [Buffer.from(text)], values.force === true);
      }
      writeReport(values, beforeFile, report);
      const shown = values.full ? r.classes : r.classes.slice(0, 50);
      print({ ...report, classes: shown, ...(shown.length < r.classes.length ? { classesShown: `${shown.length} of ${r.classes.length} (--full or --report for all)` } : {}) });
      return 0;
    }
    case 'asset-list': {
      if (!positionals.length) throw new Error('asset-list needs at least one Content/Mods directory');
      for (const d of positionals) for (const line of assetListOf(d)) process.stdout.write(`${line}\n`);
      return 0;
    }
  }
  process.stderr.write(`${EDIT_USAGE}\n`);
  return 2;
}
