// World save editing: byte-identical write, name table, reference patching, the operations
// (delete, decay, inventories, move, copy), building patterns and the CLI.
// All saves are synthetic (test/build.ts); real saves hold player data and stay out of the repo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SaveEditor, scanRefs } from '../src/editor.ts';
import { NameTable } from '../src/nametable.ts';
import { clearInventories, deleteObjects, moveObjects, refreshDecay } from '../src/operations.ts';
import { copyObjects, exportPattern, jsonToTree, parsePattern, placePattern, treeToJson } from '../src/pattern.ts';
import { readSave } from '../src/savegame.ts';
import { type Property, writePropertyList } from '../src/tree.ts';
import { type GameObject, ObjectRef } from '../src/types.ts';
import { checkConsistency, verifySave } from '../src/verify.ts';
import { BinaryWriter } from '../src/writer.ts';
import { indexWorld, ownedClosure, prop, select } from '../src/world.ts';
import { buildSave, bool, double, float, int, type Obj, type Prop, ref, str, struct, structArray, vector, Writer } from './build.ts';
import { world } from './fixtures.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TRIBE = 1234567;
const GAME_TIME = 5000;

const refs = (name: string, indices: number[]): Prop => ({
  name, type: 'ArrayProperty', inner: 'ObjectProperty', value: (w) => { w.i32(indices.length); for (const i of indices) w.i32(0).i32(i); },
});
const pathArray = (name: string, paths: string[], index: number): Prop => ({
  name, type: 'ArrayProperty', inner: 'ObjectProperty',
  value: (w) => { w.i32(paths.length + 1); for (const p of paths) w.i32(1).name(p); w.i32(0).i32(index); },
});
const vectors = (name: string, list: [number, number, number][]): Prop => ({
  name, type: 'ArrayProperty', inner: 'StructProperty', value: (w) => { w.i32(list.length); for (const [x, y, z] of list) w.f32(x).f32(y).f32(z); },
});

function structure(cls: string, name: string, loc: [number, number, number], extra: Prop[] = []): Obj {
  return {
    cls, names: [name], loc,
    props: [
      int('TargetingTeam', TRIBE), str('OwnerName', 'Tribe of Test'), float('MaxHealth', 10_000), bool('bHasResetDecayTime', true),
      double('OriginalCreationTime', 1000), double('LastInAllyRangeTime', 4000), ...extra,
    ],
    extra: Buffer.alloc(4),
  };
}

function item(cls: string, name: string, id: [number, number], inventory: number, more: Prop[] = []): Obj {
  return {
    cls, names: [name], isItem: true,
    props: [struct('ItemId', 'ItemNetID', [int('ItemID1', id[0]), int('ItemID2', id[1])]), ref('OwnerInventory', inventory), ...more],
    extra: Buffer.alloc(4),
  };
}

/**
 * 0 foundation A, 1 foundation B, 2 wall on A (linked to both), 3 storage box on B with 4 inventory
 * (5 stone, 6 engram), 7 dino with 8 status, 9 platform structure on the dino, 10 pipe with world
 * vectors, 11 foreign structure far away, 12 player character.
 */
