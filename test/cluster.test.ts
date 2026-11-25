// Cluster files: lossless reading and writing, the decoded view, appending items, the CLI.
// All files are synthetic (test/build.ts); real cluster files hold SteamIDs and names.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { replaceFile } from '../src/cluster-cli.ts';
import {
  addItem, clusterEntries, itemArchetype, readCluster, readClusterTree, tributeItemEntry, writeClusterTree,
} from '../src/cluster.ts';
import { readContainer } from '../src/container.ts';
import { Archive } from '../src/archive.ts';
import { findProperty, type Property, readContainerTree, readPropertyList, writeContainerTree, writePropertyList } from '../src/tree.ts';
import { BinaryWriter } from '../src/writer.ts';
import {
  buildContainer, buildEmbedded, bool, bytesArray, double, float, int, path, type Prop, str, struct, structArray, u64, Writer,
  writeProps,
} from './build.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const RIOT = '/Game/PrimalEarth/CoreBlueprints/Items/Armor/Riot/PrimalItemArmor_RiotShirt.PrimalItemArmor_RiotShirt_C';

const u32 = (name: string, v: number): Prop => ({ name, type: 'UInt32Property', value: (w) => w.u32(v) });
const u16 = (name: string, v: number, index: number): Prop => ({ name, type: 'UInt16Property', index, value: (w) => w.bytes(Buffer.from([v & 0xff, v >> 8])) });
const i16 = (name: string, v: number, index: number): Prop => ({ name, type: 'Int16Property', index, value: (w) => w.i16(v) });
const byte = (name: string, v: number): Prop => ({ name, type: 'ByteProperty', inner: 'None', value: (w) => w.u8(v) });
const none = (name: string): Prop => ({ name, type: 'ObjectProperty', value: (w) => w.i32(0).i32(-1) });
const shortNone = (name: string): Prop => ({ name, type: 'ObjectProperty', value: (w) => w.i32(-1) });
const empty = (name: string, inner: string): Prop => ({ name, type: 'ArrayProperty', inner, value: (w) => w.i32(0) });
/** An ASCII string stored as UTF-16, which UE4 does not do by itself: has to survive as is. */
const wideAscii = (name: string, s: string): Prop => ({
  name, type: 'StrProperty', value: (w) => w.i32(-(s.length + 1)).bytes(Buffer.concat([Buffer.from(s, 'utf16le'), Buffer.alloc(2)])),
});

/**
 * A shortened ItemNetInfo; `odd` adds encodings the writer would not produce itself. `quantityRaw`
 * is ItemQuantity as stored (pieces - 1), default 1 (two pieces).
 */
function itemInfo(
  id: [number, number], o: { odd?: boolean; stats?: number[]; quantityRaw?: number; blueprint?: string; allowRemoval?: boolean } = {},
): Prop[] {
  const stats = o.stats ?? [0, 0, 0, 0, 0, 0, 0, 0];
  return [
    path('ItemArchetype', `BlueprintGeneratedClass ${o.blueprint ?? RIOT}`),
    struct('ItemId', 'ItemNetID', [u32('ItemID1', id[0]), u32('ItemID2', id[1])]),
    u32('ItemQuantity', o.quantityRaw ?? 1),
    double('CreationTime', 1234.5),
    o.odd ? str('CustomItemName', 'Bär') : str('CustomItemName', 'Plain'),
    o.odd ? wideAscii('CrafterCharacterName', 'Smith') : str('CrafterCharacterName', 'Smith'),
    empty('SteamUserItemID', 'UInt64Property'),
    bool('bIsBlueprint', false),
    bool('bIsEngram', !!o.odd),
    ...(o.allowRemoval === undefined ? [] : [bool('bAllowRemovalFromInventory', o.allowRemoval)]),
    float('ItemDurability', 250),
    o.odd
      ? { name: 'ItemRating', type: 'FloatProperty', value: (w) => w.bytes(Buffer.from([1, 0, 0xc0, 0xff])) } // NaN with payload
      : float('ItemRating', 3.25),
    u32('ExpirationTimeUTC', 1_800_086_400),
    byte('ItemQualityIndex', 4),
    none('ItemCustomClass'),
    ...stats.map((v, i) => u16('ItemStatValues', v, i)),
    ...[0, 1].map((i) => i16('ItemColorID', i === 0 ? -1 : 7, i)),
    empty('CustomItemDatas', 'StructProperty'),
    u64('OwnerPlayerDataID', 123456789n),
    shortNone('LastOwnerPlayer'),
    { name: 'OriginalItemDropLocation', type: 'StructProperty', inner: 'Vector', value: (w) => w.f32(1).f32(2).f32(3) },
    ...(o.odd ? [{ name: 'FancyNewProperty', type: 'FancyProperty', value: (w: Writer) => w.i32(7).i32(8) }] : []),
    bool('bNetInfoFromClient', false),
  ];
}

