// Swapping and removing classes (mods): remap-classes and remove-classes on synthetic saves.
// All saves are synthetic (test/build.ts); real saves hold player data and stay out of the repo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ClassEvidence, ClassRemapper, classOfPath, inOrigin, OwnerIndex, parseMapping } from '../src/classes.ts';
import { SaveEditor } from '../src/editor.ts';
import { decodeBlob } from '../src/embedded.ts';
import { aggregateRefunds, refundCsv, removeClasses } from '../src/removal.ts';
import { readSave } from '../src/savegame.ts';
import { type Property, readContainerTree, writeContainerTree } from '../src/tree.ts';
import { checkConsistency, verifySave } from '../src/verify.ts';
import {
  bool, buildContainer, buildEmbedded, buildSave, bytesArray, double, float, int, type Obj, path, type Prop, ref, str, struct, structArray, Writer,
  writeProps,
} from './build.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TRIBE = 1234567;
const OTHER = 7654321;

const MOD = '/Game/Mods/ModPack';
const P = {
  box: `${MOD}/Box/BP_ModBox.BP_ModBox_C`,
  boxItem: `${MOD}/Box/PrimalItemStructure_ModBox.PrimalItemStructure_ModBox_C`,
  boxInv: `${MOD}/Box/PrimalInventory_ModBox.PrimalInventory_ModBox_C`,
  raptor: `${MOD}/Dinos/ModRaptor_Character_BP.ModRaptor_Character_BP_C`,
  saddle: `${MOD}/Saddles/PrimalItemArmor_ModSaddle.PrimalItemArmor_ModSaddle_C`,
  modFire: `${MOD}/Fire/Campfire.Campfire_C`,
  coreFire: '/Game/PrimalEarth/Structures/Campfire.Campfire_C',
  vBox: '/Game/PrimalEarth/Structures/StorageBox_Large.StorageBox_Large_C',
  vBoxItem: '/Game/PrimalEarth/CoreBlueprints/Items/Structures/Misc/PrimalItemStructure_StorageBox_Large.PrimalItemStructure_StorageBox_Large_C',
  vRaptor: '/Game/PrimalEarth/Dinos/Raptor/Raptor_Character_BP.Raptor_Character_BP_C',
  soul: '/Game/Mods/Storage/SoulTrap.SoulTrap_C',
};
const BGC = (p: string): string => `BlueprintGeneratedClass ${p}`;

const nameProp = (name: string, v: string): Prop => ({ name, type: 'NameProperty', value: (w) => w.name(v) });
const strs = (name: string, list: string[]): Prop => ({
  name, type: 'ArrayProperty', inner: 'StrProperty', value: (w) => { w.i32(list.length); for (const s of list) w.string(s); },
});
const paths = (name: string, list: string[]): Prop => ({
  name, type: 'ArrayProperty', inner: 'ObjectProperty', value: (w) => { w.i32(list.length); for (const p of list) w.i32(1).name(p); },
});
const refs = (name: string, indices: number[]): Prop => ({
  name, type: 'ArrayProperty', inner: 'ObjectProperty', value: (w) => { w.i32(indices.length); for (const i of indices) w.i32(0).i32(i); },
});
const itemId = (a: number, b: number): Prop => struct('ItemId', 'ItemNetID', [int('ItemID1', a), int('ItemID2', b)]);

function structure(cls: string, name: string, loc: [number, number, number], team: number, more: Prop[] = []): Obj {
  return {
    cls, names: [name], loc,
    props: [int('TargetingTeam', team), str('OwnerName', team === TRIBE ? 'Tribe of Test' : 'Others'), float('MaxHealth', 1000), double('LastInAllyRangeTime', 10), ...more],
    extra: Buffer.alloc(4),
  };
}

function item(cls: string, name: string, id: number, inv: number, more: Prop[] = []): Obj {
  return { cls, names: [name], isItem: true, props: [itemId(id, id + 1), ref('OwnerInventory', inv), ...more], extra: Buffer.alloc(4) };
}

/**
 * Creature with status and inventory component as a cryopod or soul payload. Actors there carry their
 * level in the name list, components name their actor second (as in real saves). itemCls puts an item
 * object into the archive itself (not seen in real saves, which keep saddles next to the archive).
 */
function creature(cls: string, name: string, team: number, itemCls: string | null = null): Buffer {
  const level = ['PersistentLevel', 'TestMap', '/Game/Maps/TestMap'];
  const objs: Obj[] = [
    { cls, names: [name, ...level], props: [int('DinoID1', 5), int('DinoID2', 6), int('TargetingTeam', team), str('TribeName', 'Tribe of Test'), ref('MyCharacterStatusComponent', 1), ref('MyInventoryComponent', 2)] },
    { cls: 'DinoCharacterStatusComponent_BP_C', names: [`DinoCharacterStatus_BP_C_${name}`, name, ...level], props: [float('CurrentStatusValues', 100)] },
    { cls: 'PrimalInventoryComponent_Dino_C', names: [`PrimalInventory_Dino_C_${name}`, name, ...level], props: [refs('InventoryItems', itemCls ? [3] : [])] },
  ];
  if (itemCls) objs.push({ cls: itemCls, names: [`${itemCls}_1`], isItem: true, props: [itemId(900, 901), ref('OwnerInventory', 2), bool('bIsEquipped', true)] });
  return buildEmbedded(objs);
}