function base(gameTime = GAME_TIME): Buffer {
  const objects: Obj[] = [
    structure('Foundation_Wood_C', 'Foundation_Wood_C_1', [1000, 1000, 0], [refs('LinkedStructures', [1, 2]), refs('StructuresPlacedOnFloor', [2])]),
    structure('Foundation_Wood_C', 'Foundation_Wood_C_2', [1300, 1000, 0], [refs('LinkedStructures', [0, 2]), refs('StructuresPlacedOnFloor', [3])]),
    structure('Wall_Wood_C', 'Wall_Wood_C_7', [1000, 1150, 150], [refs('LinkedStructures', [0, 1]), ref('PlacedOnFloorStructure', 0)]),
    structure('StorageBox_Small_C', 'StorageBox_Small_C_3', [1300, 1000, 50], [ref('MyInventoryComponent', 4), ref('PlacedOnFloorStructure', 1), pathArray('PathsAndRef', ['/Game/X.X_C'], 1)]),
    { cls: 'PrimalInventoryBP_SmallStorage_C', names: ['PrimalInventoryBP_SmallStorage_C_1', 'StorageBox_Small_C_3'], props: [refs('InventoryItems', [5, 6]), bool('bInitializedMe', true)], extra: Buffer.alloc(4) },
    item('PrimalItemResource_Stone_C', 'PrimalItemResource_Stone_C_9', [11, 12], 4, [int('ItemQuantity', 99)]),
    item('PrimalItem_Engram_C', 'PrimalItem_Engram_C_2', [13, 14], 4, [bool('bIsEngram', true)]),
    {
      cls: 'Raptor_Character_BP_C', names: ['Raptor_Character_BP_C_5'], loc: [1200, 900, 20],
      props: [int('DinoID1', 77), int('DinoID2', 88), int('TargetingTeam', TRIBE), str('TribeName', 'Tribe of Test'), ref('MyCharacterStatusComponent', 8)],
      extra: new Writer(null).i32(0).i32(1).toBuffer(),
    },
    { cls: 'DinoCharacterStatusComponent_BP_Raptor_C', names: ['DinoCharacterStatus_BP_Raptor_C_5', 'Raptor_Character_BP_C_5'], props: [float('CurrentStatusValues', 300)], extra: Buffer.alloc(4) },
    structure('Wall_Metal_C', 'Wall_Metal_C_1', [1200, 900, 400], [ref('SaddleDino', 7), int('AttachedToDinoID1', 77)]),
    structure('WaterPipe_Stone_C', 'WaterPipe_Stone_C_4', [1100, 1050, 10], [vectors('ConnectionPoints', [[1100, 1050, 10], [1150, 1050, 10]]), vector('ConnectionCenterPoint', 1125, 1050, 10), vector('PlacementOffset', 3, 4, 5)]),
    { ...structure('Foundation_Stone_C', 'Foundation_Stone_C_1', [90_000, 90_000, 0]), props: [int('TargetingTeam', 999), str('OwnerName', 'Other'), float('MaxHealth', 1), double('LastInAllyRangeTime', 10), double('OriginalCreationTime', 5)] },
    { cls: 'PlayerPawnTest_Male_C', names: ['PlayerPawnTest_Male_C_1'], loc: [1250, 1000, 200], props: [{ name: 'LinkedPlayerDataID', type: 'UInt64Property', value: (w) => w.u64(42n) }, int('TargetingTeam', TRIBE)], extra: Buffer.alloc(4) },
  ];
  return buildSave(objects, { map: 'TestMap', gameTime });
}

/** Objects as the export reader sees them, references replaced by the referenced object's name. */
// deno-lint-ignore no-explicit-any
type Loose = Record<string, any>;

function named(buf: Buffer): Map<string, Loose> {
  const s = readSave(buf);
  const out = new Map<string, Loose>();
  const resolve = (v: unknown, objs: GameObject[]): unknown => {
    if (v instanceof ObjectRef) return v.index === -1 ? null : `@${objs[v.index]?.names.join('/') ?? `missing ${v.index}`}`;
    if (Array.isArray(v)) return v.map((x) => resolve(x, objs));
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, objs)]));
    }
    return v;
  };
  for (const o of s.objects) out.set(o.names.join('/'), { cls: o.cls, loc: o.loc, props: resolve(o.props, s.objects) as Loose });
  return out;
}

test('editor: unchanged write, forced patching and full re-encoding are byte-identical', () => {
  for (const buf of [base(), world()]) {
    const ed = SaveEditor.open(buf);
    assert.ok(ed.write().equals(buf));
    assert.ok(ed.write({ patchAll: true }).equals(buf));
    assert.ok(ed.write({ reencodeAll: true }).equals(buf));
    const r = verifySave(buf);
    assert.deepEqual(r.identical, { copy: true, patchAll: true, reencodeAll: true });
    assert.equal(r.objectMismatches, 0);
    assert.equal(r.refMismatches, 0);
  }
  const r = verifySave(world());
  assert.equal(r.embedded.archives, 1);
  assert.equal(r.embedded.archivesIdentical, 1);
});

