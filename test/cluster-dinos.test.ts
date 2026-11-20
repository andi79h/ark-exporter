// Creatures in cluster files: listing sources, adding uploads, copying souls/cryopods, the CLI.
// All files are synthetic (test/build.ts); real cluster files hold SteamIDs and names.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clusterEntries, readCluster, readClusterTree, writeClusterTree } from '../src/cluster.ts';
import {
  addDino, copyItem, creatureBlueprint, creatureId, creaturesInCluster, creaturesInSave, dinoStatTexts, readCreatureArchive,
  recolorDino,
} from '../src/cluster-dinos.ts';
import { colorName, storedColorSetName } from '../src/colors.ts';
import { findProperty, type Property, sameValue } from '../src/tree.ts';
import {
  buildContainer, buildEmbedded, buildSave, bytesArray, float, int, path, type Prop, str, struct, structArray, u64,
} from './build.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const RAPTOR = '/Game/PrimalEarth/Dinos/Raptor/Raptor_Character_BP.Raptor_Character_BP';
const REX = '/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP';
const SOUL = 'BlueprintGeneratedClass /Game/Mods/DinoStorage2/SoulTrap_DS.SoulTrap_DS_C';
const PLAYER = '76561190000000001';
const OTHER = '76561190000000002';

const u32 = (name: string, v: number): Prop => ({ name, type: 'UInt32Property', value: (w) => w.u32(v) });
const u16 = (name: string, v: number): Prop => ({ name, type: 'UInt16Property', value: (w) => w.bytes(Buffer.from([v & 0xff, v >> 8])) });
const byte = (name: string, v: number, index = 0): Prop => ({ name, type: 'ByteProperty', index, inner: 'None', value: (w) => w.u8(v) });
const ref = (name: string, index: number): Prop => ({ name, type: 'ObjectProperty', value: (w) => w.i32(0).i32(index) });
const strings = (name: string, list: string[]): Prop => ({
  name, type: 'ArrayProperty', inner: 'StrProperty', value: (w) => { w.i32(list.length); for (const s of list) w.string(s); },
});
const paths = (name: string, list: string[]): Prop => ({
  name, type: 'ArrayProperty', inner: 'ObjectProperty', value: (w) => { w.i32(list.length); for (const s of list) w.i32(1).name(s); },
});

/** A creature archive like DinoData: creature, status component, inventory component. */
function creature(cls: string, id: [number, number], o: { name?: string; team?: number; colorProps?: Prop[] } = {}): Buffer {
  const actor = `${cls}_7`;
  return buildEmbedded([
    {
      cls, names: [actor, 'PersistentLevel', 'TheIsland'], loc: [1, 2, 3],
      props: [
        ...(o.name ? [str('TamedName', o.name)] : []),
        str('TamerString', 'Stamm'), byte('ColorSetIndices', 36), ...(o.colorProps ?? []), u32('DinoID1', id[0]), u32('DinoID2', id[1]),
        ref('MyCharacterStatusComponent', 1), ref('MyInventoryComponent', 2), int('TargetingTeam', o.team ?? 1_500_000_000),
      ],
      extra: Buffer.from('0000000001000000', 'hex'),
    },
    {
      cls: 'DinoCharacterStatusComponent_BP_C', names: ['DinoCharacterStatus_BP_C1', actor, 'PersistentLevel', 'TheIsland'],
      props: [
        float('MaxStatusValues', 2572.1), float('MaxStatusValues', 4520.5, 2), float('MaxStatusValues', 0.7221, 8),
        byte('NumberOfLevelUpPointsApplied', 6), int('BaseCharacterLevel', 22), u16('ExtraCharacterLevel', 42),
        float('ExperiencePoints', 14439.5), float('CurrentStatusValues', 2572.1), float('CurrentStatusValues', 95.8, 5),
        float('CurrentStatusValues', 0.7221, 8),
      ],
      extra: Buffer.alloc(4),
    },
    { cls: 'DinoTamedInventoryComponent_C', names: ['DinoTamedInventoryComponent_C_1', actor, 'PersistentLevel', 'TheIsland'], props: [], extra: Buffer.alloc(4) },
  ]);
}