const entry = (info: Prop[], uploadTime: number): Prop[] => [
  struct('ArkTributeItem', 'ItemNetInfo', info), float('Version', 2), int('UploadTime', uploadTime),
];

function dinoBytes(): Buffer {
  return buildEmbedded([
    { cls: 'Raptor_Character_BP_C', names: ['Raptor_Character_BP_C_1'], props: [int('DinoID1', 11), int('DinoID2', 22), str('TamedName', 'Clever')] },
    { cls: 'DinoCharacterStatusComponent_BP_Raptor_C', names: ['DinoCharacterStatus_BP_Raptor_C_1', 'Raptor_Character_BP_C_1'], props: [float('CurrentStatusValues', 500)] },
  ]);
}

function playerBytes(): Buffer {
  return buildEmbedded([{ cls: 'PrimalPlayerDataBP_C', names: ['PrimalPlayerDataBP_C_1'], props: [u64('PlayerDataID', 123456789n), str('PlayerName', 'Tester')] }]);
}

/** A cluster file with two items (the second with odd encodings), a creature and a character. */
function clusterFile(): Buffer {
  const data = [
    structArray('ArkItems', [entry(itemInfo([100, 200]), 1_800_000_000), entry(itemInfo([300, 400], { odd: true, stats: [1, 2, 3, 4, 5, 6, 7, 65535] }), 1_800_000_100)]),
    structArray('ArkTamedDinosData', [[
      str('DinoClassName', "Blueprint'/Game/PrimalEarth/Dinos/Raptor/Raptor_Character_BP.Raptor_Character_BP'"),
      path('DinoClass', 'BlueprintGeneratedClass /Game/PrimalEarth/Dinos/Raptor/Raptor_Character_BP.Raptor_Character_BP_C'),
      bytesArray('DinoData', dinoBytes()), str('DinoName', 'Clever - Lvl 150 (Raptor)'),
      str('DinoStats', 'Health: 500.0 / 500.0'), { ...str('DinoStats', 'Stamina: 300.0 / 300.0'), index: 1 },
      float('Version', 2), int('DinoID1', 11), int('DinoID2', 22), int('UploadTime', 1_800_000_200),
    ]]),
    structArray('ArkPlayerData', [[
      u64('PlayerDataID', 123456789n), bytesArray('PlayerDataBytes', playerBytes()), str('PlayerName', 'Tester - Lvl 10'),
      str('UploadingServerMapName', 'TheIsland'), float('Version', 2), int('UploadTime', 1_800_000_300),
    ]]),
  ];
  return buildContainer([{
    cls: 'ArkCloudInventoryData', names: ['ArkCloudInventoryData_7'], isItem: true,
    props: [struct('MyArkData', 'ArkInventoryData', data)], extra: Buffer.alloc(4),
  }], 4);
}

test('writer: FStrings like UE4, buffer growth', () => {
  const w = new BinaryWriter(4);
  w.string('abc').string('Bär').string(null).string('');
  for (let i = 0; i < 1000; i++) w.i32(i);
  const b = w.toBuffer();
  assert.equal(b.readInt32LE(0), 4);
  assert.equal(b.toString('latin1', 4, 7), 'abc');
  assert.equal(b.readInt32LE(8), -4, 'non-ASCII is written as UTF-16');
  assert.equal(b.toString('utf16le', 12, 18), 'Bär');
  assert.equal(b.readInt32LE(20), 0);
  assert.equal(b.readInt32LE(24), 1);
  assert.equal(b.readInt32LE(29 + 999 * 4), 999);
  assert.equal(b.length, 29 + 4000);
});

