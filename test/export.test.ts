import assert from 'node:assert/strict';
import { mkdtempSync, readlinkSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listSnapshots, pruneSnapshots, updateHistory } from '../src/history.ts';
import { emitWorld, type EmitStats, KeyRegistry, type Row } from '../src/normalize.ts';
import { readSave } from '../src/savegame.ts';
import { createSnapshot, defaultName } from '../src/snapshot.ts';
import { openDatabase } from '../src/sqlite.ts';
import { buildEmbedded, buildSave, bytesArray, int, struct } from './build.ts';
import { profile, tribe, world } from './fixtures.ts';

function rows(buf: Buffer): Map<string, Row> {
  const out = new Map<string, Row>();
  const stats: EmitStats = { rows: 0, cryoArchives: 0, cryoObjects: 0, duplicateKeys: 0 };
  emitWorld(readSave(buf), new KeyRegistry(), (r) => out.set(r.key, r), stats);
  return out;
}

test('stable keys, owners and references', () => {
  const r = rows(world());
  assert.deepEqual([...r.keys()], [
    'dino:1:2',
    'dino:1:2/DinoCharacterStatus_BP_Raptor_C_1',
    'actor:StorageBox_Large_C_3',
    'actor:StorageBox_Large_C_3#2',
    'actor:StorageBox_Large_C_3/PrimalInventory_StorageBox_C_3',
    'item:7:8',
    'dino:9:10',
    'dino:9:10/DinoCharacterStatus_BP_Rex_C_5',
    'pawn:123456789012345678',
  ]);
  const dino = r.get('dino:1:2')!;
  assert.equal(dino.category, 'dino');
  assert.equal(dino.team, 1234567);
  const props = JSON.parse(dino.props);
  assert.deepEqual(props.MyCharacterStatusComponent, { $ref: 'dino:1:2/DinoCharacterStatus_BP_Raptor_C_1' });

  const item = r.get('item:7:8')!;
  assert.equal(item.owner, 'actor:StorageBox_Large_C_3', 'items belong to the actor carrying the inventory');
  const ip = JSON.parse(item.props);
  assert.deepEqual(ip.OwnerInventory, { $ref: 'actor:StorageBox_Large_C_3/PrimalInventory_StorageBox_C_3' });
  assert.deepEqual(ip.CustomItemDatas[0].CustomDataBytes.ByteArrays[0].Bytes, { $embedded: 2 });
  assert.deepEqual(ip.CustomItemDatas[0].CustomDataBytes.ByteArrays[1].Bytes, { $bytes: 'AQID' });

  const cryo = r.get('dino:9:10')!;
  assert.equal(cryo.source, 'cryo');
  assert.equal(cryo.container, 'item:7:8');
  assert.deepEqual(JSON.parse(cryo.props).MyCharacterStatusComponent, { $ref: 'dino:9:10/DinoCharacterStatus_BP_Rex_C_5' });
  assert.equal(r.get('dino:9:10/DinoCharacterStatus_BP_Rex_C_5')!.owner, 'dino:9:10');

  const pawn = r.get('pawn:123456789012345678')!;
  assert.equal(pawn.category, 'pawn');
  assert.ok(JSON.parse(pawn.extra!).vectors);
});

test('folder name from the installation path, else the map', () => {
  assert.equal(defaultName('/home/steam/server/islandPVE/ShooterGame/Saved/SavedArks/TheIsland.ark'), 'islandPVE');
  assert.equal(defaultName('C:\\ARK\\Ragnarok\\ShooterGame\\Saved\\SavedArks\\Ragnarok.ark'), 'Ragnarok');
  assert.equal(defaultName('/backups/Gen2.ark'), 'Gen2');
});

test('embedded copy with the same ID (Ferox other form) lives below its container', () => {
  const alt = buildEmbedded([
    { cls: 'Shapeshifter_Small_Character_BP_C', names: ['Shapeshifter_Small_Character_BP_C_3'], props: [int('DinoID1', 5), int('DinoID2', 6)] },
    { cls: 'DinoCharacterStatusComponent_BP_Shapeshifter_Small_C', names: ['Status_3', 'Shapeshifter_Small_Character_BP_C_3'], props: [] },
  ]);
  const r = rows(buildSave([{
    cls: 'Shapeshifter_Large_Character_BP_C', names: ['Shapeshifter_Large_Character_BP_C_1'], loc: [1, 2, 3],
    props: [int('DinoID1', 5), int('DinoID2', 6), struct('SmallsDinoData', 'ShapeshifterDinoData', [bytesArray('DinoData', alt)])],
  }]));
  assert.deepEqual([...r.keys()], [
    'dino:5:6',
    'dino:5:6/Shapeshifter_Small_Character_BP_C_3',
    'dino:5:6/Shapeshifter_Small_Character_BP_C_3/Status_3',
  ]);
});