/** A property list serialized into bytes (inline names). */
function listBytes(list: Prop[]): Buffer {
  const w = new Writer(null);
  writeProps(w, list);
  return w.toBuffer();
}

/** Item net info of an item kept next to a creature (saddle in a cryopod). */
const itemInfo = (archetype: string, id: number): Buffer => listBytes([path('ItemArchetype', BGC(archetype)), itemId(id, id + 1), bool('bIsEquipped', true)]);

function cryopod(name: string, id: number, inv: number, payload: Buffer, dinoPath: string, saddle: Buffer = Buffer.alloc(0)): Obj {
  return item('PrimalItem_WeaponEmptyCryopod_C', name, id, inv, [
    path('ItemArchetype', BGC('/Game/Extinction/CoreBlueprints/Weapons/PrimalItem_WeaponEmptyCryopod.PrimalItem_WeaponEmptyCryopod_C')),
    structArray('CustomItemDatas', [[
      nameProp('CustomDataName', 'Dino'),
      paths('CustomDataClasses', [BGC(dinoPath)]),
      struct('CustomDataBytes', 'CustomItemByteArrays', [structArray('ByteArrays', [[bytesArray('Bytes', payload)], [bytesArray('Bytes', saddle)]])]),
    ]]),
  ]);
}

/** Serialized item info of a soul trap (Dino Storage) with a creature inside. */
function soulInfo(id: number, payload: Buffer): Buffer {
  return listBytes([
    path('ItemArchetype', BGC(P.soul)), itemId(id, id + 1), str('CustomItemName', 'Soul'),
    structArray('CustomItemDatas', [[
      nameProp('CustomDataName', 'Dino'),
      struct('CustomDataBytes', 'CustomItemByteArrays', [structArray('ByteArrays', [[bytesArray('Bytes', payload)]])]),
    ]]),
  ]);
}

// ---------------------------------------------------------------- remap

/**
 * 0 mod box (BP_ModBox_C) with 1 inventory (mod class, not mapped) holding 2 its own item and 3 a
 * cryopod with a mod raptor; 4 vanilla large box with recipes (mod, core and mod campfire paths),
 * a buff class string and a name property; 5 a campfire (ambiguous short name); 6 an object of a
 * class nothing proves (BP_Unknown_C); 7 an untouched wall.
 */
function remapSave(): Buffer {
  return buildSave([
    structure('BP_ModBox_C', 'BP_ModBox_C_1', [100, 100, 0], TRIBE, [ref('MyInventoryComponent', 1), int('ModOnlyProp', 3), int('CurrentItemCount', 2)]),
    { cls: 'PrimalInventory_ModBox_C', names: ['PrimalInventory_ModBox_C_1', 'BP_ModBox_C_1'], props: [refs('InventoryItems', [2, 3])], extra: Buffer.alloc(4) },
    item('PrimalItemStructure_ModBox_C', 'PrimalItemStructure_ModBox_C_4', 11, 1, [path('ItemArchetype', BGC(P.boxItem)), int('ItemQuantity', 2)]),
    cryopod('PrimalItem_WeaponEmptyCryopod_C_1', 13, 1, creature('ModRaptor_Character_BP_C', 'ModRaptor_Character_BP_C_7', TRIBE), P.raptor),
    structure('StorageBox_Large_C', 'StorageBox_Large_C_9', [5000, 0, 0], OTHER, [
      paths('CraftingStationRecipes', [BGC(P.boxItem), BGC(P.coreFire), BGC(P.modFire)]),
      str('ForPrimalBuffClassString', `,${P.boxItem.replace(/_C$/, '')}|0`),
      nameProp('SomeClassName', 'BP_ModBox_C'), int('CurrentItemCount', 0),
    ]),
    structure('Campfire_C', 'Campfire_C_2', [200, 0, 0], TRIBE),
    structure('BP_Unknown_C', 'BP_Unknown_C_1', [300, 0, 0], TRIBE),
    structure('Wall_Wood_C', 'Wall_Wood_C_1', [400, 0, 0], TRIBE),
  ], { map: 'TestMap' });
}

const MAPPING = [
  'old_class\tnew_class\told_path\tnew_path\tonly_mod_package',
  `BP_ModBox_C\tStorageBox_Large_C\t${P.box}\t${P.vBox}\tModPack`,
  `PrimalItemStructure_ModBox_C\tPrimalItemStructure_StorageBox_Large_C\t${P.boxItem}\t${P.vBoxItem}\t`,
  '# creatures',
  `ModRaptor_Character_BP_C\tRaptor_Character_BP_C\t${P.raptor}\t${P.vRaptor}\t/Game/Mods/ModPack`,
  `Campfire_C\tCampfirePlus_C\t${P.modFire}\t/Game/Mods/Other/CampfirePlus.CampfirePlus_C\t`,
  `BP_Unknown_C\tStorageBox_Small_C\t/Game/Mods/Gone/BP_Unknown.BP_Unknown_C\t/Game/PrimalEarth/Structures/StorageBox_Small.StorageBox_Small_C\t`,
].join('\n');