test('cluster: round trip is byte-identical, odd encodings included', () => {
  const buf = clusterFile();
  const notes = new Map<string, number>();
  const tree = readClusterTree(buf, notes);
  assert.ok(writeClusterTree(tree).equals(buf));
  assert.equal(notes.get('kept original bytes of StrProperty'), 2, 'latin-1 "Bär" and the UTF-16 ASCII name');
  // A NaN with payload survives either way: V8 keeps the bits, otherwise the original bytes are used.
  assert.ok((notes.get('kept original bytes of FloatProperty') ?? 0) <= 1);
  assert.ok([...notes.keys()].some((k) => k.startsWith('opaque FancyProperty')));
  assert.equal(writeClusterTree(readClusterTree(Buffer.alloc(0))).length, 0, 'empty file stays empty');
  // The creature and the character inside are archives of their own and round-trip as well.
  for (const [array, field] of [['ArkTamedDinosData', 'DinoData'], ['ArkPlayerData', 'PlayerDataBytes']]) {
    const bytes = findProperty(clusterEntries(tree, array)[0], field)!.value as Buffer;
    assert.ok(writeContainerTree(readContainerTree(bytes, { version: false })).equals(bytes), field);
  }
});

test('tree: bool bytes other than 0/1 and unusual strings survive, changes are encoded anew', () => {
  const w = new Writer(null);
  w.string('bOdd').string('BoolProperty').i32(0).i32(0).u8(2);
  writeProps(w, [wideAscii('Wide', 'abc')]);
  const buf = w.toBuffer();
  const list = readPropertyList(new Archive(buf));
  assert.equal(list[0].value, true);
  assert.equal(list[1].value, 'abc');
  const write = (l: Property[]) => { const bw = new BinaryWriter(); writePropertyList(bw, l); return bw.toBuffer(); };
  assert.ok(write(list).equals(buf));
  list[0].value = false;
  list[1].value = 'abcd';
  const changed = readPropertyList(new Archive(write(list)));
  assert.equal(changed[0].value, false);
  assert.equal(changed[1].value, 'abcd');
  assert.equal(changed[1].raw, undefined, 'written the usual way now');
});