test('name table: Unreal instance rule, unknown names appended, ambiguous names kept as read', () => {
  const t = new NameTable(['None', 'Wall_Wood_C', 'Odd_05', 'Foo', 'Foo_5']);
  assert.deepEqual(t.encode('Wall_Wood_C_12'), [2, 13]);
  assert.deepEqual(t.encode('Wall_Wood_C'), [2, 0]);
  assert.deepEqual(t.encode('Odd_05'), [3, 0]); // leading zero: no instance number
  assert.deepEqual(t.encode('Foo_5'), [4, 6]); // Unreal rule wins over the whole string ...
  t.observe('Foo_5', 5, 0); // ... unless the file stored it the other way
  assert.deepEqual(t.encode('Foo_5'), [5, 0]);
  assert.deepEqual(t.encode('Brand_New_C_3'), [6, 4]);
  assert.deepEqual(t.added, ['Brand_New_C']);
  assert.equal(t.decode(6, 4), 'Brand_New_C_3');
});

test('reference scanner agrees with the tree, also with path elements in object arrays', () => {
  const buf = base();
  const ed = SaveEditor.open(buf);
  for (let i = 0; i < ed.count; i++) {
    const tree: number[] = [];
    const walk = (l: Property[]): void => {
      for (const p of l) {
        if (p.type === 'ObjectProperty' && p.value && typeof p.value === 'object' && 'index' in p.value) tree.push(p.value.index as number);
        if (p.type === 'ArrayProperty' && p.inner === 'ObjectProperty') for (const e of p.value as { index?: number }[]) if ('index' in e) tree.push(e.index!);
        if (p.type === 'StructProperty' && Array.isArray(p.value)) walk(p.value as Property[]);
      }
    };
    walk(ed.props(i));
    assert.deepEqual(ed.refs(i), tree.filter((x) => x !== -1), `object ${i}`);
  }
  const body = ed.rawObject(3).body;
  const positions: number[] = [];
  scanRefs(buf, body.byteOffset - buf.byteOffset, ed.table, (p) => positions.push(p));
  assert.equal(positions.length, 3); // MyInventoryComponent, PlacedOnFloorStructure, the index in PathsAndRef (not the path)
});

test('delete: owned components and items go, references elsewhere are cleaned, indices shift', () => {
  const buf = base();
  const ed = SaveEditor.open(buf);
  const r = deleteObjects(ed, [2, 3]); // wall and storage box
  assert.equal(r.removed, 5); // wall, box, inventory, stone, engram
  assert.equal(r.cleaned, 2); // both foundations linked to the wall / held the box
  const out = ed.write();
  const after = named(out);
  assert.equal(after.size, 13 - 5);
  const a = after.get('Foundation_Wood_C_1')!.props;
  assert.deepEqual(a.LinkedStructures, ['@Foundation_Wood_C_2']);
  assert.deepEqual(a.StructuresPlacedOnFloor, []);
  assert.deepEqual(after.get('Foundation_Wood_C_2')!.props.StructuresPlacedOnFloor, []);
  // Objects behind the deleted ones still point at the right objects after renumbering.
  assert.equal(after.get('Raptor_Character_BP_C_5')!.props.MyCharacterStatusComponent, '@DinoCharacterStatus_BP_Raptor_C_5/Raptor_Character_BP_C_5');
  assert.equal(after.get('Wall_Metal_C_1')!.props.SaddleDino, '@Raptor_Character_BP_C_5');
  assert.equal(checkConsistency(SaveEditor.open(out)).refsOutOfRange, 0);
});