const ASSETS = [`${MOD}/Box/BP_ModBox`, `${MOD}/Box/PrimalInventory_ModBox`, `${MOD}/Fire/Campfire`, 'Campfire', 'StorageBox_Large'].join('\n');

function profileFile(engrams: string[]): Buffer {
  return buildContainer([
    {
      cls: 'PrimalPlayerDataBP_C', names: ['PrimalPlayerDataBP_C_1', 'ArkGameMode', 'PersistentLevel', 'TestMap'],
      props: [struct('MyData', 'PrimalPlayerDataStruct', [str('PlayerName', 'Tester'), int('TribeId', TRIBE),
        struct('MyPersistentCharacterStats', 'PrimalPersistentCharacterStatsStruct', [paths('PlayerState_EngramBlueprints', engrams)])])],
    },
  ], 1);
}

function remap(buf: Buffer, opts: { trust?: boolean; assets?: boolean } = {}): { ed: SaveEditor; r: ClassRemapper; out: Buffer; edited: number } {
  const ed = SaveEditor.open(buf);
  const r = new ClassRemapper(parseMapping(MAPPING), { assetList: opts.assets === false ? undefined : ASSETS, trustShortNames: opts.trust });
  r.scanWorld(ed, new OwnerIndex(ed));
  r.decide();
  const edited = r.applyWorld(ed);
  return { ed, r, out: ed.write(), edited };
}

test('mapping file: header, comments, validation', () => {
  const rows = parseMapping(MAPPING);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].onlyPackage, '/Game/Mods/ModPack');
  assert.equal(rows[0].line, 2);
  assert.equal(rows[2].line, 5);
  assert.equal(rows[1].onlyPackage, null);
  // Without header: default column order; class paths in any spelling.
  const plain = parseMapping(`A_C\tB_C\tBlueprint'/Game/Mods/X/A.A'\t/Game/Y/B`);
  assert.equal(plain[0].oldPath, '/Game/Mods/X/A.A_C');
  assert.equal(plain[0].newPath, '/Game/Y/B.B_C');
  assert.throws(() => parseMapping(`A_C\tB_C\t/Game/Mods/X/Other.Other_C\t/Game/Y/B.B_C`), /old_path names Other_C/);
  assert.throws(() => parseMapping(`A_C\tB_C\t\t/Game/Y/B.B_C`), /required/);
  assert.throws(() => parseMapping(`A_C\tB_C\t/Game/Mods/X/A.A_C\t/Game/Y/B.B_C\tOtherMod`), /not inside/);
  assert.throws(() => parseMapping(`A_C\tB_C\t/Game/Mods/X/A.A_C\t/Game/Y/B.B_C\nA_C\tC_C\t/Game/Mods/X/A.A_C\t/Game/Y/C.C_C`), /mapped already/);
  assert.throws(() => parseMapping('# nothing'), /no rows/);
});

test('paths, origins and evidence for short names', () => {
  assert.equal(classOfPath(BGC(P.box)), 'BP_ModBox_C');
  assert.equal(classOfPath('/Game/A/B.B'), 'B_C');
  assert.ok(inOrigin(BGC(P.box), '/Game/Mods/ModPack'));
  assert.ok(!inOrigin(P.box, '/Game/Mods/Mod'));
  assert.ok(inOrigin(P.coreFire, '/Game'));
  assert.ok(!inOrigin(P.modFire, '/Game'));
  const ev = new ClassEvidence();
  ev.seenInText(`,${P.modFire.replace(/_C$/, '')}|0 and ${BGC(P.box)}`);
  assert.equal(ev.check('Campfire_C', MOD).status, 'verified');
  assert.equal(ev.check('Nothing_C', MOD).status, 'unverified');
  ev.loadAssetList('Campfire\n# comment\n');
  const chk = ev.check('Campfire_C', MOD);
  assert.equal(chk.status, 'ambiguous');
  assert.equal(ev.check('Campfire_C', '/Game').status, 'ambiguous');
  assert.deepEqual(ev.origins('BP_ModBox_C'), ['/Game/Mods/ModPack']);
});