test('cluster: decoded view', () => {
  const v = readCluster(clusterFile());
  assert.equal(v.objectName, 'ArkCloudInventoryData_7');
  assert.equal(v.items.length, 2);
  const [a, b] = v.items;
  assert.equal(a.blueprint, `BlueprintGeneratedClass ${RIOT}`);
  assert.deepEqual(a.itemId, [100, 200]);
  assert.equal(a.quantityRaw, 1, 'ItemQuantity as stored');
  assert.equal(a.quantity, 2, 'pieces: ItemQuantity + 1');
  assert.equal(a.quality, 4);
  assert.equal(a.rating, 3.25);
  assert.equal(a.durability, 250);
  assert.deepEqual(a.stats, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(a.colors, [-1, 7, null, null, null, null]);
  assert.equal(a.owner, '123456789');
  assert.equal(a.uploadTime, 1_800_000_000);
  assert.equal(a.expiration, 1_800_086_400);
  assert.equal(a.version, 2);
  assert.deepEqual(b.stats, [1, 2, 3, 4, 5, 6, 7, 65535]);
  assert.equal(b.customName, 'Bär');
  assert.equal(b.rating, 'NaN');
  assert.equal(v.dinos.length, 1);
  assert.equal(v.dinos[0].name, 'Clever - Lvl 150 (Raptor)');
  assert.deepEqual(v.dinos[0].dinoId, [11, 22]);
  assert.deepEqual(v.dinos[0].stats.slice(0, 3), ['Health: 500.0 / 500.0', 'Stamina: 300.0 / 300.0', null]);
  assert.deepEqual(v.dinos[0].objects?.map((o) => o.cls), ['Raptor_Character_BP_C', 'DinoCharacterStatusComponent_BP_Raptor_C']);
  assert.equal(v.dinos[0].objects?.[0].props.TamedName, 'Clever');
  assert.equal(v.characters[0].playerDataId, '123456789');
  assert.equal(v.characters[0].map, 'TheIsland');
  assert.equal(v.characters[0].objects?.[0].props.PlayerName, 'Tester');
});

test('cluster: the lossless tree agrees with the export reader', () => {
  const buf = clusterFile();
  const exported = readContainer(buf).objects[0].props;
  const view = readCluster(buf);
  const items = (exported.MyArkData as { ArkItems: { ArkTributeItem: unknown }[] }).ArkItems;
  assert.equal(JSON.stringify(view.items.map((i) => i.info)), JSON.stringify(items.map((e) => e.ArkTributeItem)));
});

test('cluster: changed values are encoded anew, unchanged odd ones stay', () => {
  const buf = clusterFile();
  const tree = readClusterTree(buf)!;
  const info = findProperty(clusterEntries(tree, 'ArkItems')[1], 'ArkTributeItem')!.value as Property[];
  findProperty(info, 'CustomItemName')!.value = 'Bärenfell';
  const out = writeClusterTree(tree);
  assert.equal(out.length, buf.length + 16, 'UTF-16 now: 10 chars incl. NUL (20 bytes) instead of 4 bytes');
  const again = readCluster(out);
  assert.equal(again.items[1].customName, 'Bärenfell');
  assert.equal(again.items[1].crafterName, 'Smith');
  assert.equal(again.items[1].rating, 'NaN');
  assert.ok(writeClusterTree(readClusterTree(out)).equals(out));
});

test('add-item: new item with free values, everything else unchanged', () => {
  const buf = clusterFile();
  const before = readCluster(buf);
  const ids: [number, number][] = [[100, 200], [5, 6]]; // the first one is taken
  const { tree, added } = addItem(readClusterTree(buf), {
    blueprint: "Blueprint'/Game/PrimalEarth/CoreBlueprints/Items/Armor/Riot/PrimalItemArmor_RiotShirt.PrimalItemArmor_RiotShirt'",
    stats: [0, 65535, 40000], quality: 5, rating: 99.5, durability: 1e6, colors: [3], customName: 'Treuebonus',
    crafterName: 'Test Crafter', expiresIn: 3600,
  }, { now: 1_800_000_000, randomId: () => ids.shift()! });
  assert.deepEqual(added, {
    index: 2, itemId: [5, 6], blueprint: `BlueprintGeneratedClass ${RIOT}`, quantity: 1, quantityRaw: 0, allowRemoval: true,
    uploadTime: 1_800_000_000, expiration: 1_800_003_600, owner: '123456789',
  });
  const out = writeClusterTree(tree);
  const v = readCluster(out);
  assert.equal(v.items.length, 3);
  assert.deepEqual(JSON.stringify(v.items.slice(0, 2)), JSON.stringify(before.items));
  assert.deepEqual(JSON.stringify(v.dinos), JSON.stringify(before.dinos));
  const it = v.items[2];
  assert.deepEqual(it.stats, [0, 65535, 40000, 0, 0, 0, 0, 0]);
  assert.deepEqual(it.colors, [3, 0, 0, 0, 0, 0]);
  assert.equal(it.quality, 5);
  assert.equal(it.rating, 99.5);
  assert.equal(it.durability, 1e6);
  assert.equal(it.quantity, 1, 'default: one piece');
  assert.equal(it.quantityRaw, 0, 'one piece is stored as ItemQuantity 0');
  assert.equal(it.isBlueprint, false);
  assert.equal(it.allowRemoval, true, 'without bAllowRemovalFromInventory ARK refuses the download');
  assert.equal(it.customName, 'Treuebonus');
  assert.equal(it.crafterName, 'Test Crafter');
  assert.equal(it.version, 2);
  assert.equal(it.info.ItemProfileVersion, 1);
  assert.equal(it.info.bAllowRemovalFromSteamInventory, true);
  assert.equal(Object.keys(it.info).length, 95);
  // The export reader sees the same file.
  const exported = readContainer(out).objects[0].props.MyArkData as { ArkItems: unknown[] };
  assert.equal(exported.ArkItems.length, 3);
  assert.ok(writeClusterTree(readClusterTree(out)).equals(out));
});

test('add-item: empty file gets the structure the game writes', () => {
  const { tree, added } = addItem(null, { blueprint: '/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_MetalIngot', quantity: 100, owner: '42' }, { now: 1_800_000_000 });
  const out = writeClusterTree(tree);
  assert.deepEqual(out.subarray(0, 8), Buffer.from([4, 0, 0, 0, 1, 0, 0, 0]));
  assert.deepEqual(out.subarray(-4), Buffer.alloc(4));
  const c = readContainer(out);
  assert.equal(c.version, 4);
  assert.equal(c.objects[0].cls, 'ArkCloudInventoryData');
  const v = readCluster(out);
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].quantity, 100);
  assert.equal(v.items[0].quantityRaw, 99, 'a stack of 100 is stored as 99, like the game writes it');
  assert.equal(added.quantity, 100);
  assert.equal(added.quantityRaw, 99);
  assert.equal(v.items[0].owner, '42');
  assert.equal(v.items[0].expiration, 1_800_086_400, 'default expiry is one day, like the servers write it');
  assert.ok(added.itemId.every((x) => x > 0 && x < 1e9));
});

