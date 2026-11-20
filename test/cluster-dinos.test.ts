// Creatures in cluster files: listing sources, adding uploads, copying souls/cryopods, the CLI.
// All files are synthetic (test/build.ts); real cluster files hold SteamIDs and names.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classPathsInNames, InstallDir } from '../src/class-paths.ts';
import { clusterEntries, readCluster, readClusterTree, writeClusterTree } from '../src/cluster.ts';
import {
  addDino, copyItem, creatureBlueprint, creatureId, creaturesInCluster, creaturesInSave, dinoStatTexts, readCreatureArchive,
} from '../src/cluster-dinos.ts';
import { findProperty, type Property, readContainerTree, sameValue, writeContainerTree } from '../src/tree.ts';
import {
  bool, buildContainer, buildEmbedded, buildSave, bytesArray, double, float, int, type Obj, path, type Prop, str, struct, structArray, u64,
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
function creature(cls: string, id: [number, number], o: { name?: string; team?: number; outer?: string[] } = {}): Buffer {
  const actor = `${cls}_7`;
  const outer = o.outer ?? ['PersistentLevel', 'TheIsland'];
  return buildEmbedded([
    {
      cls, names: [actor, ...outer], loc: [1, 2, 3],
      props: [
        ...(o.name ? [str('TamedName', o.name)] : []),
        str('TamerString', 'Stamm'), byte('ColorSetIndices', 36), u32('DinoID1', id[0]), u32('DinoID2', id[1]),
        ref('MyCharacterStatusComponent', 1), ref('MyInventoryComponent', 2), int('TargetingTeam', o.team ?? 1_500_000_000),
      ],
      extra: Buffer.from('0000000001000000', 'hex'),
    },
    {
      cls: 'DinoCharacterStatusComponent_BP_C', names: ['DinoCharacterStatus_BP_C1', actor, ...outer],
      props: [
        float('MaxStatusValues', 2572.1), float('MaxStatusValues', 4520.5, 2), float('MaxStatusValues', 0.7221, 8),
        byte('NumberOfLevelUpPointsApplied', 6), int('BaseCharacterLevel', 22), u16('ExtraCharacterLevel', 42),
        float('ExperiencePoints', 14439.5), float('CurrentStatusValues', 2572.1), float('CurrentStatusValues', 95.8, 5),
        float('CurrentStatusValues', 0.7221, 8),
      ],
      extra: Buffer.alloc(4),
    },
    { cls: 'DinoTamedInventoryComponent_C', names: ['DinoTamedInventoryComponent_C_1', actor, ...outer], props: [], extra: Buffer.alloc(4) },
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
  // bAllowRemovalFromInventory: the shortened soul has none, the copy gets it (ARK refuses downloads without it).
  assert.deepEqual([added.allowRemovalBefore, added.allowRemoval], [null, true]);
  assert.equal(it.allowRemoval, true);
  assert.equal(readCluster(file).items[0].allowRemoval, null, 'the original is not touched');
  const names = info.map((p) => p.name);
  assert.equal(names.indexOf('bAllowRemovalFromInventory'), names.indexOf('ItemQuantity') + 1, 'next to its usual neighbours');
  // A source with false: set to true by default, kept with allowRemoval null.
  const locked = clusterEntries(readClusterTree(file), 'ArkItems')[1];
  findProperty(findProperty(locked, 'ArkTributeItem')!.value as Property[], 'bAllowRemovalFromInventory')!.value = false;
  const fixed = copyItem(null, locked, { owner: 5 });
  assert.deepEqual([fixed.added.allowRemovalBefore, fixed.added.allowRemoval], [false, true]);
  assert.equal(readCluster(writeClusterTree(fixed.tree)).items[0].allowRemoval, true);
  const keep = copyItem(null, locked, { owner: 5, allowRemoval: null });
  assert.deepEqual([keep.added.allowRemovalBefore, keep.added.allowRemoval], [false, false]);
  assert.equal(readCluster(writeClusterTree(keep.tree)).items[0].allowRemoval, false);
  // keepIds leaves creatures and their texts alone
  const kept = copyItem(null, entry, { keepIds: true, owner: 5 }).added;
  assert.deepEqual(kept.creatures, []);
  assert.equal(kept.owner, '5');
  assert.throws(() => copyItem(null, entry, { steamId: '123' }), /not a SteamID64/);
});

test('creatures in a savegame: cryopods and souls, not wild creatures in the world', () => {
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

// ---------------------------------------------------------------- creatures in the world of a save

const MOSCHOPS = '/Game/PrimalEarth/Dinos/Moschops/Moschops_Character_BP.Moschops_Character_BP';
const LEVEL = '/Game/Maps/Test/TestMap';
const CHAIN = ['PersistentLevel', 'TestMap', LEVEL];
const WORLD_REX: [number, number] = [1001, 2002];
const refs = (name: string, list: number[]): Prop => ({
  name, type: 'ArrayProperty', inner: 'ObjectProperty', value: (w) => { w.i32(list.length); for (const i of list) w.i32(0).i32(i); },
});
const TAIL = Buffer.from('0000000001000000', 'hex');

/** A tamed creature standing in the world with its status component (and more objects after it). */
function worldDino(cls: string, name: string, id: [number, number], at: number, more: Prop[] = [], o: { team?: number; guid?: Buffer } = {}): Obj[] {
  return [
    {
      cls, names: [name], loc: [100, 200, 300], guid: o.guid,
      props: [
        u32('DinoID1', id[0]), u32('DinoID2', id[1]), int('TargetingTeam', o.team ?? 1_500_000_000), ref('MyCharacterStatusComponent', at + 1),
        ...more,
      ],
      extra: TAIL,
    },
    { cls: 'DinoCharacterStatusComponent_BP_C', names: [`DinoCharacterStatus_BP_C_${at}`, name], props: [int('BaseCharacterLevel', 30)], extra: Buffer.alloc(4) },
  ];
}

/**
 * A save with a cryopod (class path and map package of a Rex), a tamed Rex in the world with
 * inventory, item and painting component, a raptor whose path is only in the name table, a
 * moschops without any path, a wild dodo and a dead tamed rex.
 */
function worldSave(o: { cryopod?: boolean; more?: Obj[] } = {}): Buffer {
  const objects: Obj[] = [
    {
      cls: 'PrimalItem_WeaponEmptyCryopod_C', names: ['PrimalItem_WeaponEmptyCryopod_C_3'], isItem: true,
      props: o.cryopod === false ? [] : [
        structArray('CustomItemDatas', [[
          { name: 'CustomDataName', type: 'NameProperty', value: (w) => w.name('Dino') },
          paths('CustomDataClasses', [`BlueprintGeneratedClass ${REX}_C`]),
          struct('CustomDataBytes', 'CustomItemByteArrays', [structArray('ByteArrays', [[
            bytesArray('Bytes', creature('Rex_Character_BP_C', [31, 32], { outer: CHAIN })),
          ]])]),
        ]]),
      ],
    },
    {
      cls: 'Rex_Character_BP_C', names: ['Rex_Character_BP_C_12'], loc: [100, 200, 300], guid: Buffer.alloc(16, 7),
      props: [
        str('TamedName', 'Rexi'), str('TribeName', 'Stamm'), str('TamerString', 'Stamm'), u32('DinoID1', WORLD_REX[0]), u32('DinoID2', WORLD_REX[1]),
        int('TargetingTeam', 1_500_000_000), ref('MyCharacterStatusComponent', 2), ref('MyInventoryComponent', 3), ref('PaintingComponent', 5),
        ref('Instigator', 1), ref('TamedFollowTarget', 8), double('NextAllowedMatingTime', 5000), double('LastInAllyRangeTime', 1200),
        bool('bEnableTamedMating', true),
      ],
      extra: TAIL,
    },
    { cls: 'DinoCharacterStatusComponent_BP_C', names: ['DinoCharacterStatus_BP_C_3', 'Rex_Character_BP_C_12'], props: [int('BaseCharacterLevel', 30), float('ExperiencePoints', 100)], extra: Buffer.alloc(4) },
    {
      cls: 'DinoTamedInventoryComponent_C', names: ['DinoTamedInventoryComponent_C_4', 'Rex_Character_BP_C_12'],
      props: [refs('InventoryItems', [4]), bool('bInitializedMe', true), double('LastInventoryRefreshTime', 1100)], extra: Buffer.alloc(4),
    },
    { cls: 'PrimalItemConsumable_RawMeat_C', names: ['PrimalItemConsumable_RawMeat_C_9'], isItem: true, props: [ref('OwnerInventory', 3)], extra: Buffer.alloc(4) },
    { cls: 'StructurePaintingComponent', names: ['StructurePaintingComponent_1', 'Rex_Character_BP_C_12'], props: [], extra: Buffer.alloc(4) },
    ...worldDino('Raptor_Character_BP_C', 'Raptor_Character_BP_C_2', [41, 42], 6),
    { cls: 'StorageBox_Huge_C', names: ['StorageBox_Huge_C_1'], loc: [0, 0, 0], props: [path('DinoClassToShow', `${RAPTOR}_C`)], extra: Buffer.alloc(4) },
    ...worldDino('Moschops_Character_BP_C', 'Moschops_Character_BP_C_5', [51, 52], 9),
    ...worldDino('Dodo_Character_BP_C', 'Dodo_Character_BP_C_1', [61, 62], 11, [], { team: 2000 }),
    ...worldDino('Rex_Character_BP_C', 'Rex_Character_BP_C_99', [71, 72], 13, [bool('bIsDead', true)]),
    ...(o.more ?? []),
  ];
  return buildSave(objects, { map: 'TestMap' });
}

test('creatures in the world: listed with class path, packed like the game packs them', () => {
  const warnings: string[] = [];
  const list = creaturesInSave(worldSave(), { warnings });
  assert.deepEqual(list.map((s) => [s.kind, s.info.cls, s.blueprint, s.blueprintFrom]), [
    ['cryopod', 'Rex_Character_BP_C', REX, 'own'],
    ['world', 'Rex_Character_BP_C', REX, 'same-class'],
    ['world', 'Raptor_Character_BP_C', RAPTOR, 'name-table'],
    ['world', 'Moschops_Character_BP_C', null, null],
  ]);
  assert.deepEqual(warnings, ['1 dead tamed creatures in the world left out']);
  const rex = list[1];
  assert.equal(rex.where, 'Rex_Character_BP_C_12 (object 1)');
  assert.deepEqual([rex.info.dinoId, rex.info.tamedName, rex.info.level, rex.info.team], [WORLD_REX, 'Rexi', 30, 1_500_000_000]);
  assert.deepEqual(rex.world, {
    index: 1, location: { x: 100, y: 200, z: 300 }, tribeName: 'Stamm',
    droppedRefs: { InventoryItems: 1, TamedFollowTarget: 1 },
    removedProps: [
      'Instigator', 'LastInAllyRangeTime', 'NextAllowedMatingTime', 'PaintingComponent', 'TribeName', 'bEnableTamedMating',
      'bInitializedMe', 'InventoryItems', 'LastInventoryRefreshTime',
    ].sort(),
    removedObjects: ['StructurePaintingComponent'],
    level: CHAIN,
  });
  assert.equal(rex.problem, undefined);

  // The archive: creature, status, inventory with the map's outer names, like a cryopod payload.
  const t = readContainerTree(rex.data, { version: false });
  assert.ok(writeContainerTree(t).equals(rex.data));
  assert.deepEqual(t.objects.map((x) => x.names), [
    ['Rex_Character_BP_C_12', ...CHAIN],
    ['DinoCharacterStatus_BP_C_3', 'Rex_Character_BP_C_12', ...CHAIN],
    ['DinoTamedInventoryComponent_C_4', 'Rex_Character_BP_C_12', ...CHAIN],
  ]);
  assert.ok(t.objects[0].guid.equals(Buffer.alloc(16)), 'the game writes a zero GUID');
  assert.ok(t.objects[0].location && t.objects[0].hasLocation === 1);
  assert.deepEqual(t.objects.map((x) => x.extra.toString('hex')), ['0000000001000000', '00000000', '00000000']);
  const c = t.objects[0].props;
  assert.deepEqual(c.map((p) => p.name), [
    'TamedName', 'TamerString', 'DinoID1', 'DinoID2', 'TargetingTeam', 'MyCharacterStatusComponent', 'MyInventoryComponent', 'TamedFollowTarget',
  ]);
  assert.deepEqual(c.slice(5).map((p) => (p.value as { index: number }).index), [1, 2, -1], 'references renumbered, outside ones none');
  assert.deepEqual(t.objects[1].props.map((p) => p.name), ['BaseCharacterLevel', 'ExperiencePoints']);
  assert.deepEqual(t.objects[2].props, []);

  // As an upload: new DinoIDs, listing fields from the archive, byte-exact on reading back.
  const { tree, added } = addDino(null, rex, {}, { now: 1_900_000_000, randomId: () => [7, 8] });
  assert.equal(added.blueprint, REX);
  const file = writeClusterTree(tree);
  assert.ok(writeClusterTree(readClusterTree(file)).equals(file));
  const v = readCluster(file).dinos[0];
  assert.deepEqual(v.dinoId, [7, 8]);
  assert.equal(v.className, `Blueprint'${REX}'`);
  assert.equal(v.name, 'Rexi - Lvl 30 (Rex)');
  assert.equal(v.props.DinoNameInMap, 'Rex_Character_BP_C_12');
  sameExcept(rex.data, findProperty(clusterEntries(readClusterTree(file), 'ArkTamedDinosData')[0], 'DinoData')!.value as Buffer, ['DinoID1', 'DinoID2']);

  // Without a class path the blueprint must be given.
  const moschops = list[3];
  assert.throws(() => addDino(null, moschops), /class path of Moschops_Character_BP_C unknown/);
  assert.equal(addDino(null, moschops, { blueprint: MOSCHOPS }).added.blueprint, MOSCHOPS);
  assert.deepEqual(creaturesInSave(worldSave(), { world: false }).map((s) => s.kind), ['cryopod']);
});

test('creatures in the world: map package from the name table or --level, second entries once', () => {
  // No cryopod of this map: the map package is unknown and copying is refused.
  const warnings: string[] = [];
  const bare = creaturesInSave(worldSave({ cryopod: false }), { warnings });
  assert.ok(warnings.some((w) => /map package of TestMap unknown/.test(w)));
  const rex = bare.find((s) => s.info.cls === 'Rex_Character_BP_C')!;
  assert.equal(rex.world!.level, null);
  assert.equal(rex.blueprint, null, 'no cryopod, no path');
  assert.throws(() => addDino(null, rex, { blueprint: REX }), /map package unknown/);
  const given = creaturesInSave(worldSave({ cryopod: false }), { level: LEVEL }).find((s) => s.info.cls === 'Rex_Character_BP_C')!;
  assert.deepEqual(given.world!.level, CHAIN);
  assert.equal(addDino(null, given, { blueprint: REX }).added.blueprint, REX);
  assert.throws(() => creaturesInSave(worldSave(), { level: 'TestMap' }), /package path/);
  // A name table entry "/Game/.../TestMap" is enough.
  const level: Obj = { cls: 'LevelInfo_C', names: ['LevelInfo_C_1'], props: [path('Level', LEVEL)], extra: Buffer.alloc(4) };
  const named = creaturesInSave(worldSave({ cryopod: false, more: [level] })).find((s) => s.kind === 'world')!;
  assert.deepEqual(named.world!.level, CHAIN);
  // The game writes some actors twice under the same name: listed once.
  const twice = worldDino('Moschops_Character_BP_C', 'Moschops_Character_BP_C_5', [51, 52], 15);
  const w2: string[] = [];
  const list = creaturesInSave(worldSave({ more: twice }), { warnings: w2 });
  assert.equal(list.filter((s) => s.info.cls === 'Moschops_Character_BP_C').length, 1);
  assert.ok(w2.includes('1 second entries of the same creature left out (the game writes some actors twice)'));
});

test('class paths: name table entries and game files, ambiguous answers are not used', () => {
  const names = classPathsInNames([
    `${REX}_C`, `BlueprintGeneratedClass ${RAPTOR}_C`, `Blueprint'${MOSCHOPS}'`, '/Game/A/B.C', 'Rex_Character_BP_C', '/Game/Maps/Test/TestMap',
  ]);
  assert.deepEqual(Object.fromEntries([...names].map(([k, v]) => [k, [...v]])), {
    Rex_Character_BP: [REX], Raptor_Character_BP: [RAPTOR], Moschops_Character_BP: [MOSCHOPS],
  });

  const dir = mkdtempSync(join(tmpdir(), 'ark-install-'));
  try {
    const content = join(dir, 'ShooterGame', 'Content');
    const asset = (rel: string, body: string): void => {
      mkdirSync(join(content, rel, '..'), { recursive: true });
      writeFileSync(join(content, `${rel}.uasset`), body);
    };
    asset('PrimalEarth/Dinos/Moschops/Moschops_Character_BP', 'core asset');
    asset('PrimalEarth/Dinos/Dodo/Dodo_Character_BP', 'core asset');
    // A mod folder is named after the mod id; the package keeps the path the mod was made with,
    // which is in the file's name map (next to the core class it derives from).
    asset('Mods/555/Dinos/Dodo/Dodo_Character_BP', '\x1a\0/Game/Mods/BetterDodos/Dinos/Dodo/Dodo_Character_BP\0\x2f\0/Game/PrimalEarth/Dinos/Dodo/Dodo_Character_BP\0');
    asset('Mods/555/Dinos/Moa/Moa_Character_BP_2', '/Game/Mods/BetterDodos/Dinos/Moa/Moa_Character_BP\0');
    asset('Mods/555/Unreadable_Character_BP', 'no path in here');
    const install = new InstallDir(dir);
    assert.equal(new InstallDir(content).content, content);
    assert.equal(new InstallDir(join(dir, 'ShooterGame')).content, content);
    assert.throws(() => new InstallDir(join(content, 'PrimalEarth')), /no ShooterGame\/Content/);
    assert.deepEqual(install.lookup('Moschops_Character_BP_C').paths, [MOSCHOPS]);
    assert.deepEqual(install.lookup('Dodo_Character_BP_C').paths.sort(), [
      '/Game/Mods/BetterDodos/Dinos/Dodo/Dodo_Character_BP.Dodo_Character_BP', '/Game/PrimalEarth/Dinos/Dodo/Dodo_Character_BP.Dodo_Character_BP',
    ]);
    assert.deepEqual(install.lookup('Moa_Character_BP_2_C').paths, ['/Game/Mods/BetterDodos/Dinos/Moa/Moa_Character_BP_2.Moa_Character_BP_2']);
    assert.deepEqual(install.lookup('Unreadable_Character_BP_C').paths, []);
    assert.equal(install.lookup('Unreadable_Character_BP_C').unreadable.length, 1);

    // In a save: the moschops gets its path from the game files; a tamed dodo has two answers and none is used.
    const dodo = worldDino('Dodo_Character_BP_C', 'Dodo_Character_BP_C_3', [81, 82], 15);
    const list = creaturesInSave(worldSave({ more: dodo }), { installDir: dir });
    const m = list.find((s) => s.info.cls === 'Moschops_Character_BP_C')!;
    assert.deepEqual([m.blueprint, m.blueprintFrom], [MOSCHOPS, 'install-dir']);
    const d = list.find((s) => s.info.cls === 'Dodo_Character_BP_C')!;
    assert.deepEqual([d.blueprint, d.blueprintFrom, d.blueprintCandidates?.length], [null, null, 2]);
    assert.throws(() => addDino(null, d), /class path of Dodo_Character_BP_C unknown/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cluster CLI: a creature from the world of a save into the uploads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ark-world-'));
  try {
    const save = join(dir, 'TestMap.ark');
    const target = join(dir, PLAYER);
    writeFileSync(save, worldSave());
    writeFileSync(target, '');
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'cluster', ...args], { encoding: 'utf8' });
    const list = run('dinos', save);
    assert.equal(list.status, 0, list.stderr);
    const res = JSON.parse(list.stdout);
    assert.deepEqual(res.warnings, ['1 dead tamed creatures in the world left out']);
    const rex = res.creatures.find((c: { kind: string; cls: string }) => c.kind === 'world' && c.cls === 'Rex_Character_BP_C');
    assert.deepEqual([rex.blueprint, rex.blueprintFrom, rex.level, rex.droppedRefs], [REX, 'same-class', LEVEL, { InventoryItems: 1, TamedFollowTarget: 1 }]);
    assert.deepEqual(rex.location, { x: 100, y: 200, z: 300 });

    const out = join(dir, 'out');
    const r = run('add-dino', target, '--from', save, '--source-id', WORLD_REX.join(':'), '--out', out);
    assert.equal(r.status, 0, r.stderr);
    const added = JSON.parse(r.stdout);
    assert.equal(added.source.kind, 'world');
    assert.equal(added.source.blueprintFrom, 'same-class');
    const v = readCluster(readFileSync(out)).dinos[0];
    assert.notDeepEqual(v.dinoId, WORLD_REX, 'new DinoIDs');
    assert.equal(v.name, 'Rexi - Lvl 30 (Rex)');

    const moschops = String(res.creatures.find((c: { cls: string }) => c.cls === 'Moschops_Character_BP_C').dinoId.join(':'));
    const no = run('add-dino', target, '--from', save, '--source-id', moschops, '--out', join(dir, 'm'));
    assert.notEqual(no.status, 0);
    assert.match(no.stderr, /class path of Moschops_Character_BP_C unknown/);
    const yes = run('add-dino', target, '--from', save, '--source-id', moschops, '--blueprint', MOSCHOPS, '--out', join(dir, 'm'));
    assert.equal(yes.status, 0, yes.stderr);
    assert.equal(JSON.parse(yes.stdout).source.blueprintFrom, 'option');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.equal(copy.added.allowRemoval, true);
    assert.equal(r3.stderr, '', 'no warning when the copy can be downloaded');
    const v = readCluster(readFileSync(target));
    assert.equal(v.items.length, 1);
    assert.equal(v.dinos.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
