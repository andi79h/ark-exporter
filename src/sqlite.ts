// SQLite for both runtimes: bun:sqlite under Bun, node:sqlite (Node >= 22.13) under Node.
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface Statement {
  run(...params: SqlValue[]): void;
  all(...params: SqlValue[]): SqlRow[];
  iterate(...params: SqlValue[]): IterableIterator<SqlRow>;
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

interface NativeStatement {
  run(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  iterate(...params: SqlValue[]): IterableIterator<unknown>;
}
interface NativeDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): NativeStatement;
  close(): void;
}

function wrap(db: NativeDatabase): Database {
  return {
    exec: (sql) => { db.exec(sql); },
    prepare: (sql) => {
      const st = db.prepare(sql);
      return {
        run: (...p) => { st.run(...p); },
        all: (...p) => st.all(...p) as SqlRow[],
        iterate: (...p) => st.iterate(...p) as IterableIterator<SqlRow>,
      };
    },
    close: () => db.close(),
  };
}

export const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'bun' : 'node';

export async function openDatabase(path: string, options: { readonly?: boolean } = {}): Promise<Database> {
  if (runtime === 'bun') {
    const mod = await import('bun:sqlite' as string) as { Database: new (p: string, o: object) => NativeDatabase };
    return wrap(new mod.Database(path, options.readonly ? { readonly: true } : { create: true }));
  }
  const mod = await import('node:sqlite') as unknown as { DatabaseSync: new (p: string, o: object) => NativeDatabase };
  return wrap(new mod.DatabaseSync(path, { readOnly: options.readonly ?? false }));
}