test('add-item: rejects what the file cannot hold', () => {
  const bp = '/Game/PrimalEarth/CoreBlueprints/Items/Armor/Riot/PrimalItemArmor_RiotShirt';
  const tree = () => readClusterTree(clusterFile());
  assert.throws(() => addItem(tree(), { blueprint: bp, stats: [65536] }), /stat 0/);
  assert.throws(() => addItem(tree(), { blueprint: bp, stats: [1, 2, 3, 4, 5, 6, 7, 8, 9] }), /at most 8/);
  assert.throws(() => addItem(tree(), { blueprint: bp, colors: [40000] }), /color 0/);
  assert.throws(() => addItem(tree(), { blueprint: bp, quality: 256 }), /quality/);
  assert.throws(() => addItem(tree(), { blueprint: bp, quantity: 0 }), /quantity must be an integer from 1/);
  assert.throws(() => addItem(tree(), { blueprint: bp, quantity: 1.5 }), /quantity/);
  assert.throws(() => addItem(tree(), { blueprint: bp, quantity: 2 ** 32 + 1 }), /quantity/);
  assert.throws(() => addItem(tree(), { blueprint: bp, durability: 1e39 }), /durability/);
  assert.throws(() => addItem(tree(), { blueprint: bp, expiration: 2 ** 32 }), /expiration/);
  assert.throws(() => addItem(tree(), { blueprint: bp, itemId: [300, 400] }), /already in the file/);
  assert.throws(() => addItem(tree(), { blueprint: 'Rex' }), /not an item class path/);
});

const INGOT = '/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_MetalIngot.PrimalItemResource_MetalIngot_C';
const AMMO = '/Game/PrimalEarth/CoreBlueprints/Items/Weapons/PrimalItemAmmo_SimpleBullet.PrimalItemAmmo_SimpleBullet_C';

type Stored = { ItemQuantity: number; bAllowRemovalFromInventory?: boolean; bIsBlueprint?: boolean };
/** The ItemNetInfos straight from the bytes, with the export reader (not the cluster view). */
const storedInfos = (buf: Buffer): Stored[] =>
  (readContainer(buf).objects[0].props.MyArkData as { ArkItems: { ArkTributeItem: Stored }[] }).ArkItems.map((e) => e.ArkTributeItem);
const storedQuantities = (buf: Buffer): number[] => storedInfos(buf).map((i) => i.ItemQuantity);

