import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAsaContainer, enableAsaBytes } from '../src/asa/container.ts';
import { newCryoCoverage, pack, unpack } from '../src/asa/cryopod.ts';
import { inspectAsa, isAsaContainer, isAsaWorld } from '../src/asa/inspect.ts';
import { asaCoverage, quatToRotator, readAsaSave } from '../src/asa/savegame.ts';
import { Blob, Embedded, GuidRef, PathRef, ReadContext } from '../src/types.ts';
import {
  aArchivePath, aBool, aByte, aBytes, aCryoItemData, aDouble, aEnum, aFloat, aInt, aIntArray, aMapNameInt, aName, aPath,
  aRef, aSoft, aStr, aStruct, aStructArray, aStructArrayLegacy, aU64, aUnknown, aVector, asaContainer, cryoBytes,
  itemArchiveBytes, props55, templateBytes, writeAsaWorld,
} from './asa-build.ts';

const DINO = 'a1'.repeat(16);
const STATUS = 'b2'.repeat(16);
const POD = 'c3'.repeat(16);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ark-asa-test-'));
}

test('cryopod packing: unpack(pack(x)) === x, escapes and zero runs', () => {
  const src = Buffer.from([0, 0, 0, 0, 1, 0xf0, 0xff, 0, 2, ...new Array(30).fill(0), 0xf5, 7]);
  assert.deepEqual(unpack(pack(src)), src);
  // 0xF1 n and 0xFF a b forms written by the game
  assert.deepEqual(unpack(Buffer.from([0xf1, 0x3a])), Buffer.from([0xf3, 0xfa]));
  assert.deepEqual(unpack(Buffer.from([0xff, 5, 6])), Buffer.from([0, 0, 0, 5, 0, 0, 0, 6, 0, 0, 0]));
  assert.deepEqual(unpack(Buffer.from([0xf4, 9])), Buffer.from([0, 0, 0, 0, 9]));
});

async function v14World(path: string): Promise<void> {
  const cryo = cryoBytes([
    { guid: 'd4'.repeat(16), cls: 'Dodo_Character_BP_C', names: ['Dodo_Character_BP_C_1'], props: [
      aStr('TamedName', 'Pod Dodo'), aInt('TargetingTeam', 1234567), aBool('bIsFemale', true),
      aDouble('ExperiencePoints', 512.25), aName('DinoNameTag', 'Dodo'),
    ] },
    { guid: 'e5'.repeat(16), cls: 'DinoCharacterStatusComponent_BP_C', names: ['Status_1'], props: [
      aIntArray('NumberOfLevelUpPointsApplied', [1, 2, 3]),
    ] },
  ]);
  const saddle = itemArchiveBytes([aInt('ItemQuantity', 1), aArchivePath('ItemArchetype', '/Game/Saddle.Saddle_C')]);
  await writeAsaWorld(path, {
    objects: [
      {
        guid: DINO, cls: '/Game/PrimalEarth/Dinos/Raptor/Raptor_Character_BP.Raptor_Character_BP_C',
        names: ['Raptor_Character_BP_C_2147'], loc: [1000, -2000, 50.5], props: [
          aStr('TamedName', 'Rexy ä中'), aBool('bIsFemale', true), aBool('bIsBaby', false),
          aInt('ColorSetIndices', 3, 1), aInt('ColorSetIndices', 7, 2), aFloat('Health', 1.5),
          aU64('DinoID', 18446744073709551615n), aVector('SavedBaseWorldLocation', 1.25, -2, 3e10),
          aRef('MyCharacterStatusComponent', STATUS), aPath('ItemArchetype', '/Game/Something.Something_C'),
          aEnum('TamingState', 'ETamingState', 'ETamingState::Tamed'), aByte('Mood', 4),
          aSoft('SoftClass', '/Game/Soft.Soft_C'),
          aStruct('Inner', 'MyStruct', [aInt('A', 1), aStr('B', 'x')]),
          aStructArray('Points', 'MyPoint', [[aInt('P', 1)], [aInt('P', 2)]]),
          aMapNameInt('Counts', [['Rex', 3], ['Dodo', 9]]),
        ],
      },
      { guid: STATUS, cls: 'DinoCharacterStatusComponent_BP_C', names: ['Status_C_1', 'Raptor_Character_BP_C_2147'], props: [aInt('BaseCharacterLevel', 150)] },
      {
        guid: POD, cls: 'PrimalItem_WeaponEmptyCryopod_C', names: ['PrimalItem_WeaponEmptyCryopod_C_9'],
        props: [aCryoItemData([cryo, saddle])],
      },
    ],
  });
}