test('remap-classes: every layer, package check for short names, instance names stay', () => {
  const buf = remapSave();
  const { r, out, edited } = remap(buf);
  const rep = r.report();
  const row = (c: string) => rep.rows.find((x) => x.oldClass === c)!;

  // Object table: class changes, instance names stay.
  const s = readSave(out);
  assert.equal(s.objects.length, 8);
  assert.equal(s.objects[0].cls, 'StorageBox_Large_C');
  assert.deepEqual(s.objects[0].names, ['BP_ModBox_C_1']);
  assert.equal(s.objects[2].cls, 'PrimalItemStructure_StorageBox_Large_C');
  // Paths: ItemArchetype and recipes with full package match only.
  assert.equal((s.objects[2].props.ItemArchetype as unknown as { path: string }).path, BGC(P.vBoxItem));
  const recipes = (s.objects[4].props.CraftingStationRecipes as { path: string }[]).map((x) => x.path);
  assert.deepEqual(recipes, [BGC(P.vBoxItem), BGC(P.coreFire), BGC('/Game/Mods/Other/CampfirePlus.CampfirePlus_C')]);
  // Strings: path inside a text (without _C), exact class name in a NameProperty.
  assert.equal(s.objects[4].props.ForPrimalBuffClassString, `,${P.vBoxItem.replace(/_C$/, '')}|0`);
  assert.equal(s.objects[4].props.SomeClassName, 'StorageBox_Large_C');
  // Ambiguous and unproven short names keep their headers.
  assert.equal(s.objects[5].cls, 'Campfire_C');
  assert.equal(s.objects[6].cls, 'BP_Unknown_C');
  assert.equal(row('Campfire_C').shortName.status, 'ambiguous');
  assert.equal(row('Campfire_C').skipped['world.header'], 1);
  assert.equal(row('Campfire_C').rewritten['world.path'], 1);
  assert.equal(row('BP_Unknown_C').shortName.status, 'unverified');
  assert.equal(row('BP_Unknown_C').shortName.headerRewrite, false);

  // Cryopod: creature class in the embedded archive, the class path next to it.
  const cryo = SaveEditor.open(out).get(3);
  const datas = cryo.props.find((p) => p.name === 'CustomItemDatas')!.value as Property[][];
  const classes = datas[0].find((p) => p.name === 'CustomDataClasses')!.value as { path: string }[];
  assert.equal(classes[0].path, BGC(P.vRaptor));
  const arrays = (datas[0].find((p) => p.name === 'CustomDataBytes')!.value as Property[])[0].value as Property[][];
  const d = decodeBlob(arrays[0][0].value as Buffer)!;
  assert.equal(d.kind, 'archive');
  if (d.kind === 'archive') {
    assert.equal(d.tree.objects[0].cls, 'Raptor_Character_BP_C');
    assert.deepEqual(d.tree.objects[0].names, ['ModRaptor_Character_BP_C_7', 'PersistentLevel', 'TestMap', '/Game/Maps/TestMap']);
    assert.equal(d.tree.objects[1].names[0], 'DinoCharacterStatus_BP_C_ModRaptor_Character_BP_C_7');
  }
  const raptor = row('ModRaptor_Character_BP_C');
  assert.equal(raptor.rewritten['world.embedded.header'], 1);
  assert.equal(raptor.rewritten['world.path'], 1);
  assert.deepEqual(raptor.tribes.map((t) => t.team), [TRIBE]);
  assert.deepEqual(raptor.components, { DinoCharacterStatusComponent_BP_C: { objects: 1, mapped: false }, PrimalInventoryComponent_Dino_C: { objects: 1, mapped: false } });

  // Report: hits per layer, tribes, components, properties the target lacks, what is left of the package.
  const box = row('BP_ModBox_C');
  assert.equal(box.shortName.status, 'verified');
  assert.deepEqual(box.found, { 'world.header': 1, 'world.string': 1 });
  assert.deepEqual(box.rewritten, box.found);
  assert.deepEqual(box.tribes, [{ team: TRIBE, name: 'Tribe of Test', hits: 1 }, { team: OTHER, name: 'Others', hits: 1 }]);
  assert.deepEqual(box.components, { PrimalInventory_ModBox_C: { objects: 1, mapped: false } });
  assert.deepEqual(box.properties.notOnTarget, { ModOnlyProp: 1, MyInventoryComponent: 1 });
  assert.equal(row('PrimalItemStructure_ModBox_C').properties.notOnTarget, null);
  assert.deepEqual(rep.remaining['/Game/Mods/ModPack'].objects, { PrimalInventory_ModBox_C: 1 });
  assert.deepEqual(rep.remaining['/Game/Mods/ModPack'].ambiguous, { Campfire_C: 1 });
  assert.equal(edited, 4); // box, its item, the cryopod, the vanilla box with recipes

  // Name table: old names stay where they were, new ones are appended.
  const names = (b: Buffer) => SaveEditor.open(b).table.names;
  assert.deepEqual(names(out).slice(0, names(buf).length), names(buf));
  // Unchanged objects keep their bytes; the result is deterministic and reads back byte-identical.
  const before = SaveEditor.open(buf);
  const after = SaveEditor.open(out);
  for (const i of [1, 5, 6, 7]) assert.ok(after.rawObject(i).body.equals(before.rawObject(i).body), `object ${i} unchanged`);
  assert.ok(remap(buf).out.equals(out));
  const v = verifySave(out);
  assert.deepEqual(v.identical, { copy: true, patchAll: true, reencodeAll: true });
  assert.equal(v.embedded.archives, v.embedded.archivesIdentical);
  assert.deepEqual(checkConsistency(after), checkConsistency(before));
});

