// Runs only with ARK_EXPORT_TEST_MYSQL=mysql://user:pass@host:port (a server where the user may
// create and drop databases), e.g. a throwaway Docker container.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import mysql from 'mysql2/promise';
import { pruneSnapshots, updateHistory } from '../src/history.ts';
import { mirrorToMysql } from '../src/mysql.ts';
import { createSnapshot } from '../src/snapshot.ts';
import { Writer } from './build.ts';
import { profile, tribe, world } from './fixtures.ts';

const server = process.env.ARK_EXPORT_TEST_MYSQL;

test('MySQL mirror: full load, incremental update, history', { skip: !server && 'set ARK_EXPORT_TEST_MYSQL to run' }, async () => {
  const dbName = `ark_export_test_${process.pid}_${Date.now()}`;
  const admin = await mysql.createConnection({ uri: server });
  await admin.query(`CREATE DATABASE ${dbName} CHARACTER SET utf8mb4`);
  const url = `${server!.replace(/\/[^/]*$/, '')}/${dbName}`;
  const root = mkdtempSync(join(tmpdir(), 'ark-export-mysql-'));
  const log = () => {};
  try {
    const saves = join(root, 'srv', 'testPVE', 'ShooterGame', 'Saved', 'SavedArks');
    mkdirSync(saves, { recursive: true });
    writeFileSync(join(saves, '4242.arkprofile'), profile());
    writeFileSync(join(saves, '1234567.arktribe'), tribe());
    writeFileSync(join(saves, '1234567.arktributetribe'), new Writer(null).i32(1).i32(1234567).i32(0).i32(1).i32(1738805207).i32(0).toBuffer());
    const save = join(saves, 'TestMap.ark');
    const out = join(root, 'export');
    const mapDir = join(out, 'testPVE');
    const step = async (buf: Buffer, at: string) => {
      writeFileSync(save, buf);
      utimesSync(save, new Date(at), new Date(at));
      await createSnapshot({ save, out, name: 'testPVE', containers: true, log });
      await updateHistory(mapDir, log);
      const r = await mirrorToMysql(mapDir, 'testPVE', url, log);
      pruneSnapshots(mapDir, 2, log);
      return r;
    };

    const first = await step(world(), '2026-11-01T10:00:00Z');
    assert.equal(first?.mode, 'full');
    assert.equal(first?.upserted, 13);
    assert.equal(first?.saves, 1);

    const second = await step(world({ dinoAt: [9000, 2000, -50], stasisTime: 555, quantity: 3, withSecondStructure: false, extraStructure: true }), '2026-11-01T10:30:00Z');
    assert.equal(second?.mode, 'incremental');
    assert.equal(second?.deleted, 1, 'second storage box copy removed');
    // added: placeholder + wall; changed: dino (position, volatile time), item (quantity, spoil time)
    assert.equal(second?.upserted, 4);

    const again = await mirrorToMysql(mapDir, 'testPVE', url, log);
    assert.equal(again?.mode, 'unchanged');
    assert.equal(again?.saves, 0);

    const conn = await mysql.createConnection({ uri: url, dateStrings: true });
    try {
    const q = async (sql: string, params: unknown[] = []) => (await conn.query(sql, params))[0] as Record<string, unknown>[];
    assert.equal((await q('SELECT count(*) AS n FROM objects WHERE map = ?', ['testPVE']))[0].n, 14);
    const dino = (await q("SELECT x, name, tribe_name, JSON_EXTRACT(props, '$.LastEnterStasisTime') AS stasis, JSON_UNQUOTE(JSON_EXTRACT(props, '$.MyCharacterStatusComponent.\"$ref\"')) AS status FROM objects WHERE map = 'testPVE' AND `key` = 'dino:1:2'"))[0];
    assert.deepEqual({ ...dino, stasis: Number(dino.stasis) }, { x: 9000, name: 'Rexy ä中', tribe_name: null, stasis: 555, status: 'dino:1:2/DinoCharacterStatus_BP_Raptor_C_1' });
    assert.equal((await q("SELECT name FROM objects WHERE `key` = 'player:4242'"))[0].name, 'Tester');
    assert.equal((await q("SELECT tribe_name FROM objects WHERE `key` = 'actor:StorageBox_Large_C_3'"))[0].tribe_name, 'Tribe of Test');
    const history = await q('SELECT seq, baseline, added, removed, changed, moved, saved_at FROM saves ORDER BY seq');
    assert.deepEqual(history.map((h) => ({ ...h })), [
      { seq: 1, baseline: 1, added: 0, removed: 0, changed: 0, moved: 3, saved_at: '2026-11-01 10:00:00.000' },
      { seq: 2, baseline: 0, added: 2, removed: 1, changed: 1, moved: 1, saved_at: '2026-11-01 10:30:00.000' },
    ]);
    const change = (await q("SELECT JSON_EXTRACT(data, '$.ItemQuantity') AS q FROM changes WHERE kind = 'changed'"))[0];
    assert.deepEqual(typeof change.q === 'string' ? JSON.parse(change.q) : change.q, [1, 3]);
    assert.equal((await q('SELECT count(*) AS n FROM positions'))[0].n, 4);
    const map = (await q("SELECT ark_map, snapshot, history_seq, objects FROM maps WHERE name = 'testPVE'"))[0];
    assert.deepEqual({ ...map }, { ark_map: 'TestMap', snapshot: '2026-11-01T10-30-00Z.sqlite', history_seq: 2, objects: 14 });
    } finally {
      await conn.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
    rmSync(root, { recursive: true, force: true });
  }
});