test('ASA v14 world save: every payload byte accounted for, values decoded', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'TestMap_WP.ark');
    await v14World(path);
    assert.ok(isAsaWorld(path));
    const s = await readAsaSave(path, { keepObjects: true });
    assert.equal(s.version, 14);
    assert.equal(s.gameTime, 12345.5);
    assert.deepEqual(s.headerUnknown, [0, 1, 3]);
    assert.deepEqual(s.parts, ['TestMap_WP', 'TestMap_Sublevel']);
    assert.deepEqual(s.otherTable, [{ id: 77, name: 'Watervein_Base_BP_C' }]);
    assert.equal(s.objectCount, 3);
    assert.equal(s.transforms, 1);
    assert.equal(s.sections.reduce((a, x) => a + x.bytes, 0), s.payloadBytes);
    assert.ok(s.sections.every((x) => x.decoded), JSON.stringify(s.sections));
    assert.deepEqual([...s.ctx.issues], []);
    assert.deepEqual([...s.ctx.rawBytes], []);
    assert.equal(asaCoverage(s).percent, 100);

    const dino = s.objects.find((o) => o.guid === DINO)!;
    assert.equal(dino.cls, 'Raptor_Character_BP_C');
    assert.equal(dino.clsPath, '/Game/PrimalEarth/Dinos/Raptor/Raptor_Character_BP.Raptor_Character_BP_C');
    assert.deepEqual(dino.names, ['Raptor_Character_BP_C_2147']);
    const loc = dino.loc!;
    assert.deepEqual([loc.x, loc.y, loc.z, loc.pitch, loc.roll], [1000, -2000, 50.5, 0, 0]);
    assert.ok(Math.abs(Number(loc.yaw) - 90) < 1e-9, String(loc.yaw));
    const p = dino.props;
    assert.equal(p.TamedName, 'Rexy ä中');
    assert.equal(p.bIsFemale, true);
    assert.equal(p.bIsBaby, false);
    assert.equal(p['ColorSetIndices[1]'], 3);
    assert.equal(p['ColorSetIndices[2]'], 7);
    assert.equal(p.Health, 1.5);
    assert.equal(p.DinoID, '18446744073709551615');
    assert.deepEqual(p.SavedBaseWorldLocation, { x: 1.25, y: -2, z: 3e10 });
    assert.ok(p.MyCharacterStatusComponent instanceof GuidRef);
    assert.equal((p.MyCharacterStatusComponent as GuidRef).guid, STATUS);
    assert.ok(p.ItemArchetype instanceof PathRef);
    assert.equal((p.ItemArchetype as PathRef).path, '/Game/Something.Something_C');
    assert.equal(p.TamingState, 'ETamingState::Tamed');
    assert.equal(p.Mood, 4);
    assert.deepEqual(p.SoftClass, { $soft: ['/Game/Soft.Soft_C'] });
    assert.deepEqual(p.Inner, { A: 1, B: 'x' });
    assert.deepEqual(p.Points, [{ P: 1 }, { P: 2 }]);
    assert.deepEqual(p.Counts, [{ key: 'Rex', value: 3 }, { key: 'Dodo', value: 9 }]);

    const pod = s.objects.find((o) => o.guid === POD)!;
    const arrays = ((pod.props.CustomItemDatas as Record<string, unknown>[])[0].CustomDataBytes as Record<string, unknown>).ByteArrays as Record<string, unknown>[];
    const creature = arrays[0].Bytes as Embedded;
    assert.ok(creature instanceof Embedded);
    assert.equal(creature.objects.length, 2);
    assert.equal(creature.objects[0].cls, 'Dodo_Character_BP_C');
    assert.deepEqual(creature.objects[0].props, {
      TamedName: 'Pod Dodo', TargetingTeam: 1234567, bIsFemale: true, ExperiencePoints: 512.25, DinoNameTag: 'Dodo',
    });
    assert.deepEqual(creature.objects[1].props, { NumberOfLevelUpPointsApplied: [1, 2, 3] });
    const saddle = arrays[1].Bytes as { $properties: Record<string, unknown>; version: number };
    assert.equal(saddle.version, 7);
    assert.equal(saddle.$properties.ItemQuantity, 1);
    assert.equal((saddle.$properties.ItemArchetype as PathRef).path, '/Game/Saddle.Saddle_C');
    assert.deepEqual(s.cryo, { found: 1, decoded: 1, partial: 0, failed: 0, saddles: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ASA v13 world save: older property tags', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'Old_WP.ark');
    await writeAsaWorld(path, {
      version: 13,
      objects: [{
        guid: DINO, cls: 'Raptor_Character_BP_C', names: ['Raptor_1'], props: [
          aStr('TamedName', 'Old'), aBool('bIsFemale', true), aInt('ColorSetIndices', 5, 3),
          aVector('Loc', 1, 2, 3), aStruct('Inner', 'MyStruct', [aInt('A', 1)], true),
          aStructArrayLegacy('Points', 'MyPoint', [[aInt('P', 1)], [aInt('P', 2)]]),
          aEnum('TamingState', 'ETamingState', 'ETamingState::Wild'), aMapNameInt('Counts', [['Rex', 3]]),
          aRef('Status', STATUS),
        ],
      }],
    });
    const s = await readAsaSave(path, { keepObjects: true });
    assert.equal(s.version, 13);
    assert.deepEqual(s.headerUnknown, [3]);
    assert.deepEqual([...s.ctx.issues], []);
    assert.equal(asaCoverage(s).percent, 100);
    const p = s.objects[0].props;
    assert.equal(p.TamedName, 'Old');
    assert.equal(p.bIsFemale, true);
    assert.equal(p['ColorSetIndices[3]'], 5);
    assert.deepEqual(p.Loc, { x: 1, y: 2, z: 3 });
    assert.deepEqual(p.Inner, { A: 1 });
    assert.deepEqual(p.Points, [{ P: 1 }, { P: 2 }]);
    assert.equal(p.TamingState, 'ETamingState::Wild');
    assert.deepEqual(p.Counts, [{ key: 'Rex', value: 3 }]);
    assert.equal((p.Status as GuidRef).guid, STATUS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ASA: unknown types, raw tails, unknown keys and tables are counted, reading goes on', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'Odd_WP.ark');
    await writeAsaWorld(path, {
      objects: [{
        guid: DINO, cls: 'Raptor_Character_BP_C', names: ['Raptor_1'],
        props: [aInt('Before', 1), aUnknown('Mystery', Buffer.from('abcdefgh')), aInt('After', 2)],
        tail: Buffer.from([9, 9, 9, 9, 9]),
      }],
      extraCustom: { SomethingNew: Buffer.alloc(40, 1) },
      extraTable: true,
    });
    const s = await readAsaSave(path, { keepObjects: true });
    const o = s.objects[0];
    assert.equal(o.props.Before, 1);
    assert.equal(o.props.After, 2);
    assert.ok(o.props.Mystery instanceof Blob);
    assert.equal(s.sections.reduce((a, x) => a + x.bytes, 0), s.payloadBytes);
    const issues = Object.fromEntries(s.ctx.issues);
    assert.equal(issues['unreadable FancyNewProperty: unknown property type FancyNewProperty'], 1);
    assert.equal(issues['game: raw data after properties (Raptor_Character_BP_C)'], 1);
    assert.equal(issues['custom: unknown key SomethingNew'], 1);
    assert.equal(issues['unknown table notes'], 1);
    const raw = Object.fromEntries(s.sections.filter((x) => !x.decoded).map((x) => [x.name, x.bytes]));
    assert.equal(raw['game: data after property lists (raw)'], 5);
    assert.equal(raw['custom: SomethingNew (raw)'], 40);
    assert.equal(raw['table notes (raw)'], 6);
    const cov = asaCoverage(s);
    assert.equal(cov.rawInside, 8);
    assert.ok(cov.percent < 100 && cov.percent > 50, String(cov.percent));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ASA profile (archive version 7): decoded completely', () => {
  const buf = asaContainer([{
    guid: 'f6'.repeat(16), cls: 'PrimalPlayerDataBP_C', names: ['PrimalPlayerDataBP_C_1'], props: [
      aStruct('MyData', 'PrimalPlayerDataStruct', [
        aStr('PlayerName', 'Spieler'), aU64('PlayerDataID', 123456789012345n), aIntArray('Stats', [1, 2]),
        aBytes('Blob', Buffer.from([1, 2, 3])),
      ]),
    ],
  }]);
  assert.ok(isAsaContainer(buf));
  const ctx = new ReadContext();
  enableAsaBytes(ctx, newCryoCoverage());
  const c = readAsaContainer(buf, ctx);
  assert.equal(c.version, 7);
  assert.equal(c.decoded, buf.length);
  const data = c.objects[0].props.MyData as Record<string, unknown>;
  assert.equal(data.PlayerName, 'Spieler');
  assert.equal(data.PlayerDataID, '123456789012345');
  assert.deepEqual(data.Stats, [1, 2]);
  assert.ok(data.Blob instanceof Blob);
});

test('inspect: ASA report with containers in the same folder', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'TestMap_WP.ark');
    await v14World(path);
    writeFileSync(join(dir, '123.arkprofile'), asaContainer([{ guid: 'f6'.repeat(16), cls: 'PrimalPlayerDataBP_C', names: [], props: [aInt('X', 1)] }]));
    writeFileSync(join(dir, '456.arktribe'), Buffer.from('not an archive at all, really not'));
    const r = await inspectAsa(path);
    assert.equal(r.format, 'ASA');
    assert.equal(r.version, 14);
    assert.equal(r.objects, 3);
    assert.equal(r.decodedPercent, 100);
    const c = r.containers as { files: number; failed: unknown[]; versions: Record<string, number> };
    assert.equal(c.files, 2);
    assert.equal(c.failed.length, 1);
    assert.deepEqual(c.versions, { 7: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quaternion to rotator like Unreal', () => {
  const r = (pitch: number, yaw: number, roll: number) => {
    // Unreal FRotator::Quaternion()
    const d = Math.PI / 360;
    const sp = Math.sin(pitch * d), cp = Math.cos(pitch * d), sy = Math.sin(yaw * d), cy = Math.cos(yaw * d);
    const sr = Math.sin(roll * d), cr = Math.cos(roll * d);
    return [cr * sp * sy - sr * cp * cy, -cr * sp * cy - sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy] as const;
  };
  for (const [p, y, ro] of [[0, 0, 0], [10, 20, 30], [-45, 170, -100], [80, -90, 5]]) {
    const q = r(p, y, ro);
    const back = quatToRotator(...q);
    assert.ok(Math.abs(back.pitch - p) < 1e-9 && Math.abs(back.yaw - y) < 1e-9 && Math.abs(back.roll - ro) < 1e-9, JSON.stringify([p, y, ro, back]));
  }
});

test('ASA foliage actor: sub-objects with harvest bits are decoded', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'Fol_WP.ark');
    const entry = (w: import('./build.ts').Writer, name: string) => {
      w.i32(1).string(name).u8(0);
      props55(w, [aIntArray('InstancesVisibility', [-1, 5]), aBool('bReplicateThisComponent', true)]);
      w.i32(0).i32(0);
    };
    await writeAsaWorld(path, {
      objects: [{
        guid: DINO, cls: '/Script/Foliage.InstancedFoliageActor', names: ['InstancedFoliageActor_1'], props: [],
        tailWriter: (w) => { w.i32(2); entry(w, 'Rock_A_FoliageType'); entry(w, 'Tree_B_FoliageType'); },
      }],
    });
    const s = await readAsaSave(path, { keepObjects: true });
    assert.deepEqual([...s.ctx.issues], []);
    assert.equal(asaCoverage(s).percent, 100);
    const fol = (s.objects[0].extra as { native: { foliage: { name: string; props: Record<string, unknown> }[] } }).native.foliage;
    assert.deepEqual(fol.map((f) => f.name), ['Rock_A_FoliageType', 'Tree_B_FoliageType']);
    assert.deepEqual(fol[0].props, { InstancesVisibility: [-1, 5], bReplicateThisComponent: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ASA: mission scores, object ends and an empty save', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'Gen_WP.ark');
    const { Writer } = await import('./build.ts');
    let scores: Buffer | null = null;
    await writeAsaWorld(path, {
      objects: [
        { guid: DINO, cls: 'Rex_Character_BP_C', names: ['Rex_1'], props: [aInt('A', 1)], tail: Buffer.from([1, 0, 0, 0]) },
        { guid: STATUS, cls: 'MaterialInstanceConstant', names: ['M_1'], props: [], tail: Buffer.alloc(8) },
      ],
      // the name table is shared, so the mission board is written with the same writer table
      customWriter: (table) => {
        const w = new Writer(table);
        w.bytes(Buffer.alloc(20)).i32(1).name('MissionType_Race_C').i32(1);
        w.name('MissionType_Race_C').string('0002abc').u32(7).f64(1785007794.5).f32(128.25).i32(1).name('None').string('Spieler');
        w.i32(0);
        scores = w.toBuffer();
        return { GameModeCustomBytes: scores };
      },
    });
    const s = await readAsaSave(path, { keepObjects: true });
    assert.deepEqual([...s.ctx.issues], []);
    assert.equal(asaCoverage(s).percent, 100);
    assert.equal(s.missions.length, 1);
    assert.deepEqual(s.missions[0], { mission: 'MissionType_Race_C', scores: [{
      playerId: '0002abc', playerName: 'Spieler', time: 1785007794.5, score: 128.25, value1: 7, value2: 1, tag: 'None',
    }] });
    assert.ok(scores);

    const empty = join(dir, 'Empty_WP.ark');
    const { openDatabase } = await import('../src/sqlite.ts');
    const db = await openDatabase(empty);
    db.exec('CREATE TABLE game (key BLOB PRIMARY KEY, value BLOB); CREATE TABLE custom (key TEXT PRIMARY KEY, value BLOB)');
    db.close();
    const e = await readAsaSave(empty);
    assert.equal(e.version, 0);
    assert.deepEqual([...e.ctx.issues], [['empty save: no rows in any table', 1]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ASA: structure templates, bunker cells and byte lists are decoded', async () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'Tpl_WP.ark');
    const tablet = templateBytes({
      author: 'Builder', name: 'Small Hut', description: 'Two parts',
      classes: ['/Game/S/Floor_Metal.Floor_Metal_C', '/Game/S/Skin_Wasteland.Skin_Wasteland_C'],
      structures: [
        { cls: 0, loc: [-750, -600, 40], rot: [0, 0, 0] },
        { cls: 0, skin: 1, loc: [-450, -600, 40], rot: [0, 90, 0], flag: 1 },
      ],
      header: [0, 0],
    });
    const cell = (x: number, y: number, z: number) => [aBytes('Bytes_3_00112233445566778899AABBCCDDEEFF', Buffer.from([x, y, z]))];
    await writeAsaWorld(path, {
      objects: [
        { guid: POD, cls: '/Game/I/PrimalItem_TemplateTablet.PrimalItem_TemplateTablet_C', names: ['Tablet_1'], props: [aCryoItemData([tablet])] },
        {
          guid: DINO, cls: '/Game/B/BP_Bunker_Base.BP_Bunker_Base_C', names: ['Bunker_1'],
          props: [aStructArray('AvailableLocationsBytes', 'BunkerCell', [cell(4, 4, 7), cell(3, 3, 7)])],
        },
        { guid: STATUS, cls: '/Game/S/SloopShipBP.SloopShipBP_C', names: ['Sloop_1'], props: [aBytes('UnlockedShipSkillRanks', Buffer.from([3, 1]))] },
      ],
    });
    const s = await readAsaSave(path, { keepObjects: true });
    assert.deepEqual([...s.ctx.issues], []);
    assert.deepEqual([...s.ctx.rawBytes].filter(([, v]) => v > 0), []);
    assert.equal(asaCoverage(s).percent, 100);
    const t = (s.objects[0].props.CustomItemDatas as any)[0].CustomDataBytes.ByteArrays[0].Bytes;
    assert.equal(t.$template, 1);
    assert.equal(t.name, 'Small Hut');
    assert.deepEqual(t.header, [0, 0]);
    assert.equal(t.structures.length, 2);
    assert.deepEqual(t.structures[1], { class: 0, skin: 1, x: -450, y: -600, z: 40, pitch: 0, yaw: 90, roll: 0, flag: 1, name: 'None' });
    const cells = (s.objects[1].props.AvailableLocationsBytes as any[]).map((c) => c.Bytes_3_00112233445566778899AABBCCDDEEFF);
    assert.deepEqual(cells, [{ x: 4, y: 4, z: 7 }, { x: 3, y: 3, z: 7 }]);
    assert.deepEqual(s.objects[2].props.UnlockedShipSkillRanks, [3, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
