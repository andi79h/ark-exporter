// Mirrors the newest snapshot and the history of every map into MySQL (5.7 or newer), so they can
// be searched with any MySQL tool. Only rows that differ from the mirrored snapshot are written;
// the first run (or a run after the previous snapshot was pruned) loads everything.
import { existsSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import mysql from 'mysql2/promise';
import { openDatabase, type SqlRow, type SqlValue } from './sqlite.ts';

type Connection = mysql.Connection;

const KEY = 'VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin';
const MAP = 'VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL';

export const MYSQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS maps (
    name ${MAP} PRIMARY KEY,
    ark_map VARCHAR(128) NULL,
    snapshot VARCHAR(64) NULL,
    saved_at DATETIME(3) NULL,
    game_time DOUBLE NULL,
    save_count INT NULL,
    objects INT NULL,
    history_seq INT NOT NULL DEFAULT 0,
    meta JSON NULL,
    updated_at DATETIME(3) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS objects (
    map ${MAP},
    \`key\` ${KEY} NOT NULL,
    source VARCHAR(16) NOT NULL,
    category VARCHAR(16) NOT NULL,
    class VARCHAR(255) NOT NULL,
    name VARCHAR(255) NULL,
    tribe_name VARCHAR(255) NULL,
    names JSON NOT NULL,
    container ${KEY} NULL,
    owner ${KEY} NULL,
    team BIGINT NULL,
    x DOUBLE NULL, y DOUBLE NULL, z DOUBLE NULL, pitch DOUBLE NULL, yaw DOUBLE NULL, roll DOUBLE NULL,
    data_file INT NULL,
    guid CHAR(32) NULL,
    hash CHAR(22) NOT NULL,
    props JSON NOT NULL,
    extra JSON NULL,
    PRIMARY KEY (map, \`key\`),
    KEY objects_category_team (map, category, team),
    KEY objects_class (map, class),
    KEY objects_owner (map, owner),
    KEY objects_container (map, container),
    KEY objects_name (name),
    KEY objects_tribe_name (tribe_name),
    KEY objects_xy (map, x, y)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS saves (
    map ${MAP},
    seq INT NOT NULL,
    snapshot VARCHAR(64) NOT NULL,
    saved_at DATETIME(3) NOT NULL,
    game_time DOUBLE NULL,
    save_count INT NULL,
    objects INT NOT NULL,
    baseline TINYINT NOT NULL,
    added INT NOT NULL, removed INT NOT NULL, changed INT NOT NULL, moved INT NOT NULL,
    PRIMARY KEY (map, seq),
    KEY saves_time (map, saved_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS changes (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    map ${MAP},
    seq INT NOT NULL,
    \`key\` ${KEY} NOT NULL,
    kind VARCHAR(8) NOT NULL,
    category VARCHAR(16) NOT NULL,
    class VARCHAR(255) NOT NULL,
    team BIGINT NULL,
    owner ${KEY} NULL,
    container ${KEY} NULL,
    data JSON NOT NULL,
    KEY changes_key (map, \`key\`, seq),
    KEY changes_save (map, seq, kind),
    KEY changes_team (map, team, seq)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS positions (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    map ${MAP},
    seq INT NOT NULL,
    \`key\` ${KEY} NOT NULL,
    category VARCHAR(16) NOT NULL,
    class VARCHAR(255) NOT NULL,
    team BIGINT NULL,
    x DOUBLE NULL, y DOUBLE NULL, z DOUBLE NULL,
    container ${KEY} NULL,
    owner ${KEY} NULL,
    KEY positions_key (map, \`key\`, seq),
    KEY positions_save (map, seq),
    KEY positions_xy (map, x, y)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const OBJECT_COLUMNS = ['key', 'source', 'category', 'class', 'name', 'tribe_name', 'names', 'container', 'owner', 'team',
  'x', 'y', 'z', 'pitch', 'yaw', 'roll', 'data_file', 'guid', 'hash', 'props', 'extra'];

/** Statement size budget per connection: a quarter of max_allowed_packet, at most 16 MB. */
const budgets = new WeakMap<Connection, number>();

export async function connectMysql(url: string): Promise<Connection> {
  const conn = await mysql.createConnection({
    uri: url, charset: 'utf8mb4', timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  });
  await conn.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION', time_zone = '+00:00'");
  const [rows] = await conn.query('SELECT @@max_allowed_packet AS packet');
  const packet = Number((rows as { packet: string }[])[0].packet);
  budgets.set(conn, Math.max(256_000, Math.min(16_000_000, Math.floor(packet / 4))));
  return conn;
}

export async function ensureSchema(conn: Connection): Promise<void> {
  for (const sql of MYSQL_SCHEMA) await conn.query(sql);
}

/** ISO time from the snapshots -> MySQL DATETIME(3) in UTC. */
function datetime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Collects rows and sends them as multi-row statements of a few MB each. With several connections
 * the statements run in parallel (full loads); with one they keep their order (transactions).
 */
class Batcher {
  private rows: SqlValue[][] = [];
  private bytes = 0;
  sent = 0;
  private readonly free: Connection[];
  private readonly inflight = new Set<Promise<void>>();
  private error: unknown = null;
  private readonly budget: number;
  private readonly head: string;
  private readonly tail: string;
  private readonly width: number;

  constructor(conns: Connection[], table: string, columns: string[], tail = '') {
    this.free = [...conns];
    this.budget = Math.min(...conns.map((c) => budgets.get(c) ?? 1_000_000));
    this.width = columns.length;
    this.head = `INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES `;
    this.tail = tail;
  }

  async add(row: SqlValue[]): Promise<void> {
    let size = 0;
    for (const v of row) size += typeof v === 'string' ? Buffer.byteLength(v) + 3 : 8;
    if (this.rows.length && this.bytes + size > this.budget) await this.dispatch();
    this.rows.push(row);
    this.bytes += size;
    if (this.bytes > this.budget || this.rows.length >= 2000) await this.dispatch();
  }

  private async dispatch(): Promise<void> {
    if (!this.rows.length) return;
    while (!this.free.length) await Promise.race(this.inflight);
    if (this.error) throw this.error;
    const conn = this.free.pop() as Connection;
    const rows = this.rows;
    this.rows = [];
    this.bytes = 0;
    const one = `(${new Array(this.width).fill('?').join(',')})`;
    const sql = this.head + new Array(rows.length).fill(one).join(',') + this.tail;
    // Failures are kept and thrown on the next call, so no promise is ever left rejected.
    const p: Promise<void> = conn.query(sql, rows.flat()).then(
      () => { this.sent += rows.length; },
      (e: unknown) => { this.error ??= e; },
    ).finally(() => {
      this.inflight.delete(p);
      this.free.push(conn);
    });
    this.inflight.add(p);
    if (this.error) throw this.error;
  }

  /** Sends what is left and waits for every statement. */
  async flush(): Promise<void> {
    await this.dispatch();
    await Promise.all(this.inflight);
    if (this.error) throw this.error;
  }
}

/** Parallel connections for full loads. */
const FULL_LOAD_CONNECTIONS = 4;

function objectRow(map: string, r: SqlRow): SqlValue[] {
  return [map, ...OBJECT_COLUMNS.map((c) => r[c] ?? null)];
}

const UPSERT_TAIL = ` ON DUPLICATE KEY UPDATE ${OBJECT_COLUMNS.filter((c) => c !== 'key').map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ')}`;

function quote(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

export interface MirrorResult { mode: 'unchanged' | 'full' | 'incremental'; upserted: number; deleted: number; saves: number; seconds: number; }

async function mirrorObjects(conn: Connection, url: string, mapDir: string, map: string, current: string, previous: string | null,
  log: (m: string) => void): Promise<{ mode: 'full' | 'incremental'; upserted: number; deleted: number }> {
  const db = await openDatabase(':memory:');
  try {
    db.exec(`ATTACH DATABASE ${quote(join(mapDir, 'snapshots', current))} AS cur`);
    const upsert = new Batcher([conn], 'objects', ['map', ...OBJECT_COLUMNS], UPSERT_TAIL);
    const cols = OBJECT_COLUMNS.map((c) => `c.\`${c}\``).join(', ');
    if (previous) {
      db.exec(`ATTACH DATABASE ${quote(join(mapDir, 'snapshots', previous))} AS prev`);
      const differs = OBJECT_COLUMNS.filter((c) => c !== 'key').map((c) => `c.\`${c}\` IS NOT p.\`${c}\``).join(' OR ');
      await conn.beginTransaction();
      try {
        for (const r of db.prepare(`SELECT ${cols} FROM cur.objects c LEFT JOIN prev.objects p ON p.key = c.key
            WHERE p.key IS NULL OR ${differs}`).iterate()) {
          await upsert.add(objectRow(map, r));
        }
        await upsert.flush();
        let deleted = 0;
        let keys: string[] = [];
        const drop = async () => {
          if (!keys.length) return;
          await conn.query(`DELETE FROM objects WHERE map = ? AND \`key\` IN (${keys.map(() => '?').join(',')})`, [map, ...keys]);
          deleted += keys.length;
          keys = [];
        };
        for (const r of db.prepare('SELECT p.key FROM prev.objects p WHERE NOT EXISTS (SELECT 1 FROM cur.objects c WHERE c.key = p.key)').iterate()) {
          keys.push(String(r.key));
          if (keys.length >= 1000) await drop();
        }
        await drop();
        await conn.query('UPDATE maps SET snapshot = ? WHERE name = ?', [current, map]);
        await conn.commit();
        return { mode: 'incremental', upserted: upsert.sent, deleted };
      } catch (e) {
        await conn.rollback();
        throw e;
      }
    }
    // Full load: mark the map as loading, clear it in chunks, insert everything.
    log(`${map}: MySQL full load of ${current}`);
    await conn.query('UPDATE maps SET snapshot = NULL WHERE name = ?', [map]);
    let deleted = 0;
    for (;;) {
      const [res] = await conn.query('DELETE FROM objects WHERE map = ? LIMIT 20000', [map]);
      const n = (res as mysql.ResultSetHeader).affectedRows;
      deleted += n;
      if (n < 20000) break;
    }
    const extra: Connection[] = [];
    try {
      for (let i = 1; i < FULL_LOAD_CONNECTIONS; i++) extra.push(await connectMysql(url));
      const insert = new Batcher([conn, ...extra], 'objects', ['map', ...OBJECT_COLUMNS]);
      for (const r of db.prepare(`SELECT ${cols} FROM cur.objects c`).iterate()) await insert.add(objectRow(map, r));
      await insert.flush();
      await conn.query('UPDATE maps SET snapshot = ? WHERE name = ?', [current, map]);
      return { mode: 'full', upserted: insert.sent, deleted };
    } finally {
      for (const c of extra) await c.end().catch(() => {});
    }
  } finally {
    db.close();
  }
}

/** Copies history entries that MySQL does not have yet (history.sqlite ids become `seq`). */
async function mirrorHistory(conn: Connection, mapDir: string, map: string, after: number): Promise<number> {
  const path = join(mapDir, 'history.sqlite');
  if (!existsSync(path)) return 0;
  const db = await openDatabase(path, { readonly: true });
  let count = 0;
  try {
    const saves = db.prepare('SELECT * FROM saves WHERE id > ? ORDER BY id').all(after);
    for (const s of saves) {
      const seq = Number(s.id);
      await conn.beginTransaction();
      try {
        // A half-copied save from an aborted run is replaced as a whole.
        for (const table of ['saves', 'changes', 'positions']) await conn.query(`DELETE FROM ${table} WHERE map = ? AND seq = ?`, [map, seq]);
        await conn.query(`INSERT INTO saves (map, seq, snapshot, saved_at, game_time, save_count, objects, baseline, added, removed, changed, moved)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [map, seq, s.snapshot, datetime(String(s.saved_at)), s.game_time, s.save_count,
          s.objects, s.baseline, s.added, s.removed, s.changed, s.moved]);
        const changes = new Batcher([conn], 'changes', ['map', 'seq', 'key', 'kind', 'category', 'class', 'team', 'owner', 'container', 'data']);
        for (const c of db.prepare('SELECT * FROM changes WHERE save_id = ?').iterate(seq)) {
          await changes.add([map, seq, c.key, c.kind, c.category, c.class, c.team, c.owner, c.container, c.data]);
        }
        await changes.flush();
        const positions = new Batcher([conn], 'positions', ['map', 'seq', 'key', 'category', 'class', 'team', 'x', 'y', 'z', 'container', 'owner']);
        for (const p of db.prepare('SELECT * FROM positions WHERE save_id = ?').iterate(seq)) {
          await positions.add([map, seq, p.key, p.category, p.class, p.team, p.x, p.y, p.z, p.container, p.owner]);
        }
        await positions.flush();
        await conn.query('UPDATE maps SET history_seq = ? WHERE name = ?', [seq, map]);
        await conn.commit();
        count++;
      } catch (e) {
        await conn.rollback();
        throw e;
      }
    }
  } finally {
    db.close();
  }
  return count;
}

/** Brings MySQL up to the newest snapshot and history of one map folder. */
export async function mirrorToMysql(mapDir: string, map: string, url: string, log: (m: string) => void): Promise<MirrorResult | null> {
  const t0 = performance.now();
  const latest = join(mapDir, 'latest.sqlite');
  if (!existsSync(latest)) return null;
  const current = basename(realpathSync(latest));
  const conn = await connectMysql(url);
  try {
    await ensureSchema(conn);
    await conn.query('INSERT IGNORE INTO maps (name) VALUES (?)', [map]);
    const [rows] = await conn.query('SELECT snapshot, history_seq FROM maps WHERE name = ?', [map]);
    const state = (rows as { snapshot: string | null; history_seq: number }[])[0];
    let mode: MirrorResult['mode'] = 'unchanged';
    let upserted = 0;
    let deleted = 0;
    if (state.snapshot !== current) {
      const previous = state.snapshot && existsSync(join(mapDir, 'snapshots', state.snapshot)) ? state.snapshot : null;
      ({ mode, upserted, deleted } = await mirrorObjects(conn, url, mapDir, map, current, previous, log));
      const snap = await openDatabase(join(mapDir, 'snapshots', current), { readonly: true });
      const meta = Object.fromEntries(snap.prepare('SELECT key, value FROM meta').all().map((m) => [String(m.key), String(m.value)]));
      snap.close();
      await conn.query(`UPDATE maps SET ark_map = ?, saved_at = ?, game_time = ?, save_count = ?, objects = ?, meta = ?, updated_at = ? WHERE name = ?`, [
        meta.map ?? null, datetime(meta.saved_at ?? null), Number(meta.game_time) || null, Number(meta.save_count) || null,
        Number(meta.rows) || null,
        JSON.stringify({ sections: JSON.parse(meta.sections ?? '[]'), issues: JSON.parse(meta.issues ?? '{}'), categories: JSON.parse(meta.categories ?? '{}'), exporter_version: meta.exporter_version }),
        datetime(new Date().toISOString()), map,
      ]);
    }
    const saves = await mirrorHistory(conn, mapDir, map, state.history_seq);
    const seconds = +((performance.now() - t0) / 1000).toFixed(2);
    log(`${map}: MySQL ${mode}${mode === 'unchanged' ? '' : ` (${upserted} written, ${deleted} deleted)`}, ${saves} history entries (${seconds} s)`);
    return { mode, upserted, deleted, saves, seconds };
  } finally {
    await conn.end();
  }
}
