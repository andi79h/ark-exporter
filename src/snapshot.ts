// Full snapshot of one save as a SQLite file: one row per object (world, cryopod contents,
// profiles, tribes) with stable key, category, position and all properties as JSON.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { readContainer, readTributeTribe } from './container.ts';
import { emitArchive, emitWorld, type EmitStats, hashOf, KeyRegistry, type Row, VOLATILE_FIELDS } from './normalize.ts';
import { readSave } from './savegame.ts';
import { openDatabase, runtime } from './sqlite.ts';
import { type GameObject, ReadContext, type Value } from './types.ts';

export const EXPORTER_VERSION = '0.1.0';

export const SNAPSHOT_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE objects (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  class TEXT NOT NULL,
  name TEXT,
  tribe_name TEXT,
  names TEXT NOT NULL,
  container TEXT,
  owner TEXT,
  team INTEGER,
  x REAL, y REAL, z REAL, pitch REAL, yaw REAL, roll REAL,
  data_file INTEGER,
  guid TEXT,
  hash TEXT NOT NULL,
  props TEXT NOT NULL,
  extra TEXT
);`;

const SNAPSHOT_INDEXES = `
CREATE UNIQUE INDEX objects_key ON objects(key);
CREATE INDEX objects_class ON objects(class);
CREATE INDEX objects_category_team ON objects(category, team);
CREATE INDEX objects_owner ON objects(owner);
CREATE INDEX objects_container ON objects(container);
CREATE INDEX objects_name ON objects(name COLLATE NOCASE);
CREATE INDEX objects_tribe_name ON objects(tribe_name COLLATE NOCASE);`;

/** File-name friendly UTC time stamp. */
export function stamp(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

/**
 * Folder name for a save: the server installation folder above ShooterGame
 * (…/<instance>/ShooterGame/Saved/SavedArks/<Map>.ark), else the map name.
 */
export function defaultName(savePath: string): string {
  const m = /([^/\\]+)[/\\]ShooterGame[/\\]Saved[/\\]/.exec(savePath);
  return m ? m[1] : basename(savePath).replace(/\.ark$/i, '');
}

export interface SnapshotResult {
  path: string;
  savedAt: string;
  skipped: boolean;
  rows: number;
  seconds: Record<string, number>;
}

function struct(v: Value | undefined): { [key: string]: Value } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
    ? v as { [key: string]: Value } : {};
}

function emitContainers(dir: string, registry: KeyRegistry, emit: (row: Row) => void, stats: EmitStats, ctx: ReadContext): Record<string, number> {
  const counts = { profiles: 0, tribes: 0, tributes: 0, unreadable: 0 };
  for (const file of readdirSync(dir).sort()) {
    const ext = file.slice(file.lastIndexOf('.') + 1);
    if (ext !== 'arkprofile' && ext !== 'arktribe' && ext !== 'arktributetribe') continue;
    const stem = file.slice(0, file.lastIndexOf('.'));
    try {
      const buf = readFileSync(join(dir, file));
      if (ext === 'arktributetribe') {
        const json = JSON.stringify(readTributeTribe(buf));
        emit({
          key: registry.claim(`tribute:${stem}`), source: 'tribute', category: 'tribute', cls: 'TributeTribe',
          name: null, tribeName: null, names: JSON.stringify([file]), container: null, owner: `tribe:${stem}`, team: Number(stem) || null,
          x: null, y: null, z: null, pitch: null, yaw: null, roll: null, dataFile: null, guid: null,
          hash: hashOf(json), props: json, extra: null,
        });
        stats.rows++;
        counts.tributes++;
        continue;
      }
      const c = readContainer(buf, ctx);
      const isProfile = ext === 'arkprofile';
      const main = c.objects.findIndex((o: GameObject) => isProfile ? o.cls.startsWith('PrimalPlayerData') : o.cls.startsWith('PrimalTribeData'));
      const data = main >= 0 ? struct(c.objects[main].props[isProfile ? 'MyData' : 'TribeData']) : {};
      const id = isProfile ? data.PlayerDataID : data.TribeId;
      const base = `${isProfile ? 'player' : 'tribe'}:${id ?? `file-${stem}`}`;
      const team = typeof data.TribeId === 'number' ? data.TribeId : null;
      const keys = c.objects.map((o, i) => registry.claim(i === main ? base : `${base}/${o.names[0] ?? i}`));
      emitArchive(c.objects, keys, isProfile ? 'profile' : 'tribe', null, registry, emit, stats, {
        overrides: (_o, i) => i === main
          ? { category: isProfile ? 'player' : 'tribe', owner: null, team }
          : { category: isProfile ? 'player-data' : 'tribe-data', owner: base, team },
      });
      if (isProfile) counts.profiles++; else counts.tribes++;
    } catch (e) {
      ctx.note(`unreadable ${ext}: ${(e as Error).message}`);
      counts.unreadable++;
    }
  }
  return counts;
}

export async function createSnapshot(opts: {
  save: string; out: string; name: string; containers: boolean; log: (msg: string) => void;
}): Promise<SnapshotResult> {
  const seconds: Record<string, number> = {};
  let t = performance.now();
  const lap = (what: string) => { const now = performance.now(); seconds[what] = +((now - t) / 1000).toFixed(2); t = now; };

  const before = statSync(opts.save);
  const savedAt = new Date(before.mtimeMs);
  const dir = join(opts.out, opts.name, 'snapshots');
  const path = join(dir, `${stamp(savedAt)}.sqlite`);
  try {
    statSync(path);
    return { path, savedAt: savedAt.toISOString(), skipped: true, rows: 0, seconds };
  } catch { /* not exported yet */ }
  mkdirSync(dir, { recursive: true });

  const buf = readFileSync(opts.save);
  if (statSync(opts.save).mtimeMs !== before.mtimeMs) throw new Error('save changed while reading, try again');
  lap('read');
  const ctx = new ReadContext();
  const save = readSave(buf, ctx);
  lap('parse');

  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  const db = await openDatabase(tmp);
  for (const pragma of ['page_size = 8192', 'journal_mode = OFF', 'synchronous = OFF', 'cache_size = -262144', 'temp_store = MEMORY']) {
    db.exec(`PRAGMA ${pragma}`);
  }
  db.exec(SNAPSHOT_SCHEMA);
  const insert = db.prepare(`INSERT INTO objects (key, source, category, class, name, tribe_name, names, container, owner, team,
      x, y, z, pitch, yaw, roll, data_file, guid, hash, props, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const categories = new Map<string, number>();
  const emit = (r: Row) => {
    insert.run(r.key, r.source, r.category, r.cls, r.name, r.tribeName, r.names, r.container, r.owner, r.team,
      r.x, r.y, r.z, r.pitch, r.yaw, r.roll, r.dataFile, r.guid, r.hash, r.props, r.extra);
    const c = `${r.source}:${r.category}`;
    categories.set(c, (categories.get(c) ?? 0) + 1);
  };
  const stats: EmitStats = { rows: 0, cryoArchives: 0, cryoObjects: 0, duplicateKeys: 0 };
  const registry = new KeyRegistry();
  db.exec('BEGIN');
  emitWorld(save, registry, emit, stats, true);
  lap('world rows');
  const containerCounts = opts.containers ? emitContainers(dirname(opts.save), registry, emit, stats, ctx) : {};
  lap('profile and tribe rows');
  db.exec('COMMIT');
  db.exec(SNAPSHOT_INDEXES);
  lap('indexes');
  stats.duplicateKeys = registry.duplicates;

  const meta: Record<string, unknown> = {
    name: opts.name,
    map: save.dataFiles[0],
    source_file: opts.save,
    saved_at: savedAt.toISOString(),
    file_size: buf.length,
    save_version: save.version,
    game_time: save.gameTime,
    save_count: save.saveCount,
    data_files: save.dataFiles,
    data_file_objects: save.dataFileObjects,
    embedded_data: save.embeddedData,
    hibernation: save.hibernation,
    sections: save.sections,
    issues: Object.fromEntries(ctx.issues),
    raw_bytes: Object.fromEntries(ctx.rawBytes),
    objects_in_save: save.objects.length,
    rows: stats.rows,
    categories: Object.fromEntries([...categories].sort()),
    cryo_archives: stats.cryoArchives,
    cryo_objects: stats.cryoObjects,
    duplicate_keys: stats.duplicateKeys,
    containers: containerCounts,
    volatile_fields: [...VOLATILE_FIELDS],
    exporter_version: EXPORTER_VERSION,
    runtime: `${runtime} ${process.versions.bun ?? process.versions.node}`,
    exported_at: new Date().toISOString(),
    seconds,
  };
  const putMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(meta)) putMeta.run(k, typeof v === 'string' ? v : JSON.stringify(v));
  db.close();
  rmSync(`${tmp}-journal`, { force: true });
  renameSync(tmp, path);
  lap('finish');

  const latest = join(opts.out, opts.name, 'latest.sqlite');
  rmSync(latest, { force: true });
  symlinkSync(relative(dirname(latest), path), latest);
  opts.log(`${opts.name}: snapshot ${basename(path)} with ${stats.rows} rows (${JSON.stringify(seconds)})`);
  return { path, savedAt: savedAt.toISOString(), skipped: false, rows: stats.rows, seconds };
}