const RAPTOR_ID: [number, number] = [11, 22];
const REX_ID: [number, number] = [123456789, 987654321];

const upload = (data: Buffer, id: [number, number]): Prop[] => [
  str('DinoClassName', `Blueprint'${RAPTOR}'`), path('DinoClass', `BlueprintGeneratedClass ${RAPTOR}_C`), bytesArray('DinoData', data),
  str('DinoName', 'Clever - Lvl 64 (Raptor)'), str('DinoNameInMap', 'Raptor_Character_BP_C_7'),
  ...Array.from({ length: 12 }, (_, i) => ({ ...str('DinoStats', `Stat ${i}`), index: i })),
  float('DinoExperiencePoints', 14439.5), float('Version', 2), u32('DinoID1', id[0]), u32('DinoID2', id[1]), int('UploadTime', 1_500_000_000),
];

/** A filled Dino Storage soul: the creature in ByteArrays[0], its IDs and the owner's SteamID as text. */
function soul(data: Buffer, id: [number, number], steamId: string): Prop[] {
  const info = [
    path('ItemArchetype', SOUL),
    struct('ItemId', 'ItemNetID', [u32('ItemID1', 500), u32('ItemID2', 600)]),
    u32('ItemQuantity', 0), str('CustomItemName', 'Rex Male (Lvl 64 Rexi)'),
    structArray('CustomItemDatas', [
      [{ name: 'CustomDataName', type: 'NameProperty', value: (w) => w.string('Settings') }, strings('CustomDataStrings', ['0', '0'])],
      [
        { name: 'CustomDataName', type: 'NameProperty', value: (w) => w.string('Dino') },
        strings('CustomDataStrings', ['Rex_Character_BP_C_7', 'Rexi - Lvl 64 (Rex)', '0', steamId, REX, `${id[0]} ${id[1]}`]),
        paths('CustomDataClasses', []),
        struct('CustomDataBytes', 'CustomItemByteArrays', [structArray('ByteArrays', [[bytesArray('Bytes', data)], [bytesArray('Bytes', Buffer.alloc(6))]])]),
      ],
    ]),
    u32('ExpirationTimeUTC', 0),
    u64('OwnerPlayerDataID', 111n),
  ];
  return [struct('ArkTributeItem', 'ItemNetInfo', info), float('Version', 2), int('UploadTime', 1_600_000_000)];
}

function clusterFile(o: { player?: boolean } = {}): Buffer {
  const data: Prop[] = [
    structArray('ArkItems', [soul(creature('Rex_Character_BP_C', REX_ID, { name: 'Rexi' }), REX_ID, OTHER)]),
    structArray('ArkTamedDinosData', [upload(creature('Raptor_Character_BP_C', RAPTOR_ID, { name: 'Clever' }), RAPTOR_ID)]),
  ];
  if (o.player) data.push(structArray('ArkPlayerData', [[u64('PlayerDataID', 123456789n), float('Version', 2), int('UploadTime', 1_600_000_000)]]));
  return buildContainer([{
    cls: 'ArkCloudInventoryData', names: ['ArkCloudInventoryData_7'], isItem: true,
    props: [struct('MyArkData', 'ArkInventoryData', data)], extra: Buffer.alloc(4),
  }], 4);
}

/** Every property of every object, except the ones named. */
function sameExcept(a: Buffer, b: Buffer, except: string[]): void {
  const x = readCreatureArchive(a)!.tree;
  const y = readCreatureArchive(b)!.tree;
  assert.equal(x.objects.length, y.objects.length);
  x.objects.forEach((o, i) => {
    const q = y.objects[i];
    assert.deepEqual(q.names, o.names);
    assert.ok(q.extra.equals(o.extra));
    const keep = (l: Property[]) => l.filter((p) => !except.includes(p.name));
    assert.ok(sameValue(keep(o.props) as never, keep(q.props) as never), o.cls ?? '');
  });
}