test('remap-classes: --trust-short-names also rewrites unproven and ambiguous headers', () => {
  const { r, out } = remap(remapSave(), { trust: true });
  const s = readSave(out);
  assert.equal(s.objects[5].cls, 'CampfirePlus_C');
  assert.equal(s.objects[6].cls, 'StorageBox_Small_C');
  assert.equal(r.report().rows.find((x) => x.oldClass === 'BP_Unknown_C')!.shortName.headerRewrite, true);
  // Without an asset list the campfire looks unambiguous (only the mod path is in the save).
  const plain = remap(remapSave(), { assets: false });
  assert.equal(plain.r.report().rows.find((x) => x.oldClass === 'Campfire_C')!.shortName.status, 'ambiguous'); // core path in the recipes
  assert.equal(plain.r.report().assetList, false);
});

test('remap-classes: profiles and tribes (engram lists), only changed files', () => {
  const r = new ClassRemapper(parseMapping(MAPPING), { assetList: ASSETS });
  const a = readContainerTree(profileFile([BGC(P.boxItem), BGC(P.coreFire)]));
  const b = readContainerTree(profileFile([BGC(P.coreFire)]));
  const ed = SaveEditor.open(remapSave());
  r.scanWorld(ed);
  r.scanContainer('a.arkprofile', 'profile', a, { team: TRIBE, name: 'Tester' });
  r.scanContainer('b.arkprofile', 'profile', b, { team: TRIBE, name: 'Tester' });
  r.decide();
  assert.equal(r.applyContainer('a.arkprofile', 'profile', a), true);
  assert.equal(r.applyContainer('b.arkprofile', 'profile', b), false);
  const back = readContainerTree(writeContainerTree(a));
  const stats = ((back.objects[0].props[0].value as Property[])[2].value as Property[])[0].value as { path: string }[];
  assert.deepEqual(stats.map((x) => x.path), [BGC(P.vBoxItem), BGC(P.coreFire)]);
  const row = r.report().rows.find((x) => x.oldClass === 'PrimalItemStructure_ModBox_C')!;
  assert.equal(row.found['profile.path'], 1);
  assert.deepEqual(row.files, { 'a.arkprofile': 1 });
});

// ---------------------------------------------------------------- remove

/**
 * 0 vanilla box (tribe) with 1 inventory: 2 mod saddle, 3 stone, 4 cryopod with a vanilla raptor
 * and a mod saddle next to it, 5 cryopod with a mod raptor, 17 cryopod whose archive holds a mod
 * item object; 6 mod box (BP_ModBox_C) with 7 inventory holding 8 metal; 9 wall linked to the mod
 * box; 10 recovery list with a mod and a vanilla creature; 11 mod raptor in the world with 12
 * status; 13 mod component on the vanilla box; 14 smithy with a recipe of the mod; 15 campfire
 * (short name also in the core game); 16 a copy of the mod box (the game writes some actors twice).
 */
