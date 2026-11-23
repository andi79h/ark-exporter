// ark-export: complete ARK: Survival Evolved savegame export into SQLite snapshots and a change history.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspectAsa, inspectContainers, isAsaWorld } from './asa/inspect.ts';
import { pruneSnapshots, updateHistory } from './history.ts';
import { VOLATILE_FIELDS } from './normalize.ts';
import { readSave } from './savegame.ts';
import { createSnapshot, defaultName, EXPORTER_VERSION } from './snapshot.ts';
import { openDatabase, runtime } from './sqlite.ts';
import { ReadContext } from './types.ts';

const USAGE = `ark-export ${EXPORTER_VERSION} – ARK: Survival Evolved savegame export

Usage:
  ark-export inspect <Map.ark> [--limit N]            coverage report (JSON), writes nothing;
                                                     ASE and ASA (SQLite) world saves, ASA .arkprofile/.arktribe
  ark-export snapshot <Map.ark> --out DIR [--name N]  full snapshot into DIR/N/snapshots/<time>.sqlite
  ark-export history --out DIR --name N [--keep K]    diff newest snapshot against the previous one
  ark-export run <Map.ark> --out DIR [--name N] [--keep K]
                                                     snapshot + history + delete old snapshots
  ark-export sync --out DIR [--keep K] [--min-age S] <SavedArks dir | Map.ark>...
                                                     run for every save that changed since the last export
  ark-export mysql --out DIR [--name N] --mysql URL  copy newest snapshot and history to MySQL
  ark-export query <file.sqlite> <SQL> [params...]   print rows as JSON lines
  ark-export compare <old.sqlite> <new.sqlite>       which fields change between two snapshots

Options:
  --out DIR        export directory (one folder per map)
  --name N         folder name (default: the folder above ShooterGame/, else the map name)
  --keep K         snapshots to keep per map (default 2)
  --min-age S      skip saves written less than S seconds ago (default 20)
  --exclude A,B    sync: skip these names
  --no-containers  leave out .arkprofile/.arktribe/.arktributetribe files
  --mysql URL      also keep MySQL up to date (run, sync): mysql://user:pass@host/db,
                   or @FILE with that URL; default: $ARK_EXPORT_MYSQL
`;

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

const BACKUP_NAME = /_\d{2}\.\d{2}\.\d{4}_\d{2}\.\d{2}\.\d{2}\.ark$/;

/** The live save of a SavedArks folder: newest .ark that is not a time-stamped backup. */
export function findSave(dir: string): string | null {
  let best: string | null = null;
  let bestTime = -1;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ark') || BACKUP_NAME.test(f)) continue;
    const t = statSync(join(dir, f)).mtimeMs;
    if (t > bestTime) { best = join(dir, f); bestTime = t; }
  }
  return best;
}