test('creature sources: uploads and souls, with blueprint and species', () => {
  const sources = creaturesInCluster(readClusterTree(clusterFile()));
  assert.deepEqual(sources.map((s) => [s.where, s.kind, s.blueprint, s.species, s.info.dinoId]), [
    ['ArkTamedDinosData[0]', 'upload', RAPTOR, 'Raptor', RAPTOR_ID],
    ['ArkItems[0] SoulTrap_DS_C', 'soul', REX, 'Rex', REX_ID],
  ]);
  const i = sources[0].info;
  assert.equal(i.tamedName, 'Clever');
  assert.equal(i.level, 64);
  assert.equal(i.team, 1_500_000_000);
  assert.equal(i.tamer, 'Stamm');
  assert.equal(creaturesInCluster(null).length, 0);
});

test('add-dino from an upload: new IDs and upload time, everything else copied', () => {
  const buf = clusterFile();
  const before = readCluster(buf);
  const tree = readClusterTree(buf);
  const [src] = creaturesInCluster(tree);
  const ids: [number, number][] = [RAPTOR_ID, [7, 8]]; // the first one is the source's
  const { tree: out, added } = addDino(tree, src, {}, { now: 1_900_000_000, randomId: () => ids.shift()! });
  assert.deepEqual(added, {
    index: 1, dinoId: [7, 8], sourceId: RAPTOR_ID, blueprint: RAPTOR, name: 'Clever - Lvl 64 (Raptor)', uploadTime: 1_900_000_000, dinos: 2,
  });
  const file = writeClusterTree(out);
  assert.ok(writeClusterTree(readClusterTree(file)).equals(file));
  const v = readCluster(file);
  assert.equal(JSON.stringify(v.items), JSON.stringify(before.items));
  assert.equal(JSON.stringify(v.dinos[0]), JSON.stringify(before.dinos[0]));
  const [orig, copy] = clusterEntries(readClusterTree(file), 'ArkTamedDinosData');
  for (const p of orig) {
    const q = findProperty(copy, p.name, p.index)!;
    if (['DinoData', 'DinoID1', 'DinoID2', 'UploadTime'].includes(p.name)) continue;
    assert.ok(sameValue(p.value, q.value), p.name);
  }
  assert.equal(findProperty(copy, 'UploadTime')!.value, 1_900_000_000);
  const data = findProperty(copy, 'DinoData')!.value as Buffer;
  assert.deepEqual(creatureId(readCreatureArchive(data)!), [7, 8]);
  sameExcept(findProperty(orig, 'DinoData')!.value as Buffer, data, ['DinoID1', 'DinoID2']);
});

test('add-dino from a soul into an empty file: full entry derived from the creature', () => {
  const src = creaturesInCluster(readClusterTree(clusterFile()))[1];
  const { tree, added } = addDino(null, src, { name: 'Lieferung' }, { now: 1_900_000_000, randomId: () => [5, 6] });
  const file = writeClusterTree(tree);
  assert.deepEqual(file.subarray(0, 8), Buffer.from([4, 0, 0, 0, 1, 0, 0, 0]));
  assert.equal(added.name, 'Lieferung - Lvl 64 (Rex)');
  const e = clusterEntries(readClusterTree(file), 'ArkTamedDinosData')[0];
  assert.deepEqual(e.map((p) => `${p.name}${p.index ? `[${p.index}]` : ''}:${p.type}`), [
    'DinoClassName:StrProperty', 'DinoClass:ObjectProperty', 'DinoData:ArrayProperty', 'DinoName:StrProperty', 'DinoNameInMap:StrProperty',
    ...Array.from({ length: 12 }, (_, i) => `DinoStats${i ? `[${i}]` : ''}:StrProperty`),
    'DinoExperiencePoints:FloatProperty', 'Version:FloatProperty', 'DinoID1:UInt32Property', 'DinoID2:UInt32Property', 'UploadTime:IntProperty',
  ]);
  const v = readCluster(file).dinos[0];
  assert.equal(v.className, `Blueprint'${REX}'`);
  assert.deepEqual(JSON.parse(JSON.stringify(v.props.DinoClass)), { $path: `BlueprintGeneratedClass ${REX}_C` });
  assert.equal(v.props.DinoNameInMap, 'Rex_Character_BP_C_7');
  assert.deepEqual(v.dinoId, [5, 6]);
  assert.equal(v.objects?.[0].props.TamedName, 'Lieferung');
  assert.deepEqual(v.stats, [
    'Health: 2572.1 / 2572.1', 'Stamina: 0.0 / 0.0', 'Torpidity: 0.0 / 4520.5', 'Oxygen: 0.0 / 0.0', 'Food: 0.0 / 0.0',
    'Water: 95.8 / 95.8', 'Temperature: 0.0 / 0.0', 'Weight: 0.0 / 0.0', 'Melee Damage: 172.2 %', 'Movement Speed: 100.0 %',
    'Fortitude: 0.0', 'Crafting Skill: 100.0 %',
  ]);
  assert.equal(v.props.DinoExperiencePoints, 14439.5);
  sameExcept(src.data, findProperty(e, 'DinoData')!.value as Buffer, ['DinoID1', 'DinoID2', 'TamedName']);
});