test('decay: LastInAllyRangeTime becomes the save time (plus extra days)', () => {
  const ed = SaveEditor.open(base());
  const w = indexWorld(ed);
  const mine = select(w, { tribe: TRIBE });
  assert.equal(mine.length, 6);
  const r = refreshDecay(ed, mine.map((e) => e.index), { extraSeconds: 86_400 });
  assert.equal(r.updated, 6);
  const after = named(ed.write());
  assert.equal(after.get('Wall_Wood_C_7')!.props.LastInAllyRangeTime, GAME_TIME + 86_400);
  assert.equal(after.get('Foundation_Stone_C_1')!.props.LastInAllyRangeTime, 10); // other tribe untouched
});

test('clear inventory: items removed, engrams kept, inventory list updated', () => {
  const ed = SaveEditor.open(base());
  const r = clearInventories(ed, [3]);
  assert.deepEqual(r, { inventories: 1, items: 1, kept: 1 });
  const after = named(ed.write());
  assert.equal(after.has('PrimalItemResource_Stone_C_9'), false);
  assert.deepEqual(after.get('PrimalInventoryBP_SmallStorage_C_1/StorageBox_Small_C_3')!.props.InventoryItems, ['@PrimalItem_Engram_C_2']);
  const ed2 = SaveEditor.open(base());
  assert.equal(clearInventories(ed2, [3], { keepEngrams: false }).items, 2);
});

test('move: rotation around the pivot, world vectors in properties, platform structures follow the dino', () => {
  const ed = SaveEditor.open(base());
  const all = select(indexWorld(ed), { tribe: TRIBE, kinds: ['structure', 'dino'] }).filter((e) => e.cls !== 'Wall_Metal_C');
  const r = moveObjects(ed, all.map((e) => e.index), { dx: 10_000, dy: 0, dz: 100, yaw: 90, pivot: { x: 1000, y: 1000, z: 0 } });
  assert.equal(r.saddleStructures, 1);
  assert.equal(r.moved, 7);
  assert.deepEqual(r.vectors, { ConnectionPoints: 2, ConnectionCenterPoint: 1 });
  const after = named(ed.write());
  const loc = (n: string) => after.get(n)!.loc as Record<string, number>;
  // (1300, 1000) is 300 east of the pivot; turned by 90° it is 300 north, then moved by 10,000.
  assert.ok(Math.abs(loc('Foundation_Wood_C_2').x - 11_000) < 0.01 && Math.abs(loc('Foundation_Wood_C_2').y - 1300) < 0.01);
  assert.equal(loc('Foundation_Wood_C_2').z, 100);
  assert.equal(loc('Foundation_Wood_C_2').yaw, 180); // 90 (built) + 90
  assert.ok(Math.abs(loc('Wall_Metal_C_1').x - 11_100) < 0.01);
  const pipe = after.get('WaterPipe_Stone_C_4')!.props as Record<string, any>;
  assert.ok(Math.abs(pipe.ConnectionCenterPoint.x - (11_000 - 50)) < 0.01);
  assert.deepEqual(pipe.PlacementOffset, { x: 3, y: 4, z: 5 }); // relative, untouched
  assert.deepEqual(loc('Foundation_Stone_C_1'), { x: 90_000, y: 90_000, z: 0, pitch: 0, yaw: 90, roll: 0 });
  assert.deepEqual(loc('PlayerPawnTest_Male_C_1'), { x: 1250, y: 1000, z: 200, pitch: 0, yaw: 90, roll: 0 });
});

test('ownership: components by reference and by outer name, items only through inventories', () => {
  const ed = SaveEditor.open(base());
  assert.deepEqual([...ownedClosure(ed, [3])].sort((a, b) => a - b), [3, 4, 5, 6]);
  assert.deepEqual([...ownedClosure(ed, [3], { items: false })].sort((a, b) => a - b), [3, 4]);
  assert.deepEqual([...ownedClosure(ed, [7])].sort((a, b) => a - b), [7, 8]);
  assert.deepEqual([...ownedClosure(ed, [0])], [0]); // linked neighbours are not owned
});