function removeSave(): Buffer {
  const recovery = (dino: string, dinoName: string, id: number): Prop[] => [
    nameProp('CustomDataName', 'Recovery'),
    strs('CustomDataStrings', [`${id} ${dinoName}`]),
    struct('CustomDataBytes', 'CustomItemByteArrays', [structArray('ByteArrays', [[bytesArray('Bytes', soulInfo(id, creature(dino, dinoName, OTHER)))]])]),
  ];
  return buildSave([
    structure('StorageBox_Large_C', 'StorageBox_Large_C_1', [1000, 1000, 0], TRIBE, [ref('MyInventoryComponent', 1), int('CurrentItemCount', 5)]),
    { cls: 'PrimalInventoryBP_StorageBox_Large_C', names: ['PrimalInventoryBP_StorageBox_Large_C_1', 'StorageBox_Large_C_1'], props: [refs('InventoryItems', [2, 3, 4, 5, 17])], extra: Buffer.alloc(4) },
    item('PrimalItemArmor_ModSaddle_C', 'PrimalItemArmor_ModSaddle_C_1', 21, 1, [path('ItemArchetype', BGC(P.saddle)), bool('bIsBlueprint', true)]),
    item('PrimalItemResource_Stone_C', 'PrimalItemResource_Stone_C_1', 23, 1, [int('ItemQuantity', 50)]),
    cryopod('PrimalItem_WeaponEmptyCryopod_C_1', 25, 1, creature('Raptor_Character_BP_C', 'Raptor_Character_BP_C_3', TRIBE), P.vRaptor, itemInfo(P.saddle, 41)),
    cryopod('PrimalItem_WeaponEmptyCryopod_C_2', 27, 1, creature('ModRaptor_Character_BP_C', 'ModRaptor_Character_BP_C_4', TRIBE), P.raptor),
    structure('BP_ModBox_C', 'BP_ModBox_C_1', [5000, 5000, 100], OTHER, [ref('MyInventoryComponent', 7), refs('LinkedStructures', [9])]),
    { cls: 'PrimalInventory_ModBox_C', names: ['PrimalInventory_ModBox_C_1', 'BP_ModBox_C_1'], props: [refs('InventoryItems', [8])], extra: Buffer.alloc(4) },
    item('PrimalItemResource_MetalIngot_C', 'PrimalItemResource_MetalIngot_C_1', 29, 7, [int('ItemQuantity', 100)]),
    structure('Wall_Wood_C', 'Wall_Wood_C_1', [5000, 5300, 100], OTHER, [refs('LinkedStructures', [6])]),
    { cls: 'DinoStorage2CCA_C', names: ['DinoStorage2CCA_C_0'], props: [structArray('CCA Misc Data', [recovery('ModRaptor_Character_BP_C', 'ModRaptor_Character_BP_C_9', 31), recovery('Raptor_Character_BP_C', 'Raptor_Character_BP_C_9', 33)])], extra: Buffer.alloc(4) },
    {
      cls: 'ModRaptor_Character_BP_C', names: ['ModRaptor_Character_BP_C_1'], loc: [9000, 9000, 0],
      props: [int('DinoID1', 1), int('DinoID2', 2), int('TargetingTeam', TRIBE), str('TribeName', 'Tribe of Test'), ref('MyCharacterStatusComponent', 12)],
      extra: new Writer(null).i32(0).i32(1).toBuffer(),
    },
    { cls: 'DinoCharacterStatusComponent_BP_ModRaptor_C', names: ['DinoCharacterStatus_BP_ModRaptor_C_1', 'ModRaptor_Character_BP_C_1'], props: [float('CurrentStatusValues', 1)], extra: Buffer.alloc(4) },
    { cls: 'ModExtraComponent_C', names: ['ModExtraComponent_C_1', 'StorageBox_Large_C_1'], props: [int('X', 1)], extra: Buffer.alloc(4) },
    structure('Smithy_C', 'Smithy_C_1', [1200, 1000, 0], TRIBE, [paths('CraftingStationRecipes', [BGC(P.saddle), BGC(P.coreFire)])]),
    structure('Campfire_C', 'Campfire_C_1', [1300, 1000, 0], TRIBE),
    structure('BP_ModBox_C', 'BP_ModBox_C_1', [5000, 5000, 100], OTHER, [ref('MyInventoryComponent', 7), refs('LinkedStructures', [9])]),
    cryopod('PrimalItem_WeaponEmptyCryopod_C_3', 43, 1, creature('Raptor_Character_BP_C', 'Raptor_Character_BP_C_5', TRIBE, 'PrimalItemArmor_ModSaddle_C'), P.vRaptor),
  ], { map: 'TestMap' });
}

const REMOVE_ASSETS = [
  `${MOD}/Box/BP_ModBox`, `${MOD}/Box/PrimalInventory_ModBox`, `${MOD}/Dinos/ModRaptor_Character_BP`, `${MOD}/Dinos/DinoCharacterStatusComponent_BP_ModRaptor`,
  `${MOD}/Saddles/PrimalItemArmor_ModSaddle`, `${MOD}/ModExtraComponent`, `${MOD}/Fire/Campfire`, 'Campfire',
].join('\n');