test('add-dino: keep or set IDs, refuses what does not fit', () => {
  const tree = () => readClusterTree(clusterFile());
  const [up, rex] = creaturesInCluster(tree());
  assert.deepEqual(addDino(null, up, { keepId: true }).added.dinoId, RAPTOR_ID);
  assert.deepEqual(addDino(tree(), rex, { dinoId: [1, 2] }).added.dinoId, [1, 2]);
  assert.throws(() => addDino(tree(), up, { keepId: true }), /already in the file/);
  assert.throws(() => addDino(tree(), up, { blueprint: REX }), /does not match the creature class/);
  assert.throws(() => addDino(null, { ...rex, blueprint: null }), /class path of Rex_Character_BP_C unknown/);
  assert.equal(addDino(null, { ...rex, blueprint: null }, { blueprint: `Blueprint'${REX}'` }).added.blueprint, REX);
  assert.throws(() => addDino(null, { ...rex, data: Buffer.alloc(64) }), /not a creature archive/);
  assert.throws(() => addDino(null, up, { name: ' ' }), /must not be empty/);
});

test('copy-item: soul with new ItemID, owner, SteamID and DinoIDs', () => {
  const src = readClusterTree(clusterFile());
  const entry = clusterEntries(src, 'ArkItems')[0];
  const target = readClusterTree(clusterFile({ player: true }));
  const itemIds: [number, number][] = [[500, 600], [501, 601]]; // the first one is taken by the original
  const { tree, added } = copyItem(target, entry, { steamId: PLAYER, expiresIn: 3600 }, {
    now: 1_900_000_000, randomId: () => itemIds.shift()!, randomDinoId: () => [9, 10],
  });
  assert.equal(added.index, 1);
  assert.deepEqual(added.creatures, [{ from: REX_ID, to: [9, 10] }]);
  assert.equal(added.owner, '123456789', 'PlayerDataID of the target file');
  const file = writeClusterTree(tree);
  assert.ok(writeClusterTree(readClusterTree(file)).equals(file));
  const it = readCluster(file).items[1];
  assert.deepEqual(it.itemId, [501, 601], 'the ItemID taken by the original is not reused');
  assert.equal(it.uploadTime, 1_900_000_000);
  assert.equal(it.expiration, 1_900_003_600);
  assert.equal(it.owner, '123456789');
  const copied = creaturesInCluster(readClusterTree(file)).find((s) => s.where === 'ArkItems[1] SoulTrap_DS_C')!;
  assert.deepEqual(copied.info.dinoId, [9, 10]);
  const info = findProperty(clusterEntries(readClusterTree(file), 'ArkItems')[1], 'ArkTributeItem')!.value as Property[];
  const datas = findProperty(info, 'CustomItemDatas')!.value as Property[][];
  assert.deepEqual(findProperty(datas[1], 'CustomDataStrings')!.value, ['Rex_Character_BP_C_7', 'Rexi - Lvl 64 (Rex)', '0', PLAYER, REX, '9 10']);
  assert.equal(readCluster(file).items[0].itemId.join(':'), '500:600', 'the original stays');
  // keepIds leaves creatures and their texts alone
  const kept = copyItem(null, entry, { keepIds: true, owner: 5 }).added;
  assert.deepEqual(kept.creatures, []);
  assert.equal(kept.owner, '5');
  assert.throws(() => copyItem(null, entry, { steamId: '123' }), /not a SteamID64/);
});

