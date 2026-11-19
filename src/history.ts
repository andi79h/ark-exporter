// Change history: compares the newest snapshot with the previous one and records what was added,
// removed or changed (volatile fields excluded) plus every position change.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { VOLATILE_FIELDS } from './normalize.ts';
import { type Database, openDatabase, type SqlRow } from './sqlite.ts';

export const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS saves (
  id INTEGER PRIMARY KEY,
  snapshot TEXT NOT NULL UNIQUE,
  saved_at TEXT NOT NULL,
  game_time REAL,
  save_count INTEGER,
  objects INTEGER NOT NULL,
  baseline INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  changed INTEGER NOT NULL DEFAULT 0,
  moved INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (
  save_id INTEGER NOT NULL REFERENCES saves(id),
  key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'removed', 'changed')),
  category TEXT NOT NULL,
  class TEXT NOT NULL,
  team INTEGER,
  owner TEXT,
  container TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_key ON changes(key, save_id);
CREATE INDEX IF NOT EXISTS changes_save ON changes(save_id, kind);
CREATE INDEX IF NOT EXISTS changes_team ON changes(team, save_id);
CREATE TABLE IF NOT EXISTS positions (
  save_id INTEGER NOT NULL REFERENCES saves(id),
  key TEXT NOT NULL,
  category TEXT NOT NULL,
  class TEXT NOT NULL,
  team INTEGER,
  x REAL, y REAL, z REAL,
  container TEXT,
  owner TEXT
);
CREATE INDEX IF NOT EXISTS positions_key ON positions(key, save_id);
CREATE INDEX IF NOT EXISTS positions_save ON positions(save_id);
CREATE INDEX IF NOT EXISTS positions_xy ON positions(x, y);
`;

/** Things that move by themselves; their positions go into the history even without other changes. */
const MOVING = `category IN ('dino', 'pawn')`;

/** Positions closer than this (Unreal units = cm) count as unchanged. */
const MOVE_THRESHOLD = 50;

function quote(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

function meta(db: Database, schema: string, key: string): string | null {
  const row = db.prepare(`SELECT value FROM ${schema}.meta WHERE key = ?`).all(key)[0];
  return row ? String(row.value) : null;
}

/**
 * Top-level fields whose value differs (volatile ones left out) plus changed columns ($owner, ...).
 * The row holds the new values and the old ones prefixed with old_.
 */
export function diffRow(row: SqlRow): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const col of ['class', 'owner', 'container', 'team']) {
    if (row[`old_${col}`] !== row[col]) out[`$${col}`] = [row[`old_${col}`], row[col]];
  }
  const a = JSON.parse(String(row.old_props)) as Record<string, unknown>;
  const b = JSON.parse(String(row.props)) as Record<string, unknown>;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (VOLATILE_FIELDS.has(k)) continue;
    const va = k in a ? JSON.stringify(a[k]) : undefined;
    const vb = k in b ? JSON.stringify(b[k]) : undefined;
    if (va !== vb) out[k] = [k in a ? a[k] : null, k in b ? b[k] : null];
  }
  return out;
}

export interface HistoryResult { snapshot: string; baseline: boolean; skipped: boolean; added: number; removed: number; changed: number; moved: number; seconds: number; }

/** Snapshot files of one map, oldest first. */
export function listSnapshots(mapDir: string): string[] {
  const dir = join(mapDir, 'snapshots');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort();
}

export async function updateHistory(mapDir: string, log: (msg: string) => void): Promise<HistoryResult | null> {
  const t0 = performance.now();
  const snapshots = listSnapshots(mapDir);
  if (!snapshots.length) return null;
  const current = snapshots[snapshots.length - 1];
  const db = await openDatabase(join(mapDir, 'history.sqlite'));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(HISTORY_SCHEMA);
    const done = db.prepare('SELECT id FROM saves WHERE snapshot = ?').all(current);
    if (done.length) {
      return { snapshot: current, baseline: false, skipped: true, added: 0, removed: 0, changed: 0, moved: 0, seconds: 0 };
    }
    const last = db.prepare('SELECT snapshot FROM saves ORDER BY saved_at DESC, id DESC LIMIT 1').all()[0];
    const previous = last && existsSync(join(mapDir, 'snapshots', String(last.snapshot))) ? String(last.snapshot) : null;
    if (last && !previous) log(`${mapDir}: previous snapshot ${last.snapshot} is gone, starting a new baseline`);

    db.exec(`ATTACH DATABASE ${quote(join(mapDir, 'snapshots', current))} AS cur`);
    if (previous) db.exec(`ATTACH DATABASE ${quote(join(mapDir, 'snapshots', previous))} AS prev`);
    db.exec('BEGIN');
    const objects = Number(db.prepare('SELECT count(*) AS n FROM cur.objects').all()[0].n);
    db.prepare(`INSERT INTO saves (snapshot, saved_at, game_time, save_count, objects, baseline, processed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      current, meta(db, 'cur', 'saved_at') ?? current, Number(meta(db, 'cur', 'game_time')), Number(meta(db, 'cur', 'save_count')),
      objects, previous ? 0 : 1, new Date().toISOString(),
    );
    const saveId = Number(db.prepare('SELECT last_insert_rowid() AS id').all()[0].id);
    const r: HistoryResult = { snapshot: current, baseline: !previous, skipped: false, added: 0, removed: 0, changed: 0, moved: 0, seconds: 0 };

    const count = (sql: string) => Number(db.prepare(sql).all()[0].n);
    if (!previous) {
      // Baseline: where everything that moves is right now.
      db.prepare(`INSERT INTO positions SELECT ?, key, category, class, team, x, y, z, container, owner FROM cur.objects WHERE ${MOVING}`).run(saveId);
      r.moved = count(`SELECT count(*) AS n FROM positions WHERE save_id = ${saveId}`);
    } else {
      db.prepare(`INSERT INTO changes SELECT ?, c.key, 'added', c.category, c.class, c.team, c.owner, c.container, c.props
        FROM cur.objects c WHERE NOT EXISTS (SELECT 1 FROM prev.objects p WHERE p.key = c.key)`).run(saveId);
      r.added = count(`SELECT count(*) AS n FROM changes WHERE save_id = ${saveId} AND kind = 'added'`);
      db.prepare(`INSERT INTO changes SELECT ?, p.key, 'removed', p.category, p.class, p.team, p.owner, p.container, p.props
        FROM prev.objects p WHERE NOT EXISTS (SELECT 1 FROM cur.objects c WHERE c.key = p.key)`).run(saveId);
      r.removed = count(`SELECT count(*) AS n FROM changes WHERE save_id = ${saveId} AND kind = 'removed'`);

      const insertChange = db.prepare('INSERT INTO changes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const changed = db.prepare(`SELECT c.key, c.category, c.class, c.team, c.owner, c.container, c.props,
          p.class AS old_class, p.team AS old_team, p.owner AS old_owner, p.container AS old_container, p.props AS old_props
        FROM cur.objects c JOIN prev.objects p ON p.key = c.key
        WHERE p.hash <> c.hash OR p.class <> c.class OR p.owner IS NOT c.owner OR p.container IS NOT c.container OR p.team IS NOT c.team`);
      for (const row of changed.iterate()) {
        const fields = diffRow(row);
        if (!Object.keys(fields).length) continue;
        insertChange.run(saveId, row.key, 'changed', row.category, row.class, row.team, row.owner, row.container, JSON.stringify(fields));
        r.changed++;
      }

      // New things that move, and everything that moved further than the threshold.
      db.prepare(`INSERT INTO positions SELECT ?, c.key, c.category, c.class, c.team, c.x, c.y, c.z, c.container, c.owner
        FROM cur.objects c LEFT JOIN prev.objects p ON p.key = c.key
        WHERE (p.key IS NULL AND c.${MOVING})
           OR (p.key IS NOT NULL AND (
                (c.x IS NOT NULL AND (p.x IS NULL OR abs(c.x - p.x) > ${MOVE_THRESHOLD} OR abs(c.y - p.y) > ${MOVE_THRESHOLD} OR abs(c.z - p.z) > ${MOVE_THRESHOLD}))
                OR (c.${MOVING} AND (c.container IS NOT p.container OR c.owner IS NOT p.owner))))`).run(saveId);
      r.moved = count(`SELECT count(*) AS n FROM positions WHERE save_id = ${saveId}`);
    }
    db.prepare('UPDATE saves SET added = ?, removed = ?, changed = ?, moved = ? WHERE id = ?').run(r.added, r.removed, r.changed, r.moved, saveId);
    db.exec('COMMIT');
    db.exec('DETACH DATABASE cur');
    if (previous) db.exec('DETACH DATABASE prev');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    r.seconds = +((performance.now() - t0) / 1000).toFixed(2);
    log(`${mapDir}: history ${r.baseline ? 'baseline' : `+${r.added} -${r.removed} ~${r.changed}`} moved ${r.moved} (${r.seconds} s)`);
    return r;
  } finally {
    db.close();
  }
}

/** Deletes old snapshots, keeping the newest `keep` (at least 1). */
export function pruneSnapshots(mapDir: string, keep: number, log: (msg: string) => void): void {
  const snapshots = listSnapshots(mapDir);
  for (const f of snapshots.slice(0, Math.max(0, snapshots.length - Math.max(1, keep)))) {
    rmSync(join(mapDir, 'snapshots', f), { force: true });
    log(`${mapDir}: removed old snapshot ${f}`);
  }
}