test('cluster: ItemQuantity is pieces - 1, as in files the game wrote', () => {
  // Like real uploads: a full stack of 100 stores 99, a full stack of 50 stores 49, a single item 0.
  const buf = buildContainer([{
    cls: 'ArkCloudInventoryData', names: ['ArkCloudInventoryData_0'], isItem: true, extra: Buffer.alloc(4),
    props: [struct('MyArkData', 'ArkInventoryData', [structArray('ArkItems', [
      entry(itemInfo([1, 1], { blueprint: INGOT, quantityRaw: 99, allowRemoval: true }), 1_800_000_000),
      entry(itemInfo([2, 2], { blueprint: AMMO, quantityRaw: 49, allowRemoval: false }), 1_800_000_000),
      entry(itemInfo([3, 3], { quantityRaw: 0 }), 1_800_000_000),
    ])])],
  }], 4);
  const v = readCluster(buf);
  assert.deepEqual(v.items.map((i) => i.quantity), [100, 50, 1]);
  assert.deepEqual(v.items.map((i) => i.quantityRaw), [99, 49, 0]);
  assert.deepEqual(v.items.map((i) => i.allowRemoval), [true, false, null]);
  assert.ok(writeClusterTree(readClusterTree(buf)).equals(buf));
});

test('add-item: downloadable items: ItemQuantity = pieces - 1 and bAllowRemovalFromInventory = true', () => {
  let tree = readClusterTree(clusterFile());
  const added = [];
  for (const [blueprint, quantity] of [[RIOT, 1], [AMMO, 50], [INGOT, 100]] as const) {
    const r = addItem(tree, { blueprint, quantity }, { now: 1_800_000_000 });
    tree = r.tree;
    added.push(r.added);
  }
  assert.deepEqual(added.map((a) => [a.quantity, a.quantityRaw]), [[1, 0], [50, 49], [100, 99]]);
  const out = writeClusterTree(tree);
  assert.deepEqual(storedQuantities(out), [1, 1, 0, 49, 99], 'the two fixture items store 1 each');
  assert.deepEqual(storedInfos(out).slice(2).map((i) => i.bAllowRemovalFromInventory), [true, true, true]);
  const v = readCluster(out);
  assert.deepEqual(v.items.map((i) => i.quantity), [2, 2, 1, 50, 100]);
  // Round trip: read, write, read again gives the same bytes and the same pieces.
  const again = writeClusterTree(readClusterTree(out));
  assert.ok(again.equals(out));
  assert.deepEqual(readCluster(again).items.map((i) => i.quantity), [2, 2, 1, 50, 100]);
});

test('add-item: blueprints get bAllowRemovalFromInventory too, unless switched off', () => {
  const bp = addItem(null, { blueprint: RIOT, isBlueprint: true, owner: 1 }, { now: 1_800_000_000 });
  const off = addItem(null, { blueprint: INGOT, quantity: 50, allowRemoval: false, owner: 1 }, { now: 1_800_000_000 });
  assert.equal(bp.added.allowRemoval, true);
  assert.equal(off.added.allowRemoval, false);
  const [b] = storedInfos(writeClusterTree(bp.tree));
  assert.deepEqual([b.bIsBlueprint, b.bAllowRemovalFromInventory, b.ItemQuantity], [true, true, 0]);
  const [o] = storedInfos(writeClusterTree(off.tree));
  assert.deepEqual([o.bAllowRemovalFromInventory, o.ItemQuantity], [false, 49]);
});

test('itemArchetype accepts the usual spellings', () => {
  const want = `BlueprintGeneratedClass ${RIOT}`;
  for (const s of [
    "Blueprint'/Game/PrimalEarth/CoreBlueprints/Items/Armor/Riot/PrimalItemArmor_RiotShirt.PrimalItemArmor_RiotShirt'",
    '"Blueprint\'/Game/PrimalEarth/CoreBlueprints/Items/Armor/Riot/PrimalItemArmor_RiotShirt.PrimalItemArmor_RiotShirt\'"',
    RIOT, RIOT.slice(0, -2), '/Game/PrimalEarth/CoreBlueprints/Items/Armor/Riot/PrimalItemArmor_RiotShirt', want,
  ]) assert.equal(itemArchetype(s), want, s);
  assert.throws(() => itemArchetype('/Game/A/B.C_C'), /does not match/);
});

