// `ark-export edit ...`: change .ark world saves (ASE, version 9). Always writes a new file; the
// input is never touched. Every written file is read back with the export reader before it counts.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { SaveEditor } from './editor.ts';
import { clearInventories, deleteObjects, moveObjects, type Owner, type Placement, refreshDecay } from './operations.ts';
import { checkPlacement, copyObjects, exportPattern, parsePattern, placePattern } from './pattern.ts';
import { readSave } from './savegame.ts';
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

SELECTION (at least one of tribe, owner, box, radius, class):
  --tribe ID             TargetingTeam (tribe id, or player id of solo players)
  --owner NAME           OwnerName / TribeName, exact (case-insensitive)
  --box X1,Y1,Z1,X2,Y2,Z2   axis-aligned box in world units (100 units = 1 m)
  --radius X,Y,R | X,Y,Z,R  vertical cylinder or sphere
  --class C              class name, * as wildcard; repeatable
  --kind K,K             structure (default), dino, pawn, actor
OWNER (copy, pattern-place): --team ID [--tribe-name S] [--player-id N] [--player-name S]
Coordinates are Unreal units as shown by the in-game command "ccc" (x y z pitch yaw roll).`;

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
  return { count: entries.length, bounds: b, byOwner, byClass };
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
  print({ ...report, consistency, out: file, bytes: chunks.reduce((n, c) => n + c.length, 0), objects: live, readBack: check, addedNames: ed.table.added.length });
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
      return finish(input, ed, values, { operation: 'delete', selected: chosen.length, ...r });
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
  }
  process.stderr.write(`${EDIT_USAGE}\n`);
  return 2;
}