test('pattern: tree JSON keeps every value', () => {
  const ed = SaveEditor.open(world());
  for (let i = 0; i < ed.count; i++) {
    const props = ed.props(i);
    const back = jsonToTree(JSON.parse(JSON.stringify(treeToJson(props))) as unknown[]);
    const w1 = new BinaryWriter(64, ed.table);
    const w2 = new BinaryWriter(64, ed.table);
    writePropertyList(w1, props);
    writePropertyList(w2, back);
    assert.ok(w1.toBuffer().equals(w2.toBuffer()), `object ${i}`);
  }
});

test('pattern: export, store as JSON, place into another save rotated and for another tribe', () => {
  const src = SaveEditor.open(base(GAME_TIME));
  const chosen = select(indexWorld(src), { tribe: TRIBE, box: { min: { x: 900, y: 900, z: -100 }, max: { x: 1400, y: 1200, z: 300 } } });
  assert.deepEqual(chosen.map((e) => e.cls).sort(), ['Foundation_Wood_C', 'Foundation_Wood_C', 'StorageBox_Small_C', 'Wall_Wood_C', 'WaterPipe_Stone_C']);
  const pattern = parsePattern(JSON.stringify(exportPattern(src, chosen.map((e) => e.index), { items: true, map: 'TestMap', anchor: { x: 1000, y: 1000, z: 0 } })));
  assert.equal(pattern.objects.length, 8); // 5 structures, inventory, 2 items
  assert.deepEqual(pattern.counts, { structure: 5, component: 1, item: 2 });
  assert.deepEqual(pattern.droppedRefs, {}); // every reference stays inside the cut-out
  const foundation = pattern.objects.find((o) => o.cls === 'Foundation_Wood_C')!;
  assert.deepEqual(foundation.location, { x: 0, y: 0, z: 0, pitch: 0, yaw: 90, roll: 0 });

  // Target: the same map layout, later game time, one existing structure name to collide with.
  const target = SaveEditor.open(base(GAME_TIME + 100_000));
  const before = target.count;
  const r = placePattern(target, pattern, { at: { x: 50_000, y: 50_000, z: 500, yaw: 90 }, owner: { team: 555, name: 'New Owners' } });
  assert.equal(r.indices.length, 8);
  assert.deepEqual(r.blocking, []);
  const out = target.write();
  const after = named(out);
  assert.equal(after.size, before + 8);
  // Fresh names; components follow their actor.
  const newBox = [...after.entries()].find(([k, v]) => v.cls === 'StorageBox_Small_C' && k !== 'StorageBox_Small_C_3')!;
  assert.equal(newBox[0], 'StorageBox_Small_C_4');
  const inv = after.get('PrimalInventoryBP_SmallStorage_C_1/StorageBox_Small_C_4')!;
  assert.deepEqual(inv.props.InventoryItems, ['@PrimalItemResource_Stone_C_10', '@PrimalItem_Engram_C_3']);
  assert.equal(newBox[1].props.MyInventoryComponent, '@PrimalInventoryBP_SmallStorage_C_1/StorageBox_Small_C_4');
  const wall = after.get('Wall_Wood_C_8')!;
  assert.deepEqual(wall.props.LinkedStructures, ['@Foundation_Wood_C_3', '@Foundation_Wood_C_4']);
  assert.equal(wall.props.PlacedOnFloorStructure, '@Foundation_Wood_C_3');
  assert.equal(wall.props.TargetingTeam, 555);
  assert.equal(wall.props.OwnerName, 'New Owners');
  // Times: creation and decay "now" in the target, others rebased.
  assert.equal(wall.props.OriginalCreationTime, GAME_TIME + 100_000);
  assert.equal(wall.props.LastInAllyRangeTime, GAME_TIME + 100_000);
  // Position: anchor at (50000, 50000, 500), turned by 90°: the wall 150 north of the anchor ends up 150 west.
  const l = wall.loc as Record<string, number>;
  assert.ok(Math.abs(l.x - 49_850) < 0.01 && Math.abs(l.y - 50_000) < 0.01 && l.z === 650 && l.yaw === 180);
  // New item ids, consistency unchanged.
  const stone = after.get('PrimalItemResource_Stone_C_10')!.props.ItemId as Record<string, number>;
  assert.notDeepEqual([stone.ItemID1, stone.ItemID2], [11, 12]);
  const c = checkConsistency(SaveEditor.open(out));
  assert.equal(c.refsOutOfRange, 0);
  assert.equal(c.duplicateItemIds, 0);
  assert.equal(c.orphanComponents, 0);
  assert.equal(c.duplicateActorNames, 0);
});