test('volatile fields do not change the hash', () => {
  const a = rows(world());
  const b = rows(world({ stasisTime: 999 }));
  const c = rows(world({ quantity: 5 }));
  assert.equal(a.get('dino:1:2')!.hash, b.get('dino:1:2')!.hash);
  assert.notEqual(a.get('dino:1:2')!.props, b.get('dino:1:2')!.props, 'but the value is still stored');
  assert.equal(JSON.parse(b.get('dino:1:2')!.props).LastEnterStasisTime, 999);
  assert.notEqual(a.get('item:7:8')!.hash, c.get('item:7:8')!.hash);
});

test('snapshot, history and pruning end to end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ark-export-'));
  try {
    const saves = join(root, 'server', 'testPVE', 'ShooterGame', 'Saved', 'SavedArks');
    mkdirSync(saves, { recursive: true });
    writeFileSync(join(saves, '4242.arkprofile'), profile());
    writeFileSync(join(saves, '1234567.arktribe'), tribe());
    const save = join(saves, 'TestMap.ark');
    const out = join(root, 'export');
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);

    writeFileSync(save, world());
    utimesSync(save, new Date('2026-11-01T10:00:00Z'), new Date('2026-11-01T10:00:00Z'));
    const first = await createSnapshot({ save, out, name: 'testPVE', containers: true, log });
    assert.equal(first.rows, 9 + 3);
    const base = await updateHistory(join(out, 'testPVE'), log);
    assert.ok(base?.baseline);
    assert.equal(base?.moved, 3, 'baseline positions of 2 dinos and 1 player');

    writeFileSync(save, world({ dinoAt: [9000, 2000, -50], stasisTime: 555, quantity: 3, withSecondStructure: false, extraStructure: true }));
    utimesSync(save, new Date('2026-11-01T10:30:00Z'), new Date('2026-11-01T10:30:00Z'));
    const second = await createSnapshot({ save, out, name: 'testPVE', containers: true, log });
    assert.equal(readlinkSync(join(out, 'testPVE', 'latest.sqlite')), join('snapshots', '2026-11-01T10-30-00Z.sqlite'));
    const again = await createSnapshot({ save, out, name: 'testPVE', containers: true, log });
    assert.ok(again.skipped);
    assert.equal(second.rows, 10 + 3);

    // Dino moved (position only, stasis time is volatile), item quantity changed, the second copy
    // of the storage box is gone, two objects are new.
    const h = await updateHistory(join(out, 'testPVE'), log);
    assert.deepEqual({ added: h?.added, removed: h?.removed, changed: h?.changed, moved: h?.moved },
      { added: 2, removed: 1, changed: 1, moved: 1 });

    const db = await openDatabase(join(out, 'testPVE', 'history.sqlite'), { readonly: true });
    const changes = db.prepare('SELECT key, kind, data FROM changes ORDER BY kind, key').all();
    const moved = db.prepare('SELECT key, x FROM positions WHERE save_id = 2').all().map((r) => ({ ...r }));
    db.close();
    assert.deepEqual(changes.map((c) => `${c.kind} ${c.key}`), [
      'added actor:Placeholder_C_1', 'added actor:Wall_Wood_C_99', 'changed item:7:8', 'removed actor:StorageBox_Large_C_3#2',
    ]);
    assert.deepEqual(JSON.parse(String(changes.find((c) => c.kind === 'changed')!.data)), { ItemQuantity: [1, 3] });
    assert.deepEqual(moved, [{ key: 'dino:1:2', x: 9000 }]);

    const snap = await openDatabase(join(out, 'testPVE', 'latest.sqlite'), { readonly: true });
    const player = snap.prepare("SELECT key, category, team FROM objects WHERE source = 'profile' ORDER BY key").all().map((r) => ({ ...r }));
    const meta = Object.fromEntries(snap.prepare('SELECT key, value FROM meta').all().map((m) => [m.key, m.value]));
    snap.close();
    assert.deepEqual(player, [
      { key: 'player:4242', category: 'player', team: 1234567 },
      { key: 'player:4242/PrimalBuffPersistentData_3', category: 'player-data', team: 1234567 },
    ]);
    assert.equal(meta.map, 'TestMap');
    assert.deepEqual(JSON.parse(String(meta.issues)), { 'unknown property type FancyProperty': 1 });

    pruneSnapshots(join(out, 'testPVE'), 1, log);
    assert.deepEqual(listSnapshots(join(out, 'testPVE')), ['2026-11-01T10-30-00Z.sqlite']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