test('remove-classes: world, foreign inventories, cryopods, recovery list, refund list', () => {
  const buf = removeSave();
  const ed = SaveEditor.open(buf);
  const { report: r, refunds } = removeClasses(ed, { packages: ['ModPack'], assetList: REMOVE_ASSETS });
  const out = ed.write();

  const removed = Object.fromEntries(r.classes.map((c) => [c.cls, c.removed]));
  assert.deepEqual(removed, {
    BP_ModBox_C: true, ModRaptor_Character_BP_C: true, PrimalItemArmor_ModSaddle_C: true, Campfire_C: false,
    DinoCharacterStatusComponent_BP_ModRaptor_C: true, ModExtraComponent_C: true, PrimalInventory_ModBox_C: true,
  });
  assert.match(r.classes.find((c) => c.cls === 'Campfire_C')!.why!, /short name also in/);
  // 2 mod boxes + inventory + metal, saddle, cryopod with mod raptor, world raptor + status.
  assert.equal(r.removed, 8);
  assert.equal(r.itemsInOtherInventories, 1);
  assert.deepEqual(r.componentsKept, { ModExtraComponent_C: 1 });
  assert.deepEqual(r.pathReferencesLeft, { CraftingStationRecipes: 1 });
  assert.deepEqual(r.embedded, { archivesChanged: 1, objectsRemoved: 2, entriesDropped: { 'CCA Misc Data': 1 }, notRewritable: 0, unremovable: 0 });
  assert.equal(r.countersSynced, 1);

  const s = readSave(out);
  assert.equal(s.objects.length, 18 - 8);
  const byName = new Map(s.objects.map((o) => [o.names.join('/'), o]));
  const box = byName.get('StorageBox_Large_C_1')!;
  assert.equal(box.props.CurrentItemCount, 3); // stone and the two cryopods with vanilla raptors
  const inv = byName.get('PrimalInventoryBP_StorageBox_Large_C_1/StorageBox_Large_C_1')!;
  assert.deepEqual((inv.props.InventoryItems as { index: number }[]).map((x) => s.objects[x.index]?.names[0]),
    ['PrimalItemResource_Stone_C_1', 'PrimalItem_WeaponEmptyCryopod_C_1', 'PrimalItem_WeaponEmptyCryopod_C_3']);
  assert.deepEqual(byName.get('Wall_Wood_C_1')!.props.LinkedStructures, []);
  assert.ok(byName.has('ModExtraComponent_C_1/StorageBox_Large_C_1'));
  // Cryopods keep their raptors. The saddle next to the archive leaves an empty slot; the item
  // object inside the other archive is gone, also from the creature's inventory list.
  const cryo = SaveEditor.open(out);
  const slots = (name: string): Buffer[] => {
    const ci = s.objects.findIndex((o) => o.names[0] === name);
    const datas = cryo.get(ci).props.find((p) => p.name === 'CustomItemDatas')!.value as Property[][];
    return ((datas[0].find((p) => p.name === 'CustomDataBytes')!.value as Property[])[0].value as Property[][]).map((e) => e[0].value as Buffer);
  };
  const [dino1, saddle1] = slots('PrimalItem_WeaponEmptyCryopod_C_1');
  assert.equal(saddle1.length, 0);
  assert.equal(decodeBlob(dino1)?.kind, 'archive');
  const d = decodeBlob(slots('PrimalItem_WeaponEmptyCryopod_C_3')[0])!;
  assert.ok(d.kind === 'archive');
  if (d.kind === 'archive') {
    assert.deepEqual(d.tree.objects.map((o) => o.cls), ['Raptor_Character_BP_C', 'DinoCharacterStatusComponent_BP_C', 'PrimalInventoryComponent_Dino_C']);
    assert.deepEqual(d.tree.objects[2].props[0].value, []);
  }
  // Recovery list: the entry with the mod raptor is gone.
  const cca = s.objects.find((o) => o.cls === 'DinoStorage2CCA_C')!;
  assert.equal((cca.props['CCA Misc Data'] as unknown[]).length, 1);

  // Refund list: once per actor (the doubled box counts once), contents marked as such.
  const rows = aggregateRefunds(refunds);
  const key = (x: { team: number | null; reason: string; kind: string; cls: string; holder: string }) => `${x.team}|${x.reason}|${x.kind}|${x.cls}|${x.holder}`;
  assert.deepEqual(rows.map(key).sort(), [
    `${OTHER}|class|dino|ModRaptor_Character_BP_C|SoulTrap_C in DinoStorage2CCA_C`,
    `${OTHER}|class|structure|BP_ModBox_C|`,
    `${OTHER}|content|item|PrimalItemResource_MetalIngot_C|BP_ModBox_C`,
    `${OTHER}|content|item|SoulTrap_C|DinoStorage2CCA_C`,
    `${TRIBE}|class|dino|ModRaptor_Character_BP_C|`,
    `${TRIBE}|class|dino|ModRaptor_Character_BP_C|PrimalItem_WeaponEmptyCryopod_C in StorageBox_Large_C`,
    `${TRIBE}|class|item|PrimalItemArmor_ModSaddle_C|PrimalItem_WeaponEmptyCryopod_C in StorageBox_Large_C`,
    `${TRIBE}|class|item|PrimalItemArmor_ModSaddle_C|Raptor_Character_BP_C in PrimalItem_WeaponEmptyCryopod_C in StorageBox_Large_C`,
    `${TRIBE}|class|item|PrimalItemArmor_ModSaddle_C|StorageBox_Large_C`,
    `${TRIBE}|content|item|PrimalItem_WeaponEmptyCryopod_C|StorageBox_Large_C`,
  ].sort());
  const metal = rows.find((x) => x.cls === 'PrimalItemResource_MetalIngot_C')!;
  assert.deepEqual([metal.objects, metal.quantity, metal.x, metal.y, metal.z, metal.tribeName], [1, 100, 5000, 5000, 100, 'Others']);
  assert.equal(rows.find((x) => x.cls === 'PrimalItemArmor_ModSaddle_C' && x.holder === 'StorageBox_Large_C')!.blueprint, true);
  const csv = refundCsv('TestMap', rows);
  assert.match(csv, /^map,tribe_id,tribe_name,reason,kind,class,blueprint,objects,quantity,holder,x,y,z\n/);
  assert.match(csv, new RegExp(`TestMap,${TRIBE},Tribe of Test,class,item,PrimalItemArmor_ModSaddle_C,1,1,1,StorageBox_Large_C,1000,1000,0`));

  // The written save is consistent and reads back byte-identically.
  const c = checkConsistency(SaveEditor.open(out));
  assert.equal(c.refsOutOfRange, 0);
  assert.equal(c.orphanComponents, 0);
  const v = verifySave(out);
  assert.deepEqual(v.identical, { copy: true, patchAll: true, reencodeAll: true });
  assert.equal(v.embedded.archives, v.embedded.archivesIdentical);
  assert.equal(v.embedded.propertyLists, v.embedded.propertyListsIdentical);
});