test('creatures in a savegame: cryopods and souls, not creatures in the world', () => {
  const pod = creature('Rex_Character_BP_C', [31, 32], { name: 'Kryo' });
  const save = buildSave([
    {
      cls: 'PrimalItem_WeaponEmptyCryopod_C', names: ['PrimalItem_WeaponEmptyCryopod_C_3'], isItem: true,
      props: [
        structArray('CustomItemDatas', [[
          { name: 'CustomDataName', type: 'NameProperty', value: (w) => w.name('Dino') },
          strings('CustomDataStrings', ['Rex_Character_BP_C_7', 'Kryo - Lvl 64 (Rex)']),
          paths('CustomDataClasses', [`BlueprintGeneratedClass ${REX}_C`]),
          struct('CustomDataBytes', 'CustomItemByteArrays', [structArray('ByteArrays', [[bytesArray('Bytes', pod)]])]),
        ]]),
      ],
    },
    { cls: 'Raptor_Character_BP_C', names: ['Raptor_Character_BP_C_9'], loc: [0, 0, 0], props: [u32('DinoID1', 1), u32('DinoID2', 2)] },
  ]);
  const found = creaturesInSave(save);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'cryopod');
  assert.equal(found[0].blueprint, REX);
  assert.equal(found[0].species, 'Rex');
  assert.deepEqual(found[0].info.dinoId, [31, 32]);
  assert.ok(found[0].data.equals(pod));
  const { tree } = addDino(null, found[0], {}, { randomId: () => [41, 42] });
  assert.deepEqual(readCluster(writeClusterTree(tree)).dinos[0].dinoId, [41, 42]);
});

test('creature blueprint spellings and stat texts', () => {
  for (const s of [`Blueprint'${REX}'`, REX, `${REX}_C`, `BlueprintGeneratedClass ${REX}_C`]) assert.equal(creatureBlueprint(s), REX, s);
  assert.throws(() => creatureBlueprint('/Game/A/B.C'), /does not match/);
  assert.throws(() => creatureBlueprint('Rex'), /not a creature class path/);
  const a = readCreatureArchive(creature('Rex_Character_BP_C', [1, 2]))!;
  assert.equal(dinoStatTexts(a).length, 12);
});