/** One sync at a time per export directory. */
function lock(out: string): () => void {
  mkdirSync(out, { recursive: true });
  const path = join(out, '.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch {
      const pid = Number(readFileSync(path, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* stale */ }
      if (alive) throw new Error(`another export (pid ${pid}) is running in ${out}`);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`cannot lock ${out}`);
}

/** The MySQL part (and the mysql2 package) is only loaded when MySQL is used. */
async function mirror(mapDir: string, name: string, url: string): Promise<void> {
  const { mirrorToMysql } = await import('./mysql.ts');
  await mirrorToMysql(mapDir, name, url, log);
}

/** `mysql://user:password@host:port/database`, or `@/path/to/file` holding that URL (keeps it out of `ps`). */
function resolveMysqlUrl(value: string): string {
  return value.startsWith('@') ? readFileSync(value.slice(1), 'utf8').trim() : value;
}

async function runOne(save: string, out: string, name: string, keep: number, containers: boolean, mysqlUrl: string | null): Promise<void> {
  const snap = await createSnapshot({ save, out, name, containers, log });
  if (snap.skipped) {
    log(`${name}: ${basename(snap.path)} already exported`);
  }
  const mapDir = join(out, name);
  await updateHistory(mapDir, log);
  if (mysqlUrl) {
    try {
      await mirror(mapDir, name, mysqlUrl);
    } catch (e) {
      // Keep the snapshot MySQL still reflects, so the next run can continue incrementally.
      log(`${name}: MySQL FAILED, old snapshots kept: ${(e as Error).message}`);
      throw e;
    }
  }
  pruneSnapshots(mapDir, keep, log);
}

async function inspect(save: string, limit: number | undefined, containers: boolean): Promise<void> {
  if (/\.ark(profile|tribe)$/.test(save)) {
    process.stdout.write(`${JSON.stringify(inspectContainers([save]), null, 2)}\n`);
    return;
  }
  if (isAsaWorld(save)) {
    process.stdout.write(`${JSON.stringify(await inspectAsa(save, { limit, containers }), null, 2)}\n`);
    return;
  }
  const t0 = performance.now();
  const ctx = new ReadContext();
  const s = readSave(readFileSync(save), ctx);
  const seconds = +((performance.now() - t0) / 1000).toFixed(2);
  const classes = new Map<string, number>();
  for (const o of s.objects) classes.set(o.cls, (classes.get(o.cls) ?? 0) + 1);
  const decoded = s.sections.filter((x) => x.decoded).reduce((a, x) => a + x.bytes, 0);
  const raw = [...ctx.rawBytes.values()].reduce((a, x) => a + x, 0);
  process.stdout.write(`${JSON.stringify({
    file: save, runtime: `${runtime} ${process.versions.bun ?? process.versions.node}`, seconds,
    version: s.version, map: s.dataFiles[0], gameTime: s.gameTime, saveCount: s.saveCount,
    objects: s.objects.length, names: s.nameCount, dataFiles: s.dataFiles.length,
    decodedPercent: +(100 * (decoded - raw) / statSync(save).size).toFixed(3),
    sections: s.sections, issues: Object.fromEntries(ctx.issues), rawBytes: Object.fromEntries(ctx.rawBytes),
    hibernation: s.hibernation, topClasses: [...classes].sort((a, b) => b[1] - a[1]).slice(0, 25),
  }, null, 2)}\n`);
}

async function query(file: string, sql: string, params: string[]): Promise<void> {
  const db = await openDatabase(file, { readonly: true });
  try {
    for (const row of db.prepare(sql).iterate(...params.map((p) => (/^-?\d+(\.\d+)?$/.test(p) ? Number(p) : p)))) {
      process.stdout.write(`${JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
    }
  } finally {
    db.close();
  }
}

/** Field change statistics between two snapshots, to decide which fields are volatile. */
async function compare(oldFile: string, newFile: string): Promise<void> {
  const db = await openDatabase(':memory:');
  db.exec(`ATTACH DATABASE '${resolve(oldFile).replace(/'/g, "''")}' AS a`);
  db.exec(`ATTACH DATABASE '${resolve(newFile).replace(/'/g, "''")}' AS b`);
  const count = (sql: string) => Number(db.prepare(sql).all()[0].n);
  const matched = count('SELECT count(*) AS n FROM a.objects x JOIN b.objects y ON y.key = x.key');
  const fields = new Map<string, number>();
  const only = new Map<string, number>();
  const cats = new Map<string, number>();
  let changed = 0;
  const all = new Map<string, number>();
  for (const row of db.prepare(`SELECT y.category, x.props AS old, y.props AS new FROM a.objects x JOIN b.objects y ON y.key = x.key
      WHERE x.props <> y.props`).iterate()) {
    const a = JSON.parse(String(row.old)) as Record<string, unknown>;
    const b = JSON.parse(String(row.new)) as Record<string, unknown>;
    const diff: string[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diff.push(k);
    }
    for (const k of diff) all.set(`${row.category} ${k}${VOLATILE_FIELDS.has(k) ? ' (volatile)' : ''}`, (all.get(`${row.category} ${k}${VOLATILE_FIELDS.has(k) ? ' (volatile)' : ''}`) ?? 0) + 1);
    const real = diff.filter((k) => !VOLATILE_FIELDS.has(k));
    if (!real.length) continue;
    changed++;
    cats.set(String(row.category), (cats.get(String(row.category)) ?? 0) + 1);
    for (const k of real) fields.set(`${row.category} ${k}`, (fields.get(`${row.category} ${k}`) ?? 0) + 1);
    if (real.length === 1) only.set(`${row.category} ${real[0]}`, (only.get(`${row.category} ${real[0]}`) ?? 0) + 1);
  }
  const top = (m: Map<string, number>, n: number) => [...m].sort((x, y) => y[1] - x[1]).slice(0, n);
  process.stdout.write(`${JSON.stringify({
    matched,
    added: count('SELECT count(*) AS n FROM b.objects y WHERE NOT EXISTS (SELECT 1 FROM a.objects x WHERE x.key = y.key)'),
    removed: count('SELECT count(*) AS n FROM a.objects x WHERE NOT EXISTS (SELECT 1 FROM b.objects y WHERE y.key = x.key)'),
    changedWithoutVolatile: changed, changedByCategory: Object.fromEntries(cats),
    topFieldsAll: top(all, 40), topFields: top(fields, 40), onlyThisFieldChanged: top(only, 30),
  }, null, 2)}\n`);
  db.close();
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      name: { type: 'string' },
      keep: { type: 'string', default: '2' },
      'min-age': { type: 'string', default: '20' },
      'no-containers': { type: 'boolean', default: false },
      exclude: { type: 'string', default: '' },
      mysql: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...args] = positionals;
  const keep = Number(values.keep);
  const containers = !values['no-containers'];
  const mysqlSetting = values.mysql ?? process.env.ARK_EXPORT_MYSQL ?? null;
  const mysqlUrl = mysqlSetting ? resolveMysqlUrl(mysqlSetting) : null;
  const needOut = (): string => {
    if (!values.out) throw new Error('--out is required');
    return resolve(values.out);
  };
  switch (values.help ? 'help' : command) {
    case 'inspect':
      await inspect(args[0], values.limit ? Number(values.limit) : undefined, containers);
      return 0;
    case 'snapshot': {
      const save = resolve(args[0]);
      await createSnapshot({ save, out: needOut(), name: values.name ?? defaultName(save), containers, log });
      return 0;
    }
    case 'history': {
      if (!values.name) throw new Error('--name is required');
      const mapDir = join(needOut(), values.name);
      await updateHistory(mapDir, log);
      pruneSnapshots(mapDir, keep, log);
      return 0;
    }
    case 'run': {
      const save = resolve(args[0]);
      const out = needOut();
      const unlock = lock(out);
      try {
        await runOne(save, out, values.name ?? defaultName(save), keep, containers, mysqlUrl);
      } finally {
        unlock();
      }
      return 0;
    }
    case 'sync': {
      const out = needOut();
      const minAge = Number(values['min-age']) * 1000;
      const exclude = new Set(values.exclude.split(',').map((s) => s.trim()).filter(Boolean));
      const unlock = lock(out);
      let failed = 0;
      try {
        for (const arg of args) {
          const target = resolve(arg);
          const save = statSync(target).isDirectory() ? findSave(target) : target;
          if (!save || !existsSync(save)) { log(`${arg}: no save found`); continue; }
          if (exclude.has(defaultName(save))) continue;
          if (Date.now() - statSync(save).mtimeMs < minAge) { log(`${save}: written just now, next time`); continue; }
          try {
            await runOne(save, out, defaultName(save), keep, containers, mysqlUrl);
          } catch (e) {
            failed++;
            log(`${save}: FAILED ${(e as Error).stack ?? e}`);
          }
        }
      } finally {
        unlock();
      }
      return failed ? 1 : 0;
    }
    case 'mysql': {
      if (!mysqlUrl) throw new Error('--mysql or $ARK_EXPORT_MYSQL is required');
      const out = needOut();
      const names = values.name ? [values.name] : readdirSync(out).filter((n) => existsSync(join(out, n, 'latest.sqlite')));
      for (const name of names) await mirror(join(out, name), name, mysqlUrl);
      return 0;
    }
    case 'query':
      await query(args[0], args[1], args.slice(2));
      return 0;
    case 'compare':
      await compare(args[0], args[1]);
      return 0;
    default:
      process.stdout.write(USAGE);
      return command && command !== 'help' ? 2 : 0;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: Error) => {
  process.stderr.write(`ark-export: ${e.message}\n`);
  process.exitCode = 1;
});