test('remove-classes: class patterns refuse ambiguous names unless trusted', () => {
  const ev = 'Campfire\n' + REMOVE_ASSETS;
  let ed = SaveEditor.open(removeSave());
  let r = removeClasses(ed, { classes: ['Campfire_C', 'PrimalItemArmor_ModSaddle_C'], assetList: ev }).report;
  assert.deepEqual(r.classes.map((c) => [c.cls, c.removed]), [['PrimalItemArmor_ModSaddle_C', true], ['Campfire_C', false]]);
  assert.equal(readSave(ed.write()).objects.some((o) => o.cls === 'Campfire_C'), true);
  ed = SaveEditor.open(removeSave());
  r = removeClasses(ed, { classes: ['Campfire_C'], assetList: ev, trustShortNames: true }).report;
  assert.equal(r.removed, 1);
  assert.equal(readSave(ed.write()).objects.some((o) => o.cls === 'Campfire_C'), false);
  assert.throws(() => removeClasses(SaveEditor.open(removeSave()), {}), /nothing to remove/);
});

test('CLI: remap-classes and remove-classes, dry run writes nothing, profiles into --out-dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ark-classes-'));
  try {
    const saves = join(dir, 'saves');
    mkdirSync(saves);
    const save = join(saves, 'TestMap.ark');
    writeFileSync(save, remapSave());
    writeFileSync(join(saves, '42.arkprofile'), profileFile([BGC(P.boxItem)]));
    writeFileSync(join(saves, '43.arkprofile'), profileFile([BGC(P.coreFire)]));
    writeFileSync(join(saves, '7.arktribe'), buildContainer([{ cls: 'PrimalTribeData', names: ['PrimalTribeData_1'], props: [struct('TribeData', 'TribeData', [str('TribeName', 'T'), int('TribeId', 7)])] }], 1));
    const mapping = join(dir, 'map.tsv');
    writeFileSync(mapping, MAPPING);
    const assets = join(dir, 'assets.txt');
    writeFileSync(assets, ASSETS);
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'edit', ...args], { encoding: 'utf8' });

    let r = run('remap-classes', save, '--mapping', mapping, '--assets', assets, '--dry-run', '--report', join(dir, 'dry.json'));
    assert.equal(r.status, 0, r.stderr);
    const dry = JSON.parse(r.stdout);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.filesChanged, ['42.arkprofile']);
    assert.equal(dry.objectsEdited, 4);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'dry.json'), 'utf8')).rows[0].found, dry.rows[0].found);

    r = run('remap-classes', save, '--mapping', mapping, '--assets', assets, '--out', join(dir, 'out.ark'));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--out-dir/);
    r = run('remap-classes', save, '--mapping', mapping, '--assets', assets, '--out', join(dir, 'out.ark'), '--out-dir', saves);
    assert.match(r.stderr, /must not be a directory/);
    r = run('remap-classes', save, '--mapping', mapping, '--assets', assets, '--out', join(dir, 'out.ark'), '--out-dir', join(dir, 'new'));
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.readBack.objects, 8);
    assert.deepEqual(rep.filesWritten, [join(dir, 'new', '42.arkprofile')]);
    assert.equal(readSave(readFileSync(join(dir, 'out.ark'))).objects[0].cls, 'StorageBox_Large_C');
    assert.ok(readFileSync(save).equals(remapSave())); // input untouched

    writeFileSync(save, removeSave());
    writeFileSync(assets, REMOVE_ASSETS);
    r = run('remove-classes', save, '--package', '/Game/Mods/ModPack', '--assets', assets, '--refund', join(dir, 'refund.csv'), '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).removed, 8);
    assert.equal(readFileSync(join(dir, 'refund.csv'), 'utf8').split('\n').filter(Boolean).length, 11);
    r = run('remove-classes', save, '--class', 'BP_ModBox_C', '--out', join(dir, 'removed.ark'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).readBack.objects, 18 - 4);

    // Asset list of installed mods: <id>.mod names the package root.
    const mods = join(dir, 'Mods');
    mkdirSync(join(mods, '123', 'Box'), { recursive: true });
    writeFileSync(join(mods, '123.mod'), Buffer.concat([Buffer.from([1, 2, 0]), Buffer.from('/Game/Mods/ModPack/PrimalGameData_BP_ModPack\0', 'latin1')]));
    writeFileSync(join(mods, '123', 'Box', 'BP_ModBox.uasset'), '');
    writeFileSync(join(mods, '123', 'Box', 'BP_ModBox.uexp'), '');
    r = run('asset-list', mods);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '/Game/Mods/ModPack/Box/BP_ModBox\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