test('item template: one field per name and index', () => {
  const e = tributeItemEntry({
    archetype: `BlueprintGeneratedClass ${RIOT}`, itemId: [1, 2], quantityRaw: 0, quality: 0, rating: 0, durability: 0, stats: [], colors: [],
    isBlueprint: true, allowRemoval: false, customName: null, customDescription: null, crafterName: null, crafterTribe: null, ammo: 0, owner: 0n,
    uploadTime: 0, expiration: 0,
  });
  const info = e[0].value as Property[];
  assert.equal(info.length, 95);
  assert.equal(new Set(info.map((p) => `${p.name}[${p.index}]`)).size, 95);
  assert.equal(findProperty(info, 'bIsBlueprint')!.value, true);
  assert.equal(findProperty(info, 'bAllowRemovalFromInventory')!.value, false);
});

test('cluster CLI: check, add-item --out / --in-place, refuses when the file changed meanwhile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ark-cluster-'));
  try {
    const src = join(dir, '76561190000000001');
    writeFileSync(src, clusterFile(), { mode: 0o600 });
    writeFileSync(join(dir, '76561190000000002'), '');
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'cluster', ...args], { encoding: 'utf8' });

    const check = run('check', dir);
    assert.equal(check.status, 0, check.stderr);
    const report = JSON.parse(check.stdout);
    assert.equal(report.identical, 1);
    assert.equal(report.empty, 1);
    assert.equal(report.embedded.identical, 2);

    const out = join(dir, 'out');
    const r1 = run('add-item', src, '--blueprint', RIOT, '--stats', '0,1000', '--expires-at', '2027-01-01T00:00:00Z', '--out', out);
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(JSON.parse(r1.stdout).added.expiration, Date.parse('2027-01-01T00:00:00Z') / 1000);
    assert.deepEqual([JSON.parse(r1.stdout).added.quantity, JSON.parse(r1.stdout).added.quantityRaw], [1, 0]);
    assert.equal(readCluster(readFileSync(out)).items.length, 3);
    assert.ok(readFileSync(src).equals(clusterFile()), '--out leaves the input alone');
    assert.notEqual(run('add-item', src, '--blueprint', RIOT, '--out', out).status, 0, 'existing --out needs --force');
    assert.notEqual(run('add-item', src, '--blueprint', RIOT, '--in-place').status, 0, '--in-place needs --backup');

    const ingots = join(dir, 'ingots');
    const r3 = run('add-item', src, '--blueprint', INGOT, '--quantity', '100', '--out', ingots);
    assert.equal(r3.status, 0, r3.stderr);
    assert.deepEqual([JSON.parse(r3.stdout).added.quantity, JSON.parse(r3.stdout).added.quantityRaw], [100, 99]);
    assert.deepEqual(storedQuantities(readFileSync(ingots)).at(-1), 99);
    const shown = run('show', ingots);
    assert.equal(shown.status, 0, shown.stderr);
    const last = JSON.parse(shown.stdout).items.at(-1);
    assert.deepEqual([last.quantity, last.quantityRaw, last.allowRemoval], [100, 99, true]);
    const locked = join(dir, 'locked');
    assert.equal(run('add-item', src, '--blueprint', INGOT, '--disallow-removal', '--out', locked).status, 0);
    assert.equal(storedInfos(readFileSync(locked)).at(-1)!.bAllowRemovalFromInventory, false);
    assert.notEqual(run('add-item', src, '--blueprint', INGOT, '--quantity', '0', '--out', join(dir, 'zero')).status, 0, 'at least one piece');

    const r2 = run('add-item', src, '--blueprint', RIOT, '--in-place', '--backup', join(dir, 'bak'));
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(readCluster(readFileSync(src)).items.length, 3);
    assert.equal(statSync(src).mode & 0o777, 0o600, 'mode kept');
    const backups = readdirSync(join(dir, 'bak'));
    assert.equal(backups.length, 1);
    assert.ok(readFileSync(join(dir, 'bak', backups[0])).equals(clusterFile()));

    // Someone else wrote the file after it was read: nothing is replaced.
    const current = readFileSync(src);
    assert.throws(() => replaceFile(src, clusterFile(), Buffer.from('new'), join(dir, 'bak')), /changed while editing/);
    assert.ok(readFileSync(src).equals(current));
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'no temporary file left');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
