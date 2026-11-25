// Small SQL layer for the manager: the same queries run on MySQL (5.7 or newer) and SQLite.
// Placeholders are "?"; upserts and DDL differ per dialect and are built here.
import { openDatabase, type Database, type SqlValue } from '../sqlite.ts';

export type Dialect = 'mysql' | 'sqlite';
export type Row = Record<string, unknown>;
export type Param = string | number | bigint | null;

export interface Db {
  readonly dialect: Dialect;
  all<T = Row>(sql: string, params?: Param[]): Promise<T[]>;
  get<T = Row>(sql: string, params?: Param[]): Promise<T | undefined>;
  /** Runs a statement; returns the auto-increment id of an INSERT (0 otherwise) and the changed rows. */
  run(sql: string, params?: Param[]): Promise<{ id: number; changes: number }>;
  close(): Promise<void>;
}

class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }
  async all<T>(sql: string, params: Param[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as SqlValue[])) as T[];
  }
  async get<T>(sql: string, params: Param[] = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }
  async run(sql: string, params: Param[] = []): Promise<{ id: number; changes: number }> {
    this.db.prepare(sql).run(...(params as SqlValue[]));
    const r = this.db.prepare('SELECT last_insert_rowid() AS id, changes() AS n').all()[0] as { id: number | bigint; n: number | bigint };
    return { id: Number(r.id), changes: Number(r.n) };
  }
  async close(): Promise<void> { this.db.close(); }
}

interface MysqlPool {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

class MysqlDb implements Db {
  readonly dialect = 'mysql' as const;
  private readonly pool: MysqlPool;
  constructor(pool: MysqlPool) { this.pool = pool; }
  async all<T>(sql: string, params: Param[] = []): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params);
    return rows as T[];
  }
  async get<T>(sql: string, params: Param[] = []): Promise<T | undefined> {
    return (await this.all<T>(sql, params))[0];
  }
  async run(sql: string, params: Param[] = []): Promise<{ id: number; changes: number }> {
    const [res] = await this.pool.query(sql, params);
    const r = res as { insertId?: number; affectedRows?: number };
    return { id: Number(r.insertId ?? 0), changes: Number(r.affectedRows ?? 0) };
  }
  async close(): Promise<void> { await this.pool.end(); }
}

/** Opens "mysql://user:pass@host/db" or "sqlite:/path/file.sqlite" (also a plain path ending in .sqlite). */
export async function openDb(url: string): Promise<Db> {
  if (url.startsWith('mysql://')) {
    const mysql = (await import('mysql2/promise')).default;
    const pool = mysql.createPool({
      uri: url, charset: 'utf8mb4', timezone: 'Z', supportBigNumbers: true, bigNumberStrings: false,
      connectionLimit: 4, waitForConnections: true, enableKeepAlive: true,
    });
    pool.on('connection', (conn) => {
      conn.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION', time_zone = '+00:00'");
    });
    return new MysqlDb(pool as unknown as MysqlPool);
  }
  const path = url.replace(/^sqlite:/, '');
  const db = await openDatabase(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  return new SqliteDb(db);
}

/** Column types per dialect; `{{name}}` placeholders in DDL. */
const TYPES: Record<Dialect, Record<string, string>> = {
  mysql: {
    id: 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY',
    ts: 'BIGINT',
    sid: 'VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin',
    name: 'VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
    short: 'VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
    text: 'TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
    json: 'MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
    int: 'INT',
    table: 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  },
  sqlite: {
    id: 'INTEGER PRIMARY KEY AUTOINCREMENT',
    ts: 'INTEGER',
    sid: 'TEXT',
    name: 'TEXT COLLATE NOCASE',
    short: 'TEXT',
    text: 'TEXT',
    json: 'TEXT',
    int: 'INTEGER',
    table: '',
  },
};

export function ddl(dialect: Dialect, sql: string): string {
  return sql.replace(/\{\{(\w+)\}\}/g, (_, t: string) => {
    const v = TYPES[dialect][t];
    if (v === undefined) throw new Error(`unknown DDL type ${t}`);
    return v;
  });
}

/** INSERT … ON DUPLICATE KEY UPDATE / ON CONFLICT DO UPDATE. `update` maps column → SQL expression using `new.<col>`. */
export function upsertSql(dialect: Dialect, table: string, cols: string[], keys: string[], update: Record<string, string>): string {
  const head = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const sets = Object.entries(update);
  if (dialect === 'mysql') {
    if (!sets.length) return head.replace('INSERT', 'INSERT IGNORE');
    return `${head} ON DUPLICATE KEY UPDATE ${sets.map(([c, e]) => `${c} = ${e.replace(/\bnew\.(\w+)/g, 'VALUES($1)').replace(/\bold\.(\w+)/g, '$1')}`).join(', ')}`;
  }
  if (!sets.length) return `${head} ON CONFLICT(${keys.join(', ')}) DO NOTHING`;
  return `${head} ON CONFLICT(${keys.join(', ')}) DO UPDATE SET ${sets.map(([c, e]) => `${c} = ${e.replace(/\bnew\.(\w+)/g, 'excluded.$1').replace(/\bold\.(\w+)/g, `${table}.$1`)}`).join(', ')}`;
}

/** Creates tables and indexes that do not exist yet. Index statements are tolerated when they exist already. */
export async function applySchema(db: Db, statements: string[]): Promise<void> {
  for (const raw of statements) {
    const sql = ddl(db.dialect, raw);
    try {
      await db.run(sql);
    } catch (err) {
      const msg = (err as Error).message;
      if (/Duplicate key name|already exists/i.test(msg)) continue;
      throw err;
    }
  }
}