test('pattern: overlap blocks placing unless forced; copy inside one save', () => {
  const ed = SaveEditor.open(base());
  const chosen = select(indexWorld(ed), { tribe: TRIBE, classes: ['Foundation_*', 'Wall_Wood_C'] });
  const p = exportPattern(ed, chosen.map((e) => e.index));
  assert.throws(() => placePattern(ed, p, { at: { x: p.anchor.x, y: p.anchor.y, z: p.anchor.z }, owner: { team: 1 } }), /existing structures/);
  const r = copyObjects(ed, chosen.map((e) => e.index), { by: { dx: 5000, dy: 0, dz: 0, yaw: 0, pivot: { x: 1000, y: 1000, z: 0 } }, owner: { team: TRIBE } });
  assert.equal(r.indices.length, 3);
  const out = ed.write();
  assert.equal(readSave(out).objects.length, 16);
  assert.equal(checkConsistency(SaveEditor.open(out)).duplicateActorNames, 0);
});

test('new names enlarge the name table and are read back', () => {
  const ed = SaveEditor.open(base());
  const o = ed.get(11);
  o.cls = 'Totally_New_Structure_C';
  o.names = ['Totally_New_Structure_C_17'];
  o.props = [...o.props, { name: 'BrandNewProp', type: 'NameProperty', index: 0, value: 'SomeEnum::Value_3' }];
  ed.add(o);
  const out = ed.write();
  assert.deepEqual(ed.table.added, ['BrandNewProp', 'NameProperty', 'SomeEnum::Value', 'Totally_New_Structure_C']);
  // NameProperty values are names (table index + instance), not strings.
  const s = readSave(out);
  const last = s.objects[s.objects.length - 1];
  assert.equal(last.cls, 'Totally_New_Structure_C');
  assert.equal(last.names[0], 'Totally_New_Structure_C_17');
  assert.equal(last.props.BrandNewProp, 'SomeEnum::Value_3');
  assert.equal(SaveEditor.open(out).write().equals(out), true);
});

test('CLI: edit commands write a new file, read it back, refuse the input as output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ark-edit-'));
  try {
    const save = join(dir, 'TestMap.ark');
    writeFileSync(save, base());
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'edit', ...args], { encoding: 'utf8' });
    let r = run('verify', save);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, true);
    r = run('decay', save, '--out', save);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no selection/);
    r = run('decay', save, '--tribe', String(TRIBE), '--out', save);
    assert.match(r.stderr, /must not be the input/);
    const out = join(dir, 'out.ark');
    r = run('move', save, '--tribe', String(TRIBE), '--by', '100,0,0', '--with-dinos', '--out', out);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.moved, 7); // 6 structures + dino (the platform wall counts among the structures)
    assert.equal(rep.readBack.objects, 13);
    const pat = join(dir, 'p.json');
    r = run('pattern-save', save, '--tribe', String(TRIBE), '--class', 'Foundation_*', '--pattern', pat);
    assert.equal(r.status, 0, r.stderr);
    r = run('pattern-place', save, '--pattern', pat, '--at', '0,0,0', '--team', '42', '--check');
    assert.equal(r.status, 0, r.stderr);
    r = run('pattern-place', save, '--pattern', pat, '--at', '0,0,0', '--team', '42', '--out', join(dir, 'placed.ark'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).added, 2);
    assert.equal(readFileSync(save).equals(base()), true); // input untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