test('cluster CLI: dinos, add-dino --out / --in-place, copy-item', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ark-dinos-'));
  try {
    const src = join(dir, OTHER);
    const target = join(dir, PLAYER);
    writeFileSync(src, clusterFile());
    writeFileSync(target, '');
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'cluster', ...args], { encoding: 'utf8' });

    const list = run('dinos', src);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout).creatures.map((c: { pick: number; kind: string }) => [c.pick, c.kind]), [[0, 'upload'], [1, 'soul']]);

    const out = join(dir, 'out');
    const r1 = run('add-dino', target, '--from', src, '--source-id', REX_ID.join(':'), '--name', 'Lieferung', '--out', out);
    assert.equal(r1.status, 0, r1.stderr);
    const res = JSON.parse(r1.stdout);
    assert.equal(res.added.blueprint, REX);
    assert.equal(res.before.bytes, 0);
    assert.equal(readCluster(readFileSync(out)).dinos[0].name, 'Lieferung - Lvl 64 (Rex)');
    assert.equal(readFileSync(target).length, 0, '--out leaves the input alone');
    assert.notEqual(run('add-dino', target, '--from', src, '--pick', '5', '--out', join(dir, 'x')).status, 0, 'no such creature');
    assert.ok(!existsSync(join(dir, 'x')));
    assert.notEqual(run('add-dino', join(dir, 'missing'), '--from', src, '--pick', '0', '--in-place', '--backup', join(dir, 'bak')).status, 0);

    const r2 = run('add-dino', target, '--from', src, '--pick', '0', '--in-place', '--backup', join(dir, 'bak'));
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(readCluster(readFileSync(target)).dinos.length, 1);
    assert.equal(readdirSync(join(dir, 'bak')).length, 1);

    const r3 = run('copy-item', target, '--from', src, '--index', '0', '--in-place', '--backup', join(dir, 'bak'));
    assert.equal(r3.status, 0, r3.stderr);
    const copy = JSON.parse(r3.stdout);
    assert.equal(copy.added.steamId, PLAYER, 'SteamID from the file name');
    assert.equal(copy.added.creatures.length, 1);
    const v = readCluster(readFileSync(target));
    assert.equal(v.items.length, 1);
    assert.equal(v.dinos.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- recolor

const nameProp = (n: string, v: string, index = 0): Prop => ({ name: n, type: 'NameProperty', index, value: (w) => w.string(v) });

/** One uploaded raptor with colours 36 / - / 14 and six ColorSetNames, as tamed creatures have them. */
function colorfulFile(): Buffer {
  const data = creature('Raptor_Character_BP_C', RAPTOR_ID, {
    name: 'Clever',
    colorProps: [byte('ColorSetIndices', 14, 2), ...Array.from({ length: 6 }, (_, i) => nameProp('ColorSetNames', `Old${i}`, i))],
  });
  return buildContainer([{
    cls: 'ArkCloudInventoryData', names: ['ArkCloudInventoryData_7'], isItem: true,
    props: [struct('MyArkData', 'ArkInventoryData', [structArray('ArkTamedDinosData', [upload(data, RAPTOR_ID)])])], extra: Buffer.alloc(4),
  }], 4);
}

const colorProps = (data: Buffer): [string, number, unknown][] =>
  readCreatureArchive(data)!.creature.props.filter((p) => p.name.startsWith('ColorSet')).map((p) => [p.name, p.index, p.value]);

test('colour table: names, dyes and the names the game stores', () => {
  assert.equal(colorName(1), 'Red');
  assert.equal(colorName(14), 'Black');
  assert.equal(colorName(100), 'Cream');
  assert.equal(colorName(201), 'Black Coloring');
  assert.equal(colorName(226), 'Slate Coloring');
  for (const id of [0, 101, 200, 227, 255]) assert.equal(colorName(id), null, String(id));
  // Seen in a real save: ID 13 (Dark Grey) carries "Black", 99 "Cream", 100 "Unused", dyes "DyeIndex".
  assert.equal(storedColorSetName(13), 'Black');
  assert.equal(storedColorSetName(99), 'Cream');
  assert.equal(storedColorSetName(100), 'Unused');
  assert.equal(storedColorSetName(206), 'DyeIndex');
});

test('recolor: sets, inserts in order, clears, rewrites names, keeps everything else', () => {
  const buf = colorfulFile();
  const tree = readClusterTree(buf)!;
  const oldEntry = clusterEntries(readClusterTree(buf), 'ArkTamedDinosData')[0];
  const oldData = findProperty(oldEntry, 'DinoData')!.value as Buffer;
  assert.deepEqual(creaturesInCluster(tree)[0].info.colors, [36, 0, 14, 0, 0, 0]);

  const { recolored } = recolorDino(tree, { dinoId: RAPTOR_ID }, { colors: { 0: 13, 1: 27, 2: 0, 4: 201 } });
  assert.deepEqual(recolored.before, [36, 0, 14, 0, 0, 0]);
  assert.deepEqual(recolored.after, [13, 27, 0, 0, 201, 0]);
  assert.deepEqual(recolored.names, [0, 1, 4]);
  assert.deepEqual(recolored.dinoId, RAPTOR_ID);

  const out = writeClusterTree(tree);
  assert.ok(writeClusterTree(readClusterTree(out)).equals(out), 'round trip');
  const [src] = creaturesInCluster(readClusterTree(out));
  assert.deepEqual(src.info.colors, [13, 27, 0, 0, 201, 0]);
  assert.deepEqual(src.info.dinoId, RAPTOR_ID);
  const newEntry = clusterEntries(readClusterTree(out), 'ArkTamedDinosData')[0];
  const newData = findProperty(newEntry, 'DinoData')!.value as Buffer;
  // Regions stay in order, region 2 is gone (the game leaves unused regions out), names follow the game.
  assert.deepEqual(colorProps(newData), [
    ['ColorSetIndices', 0, 13], ['ColorSetIndices', 1, 27], ['ColorSetIndices', 4, 201],
    ['ColorSetNames', 0, 'Black'], ['ColorSetNames', 1, 'Dino Light Blue'], ['ColorSetNames', 2, 'Old2'],
    ['ColorSetNames', 3, 'Old3'], ['ColorSetNames', 4, 'DyeIndex'], ['ColorSetNames', 5, 'Old5'],
  ]);
  sameExcept(oldData, newData, ['ColorSetIndices', 'ColorSetNames']);
  const rest = (e: Property[]) => e.filter((p) => p.name !== 'DinoData');
  assert.ok(sameValue(rest(oldEntry) as never, rest(newEntry) as never), 'upload entry unchanged apart from DinoData');
});

test('recolor: by index, names kept, refusals', () => {
  const tree = () => readClusterTree(colorfulFile())!;
  const t = tree();
  const { recolored } = recolorDino(t, { index: 0 }, { colors: { 3: 55 }, names: 'keep' });
  assert.deepEqual(recolored.after, [36, 0, 14, 55, 0, 0]);
  assert.deepEqual(recolored.names, []);
  const data = findProperty(clusterEntries(t, 'ArkTamedDinosData')[0], 'DinoData')!.value as Buffer;
  assert.deepEqual(colorProps(data).filter(([n]) => n === 'ColorSetNames').map(([, , v]) => v), ['Old0', 'Old1', 'Old2', 'Old3', 'Old4', 'Old5']);

  assert.throws(() => recolorDino(tree(), { index: 0 }, { colors: { 0: 150 } }), /no ASE colour/);
  assert.deepEqual(recolorDino(tree(), { index: 0 }, { colors: { 0: 150 }, anyColor: true }).recolored.after[0], 150);
  assert.throws(() => recolorDino(tree(), { index: 0 }, { colors: { 6: 1 } }), /region must be/);
  assert.throws(() => recolorDino(tree(), { index: 0 }, { colors: { 0: 256 }, anyColor: true }), /0\.\.255/);
  assert.throws(() => recolorDino(tree(), { index: 0 }, { colors: {} }), /no colours/);
  assert.throws(() => recolorDino(tree(), { index: 1 }, { colors: { 0: 1 } }), /no uploaded creature at index 1/);
  assert.throws(() => recolorDino(tree(), { dinoId: [1, 2] }, { colors: { 0: 1 } }), /0 uploaded creatures/);
});

test('cluster CLI: recolor --out / --in-place, colours in show and dinos', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ark-recolor-'));
  try {
    const file = join(dir, PLAYER);
    writeFileSync(file, colorfulFile());
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'cluster', ...args], { encoding: 'utf8' });

    const shown = run('show', file);
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout).dinos[0].colors, [36, 0, 14, 0, 0, 0]);

    const out = join(dir, 'out');
    const r1 = run('recolor', file, '--dino', RAPTOR_ID.join(':'), '--colors', '0=14,5=206', '--out', out);
    assert.equal(r1.status, 0, r1.stderr);
    const res = JSON.parse(r1.stdout);
    assert.deepEqual(res.colors.after.map((c: { id: number }) => c.id), [14, 0, 14, 0, 0, 206]);
    assert.equal(res.colors.after[5].name, 'Green Coloring');
    assert.equal(res.backup, null);
    assert.ok(readFileSync(file).equals(colorfulFile()), '--out leaves the input alone');
    const listed = run('dinos', out);
    assert.deepEqual(JSON.parse(listed.stdout).creatures[0].colors, [14, 0, 14, 0, 0, 206]);

    for (const bad of [['--colors', '0=999'], ['--colors', '7=1'], ['--colors', '0=1,0=2'], ['--colors', 'rot'], []]) {
      const r = run('recolor', file, '--index', '0', ...bad, '--out', join(dir, 'x'));
      assert.notEqual(r.status, 0, bad.join(' '));
    }
    assert.ok(!existsSync(join(dir, 'x')));
    assert.notEqual(run('recolor', file, '--index', '0', '--colors', '0=1', '--in-place').status, 0, '--in-place needs --backup');

    const r2 = run('recolor', file, '--index', '0', '--colors', '1=55', '--in-place', '--backup', join(dir, 'bak'));
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(creaturesInCluster(readClusterTree(readFileSync(file)))[0].info.colors, [36, 55, 14, 0, 0, 0]);
    const backups = readdirSync(join(dir, 'bak'));
    assert.equal(backups.length, 1);
    assert.ok(readFileSync(join(dir, 'bak', backups[0])).equals(colorfulFile()), 'backup holds the original');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
