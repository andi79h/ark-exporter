// A small world: a tamed dino with status component, a structure stored twice with an inventory,
// a cryopod item holding a creature, a player character, and one property of an unknown type.
import {
  bool, buildContainer, buildEmbedded, buildSave, bytesArray, double, float, int, type Obj, path, type Prop, ref, str,
  struct, structArray, u64, vector, Writer,
} from './build.ts';

export interface WorldOptions {
  dinoAt?: [number, number, number];
  stasisTime?: number;
  quantity?: number;
  withSecondStructure?: boolean;
  extraStructure?: boolean;
}

const pawnVectors = (): Buffer => {
  const w = new Writer(null).i32(0).i32(0);
  for (let list = 0; list < 2; list++) {
    w.i32(2);
    for (let i = 0; i < 2; i++) w.f32(100 * i).f32(200).f32(-300);
  }
  return w.toBuffer();
};

export function cryoPayload(): Buffer {
  return buildEmbedded([
    { cls: 'Rex_Character_BP_C', names: ['Rex_Character_BP_C_5'], props: [int('DinoID1', 9), int('DinoID2', 10), ref('MyCharacterStatusComponent', 1), str('TamedName', 'Frosty')] },
    { cls: 'DinoCharacterStatusComponent_BP_Rex_C', names: ['DinoCharacterStatus_BP_Rex_C_5', 'Rex_Character_BP_C_5'], props: [float('CurrentStatusValues', 1500), float('CurrentStatusValues', 80, 4)] },
  ]);
}

export function world(o: WorldOptions = {}): Buffer {
  const at = o.dinoAt ?? [1000, 2000, -50];
  const objects: Obj[] = [
    {
      cls: 'Raptor_Character_BP_C', names: ['Raptor_Character_BP_C_1'], loc: at,
      props: [
        int('DinoID1', 1), int('DinoID2', 2), int('TargetingTeam', 1234567), ref('MyCharacterStatusComponent', 1),
        str('TamedName', 'Rexy ä中'), bool('bIsFemale', true), vector('SomeVector', 1.5, -2, 0.1),
        double('LastEnterStasisTime', o.stasisTime ?? 100.25),
        { name: 'ColorSetIndices', type: 'ArrayProperty', inner: 'ByteProperty', value: (w) => w.i32(3).u8(1).u8(2).u8(3) },
        { name: 'TamingState', type: 'ByteProperty', inner: 'ETamingState', value: (w) => w.name('ETamingState::Tamed') },
      ],
      extra: new Writer(null).i32(0).i32(1).toBuffer(),
    },
    {
      cls: 'DinoCharacterStatusComponent_BP_Raptor_C', names: ['DinoCharacterStatus_BP_Raptor_C_1', 'Raptor_Character_BP_C_1'],
      props: [float('CurrentStatusValues', 250.5), float('CurrentStatusValues', 42, 4), { name: 'FancyNewProperty', type: 'FancyProperty', value: (w) => w.i32(7).i32(8) }, int('AfterUnknown', 5)],
    },
    {
      cls: 'StorageBox_Large_C', names: ['StorageBox_Large_C_3'], loc: [5000, 5000, 0],
      props: [int('TargetingTeam', 1234567), str('OwnerName', 'Tribe of Test'), ref('MyInventoryComponent', 4)],
      extra: Buffer.alloc(4),
    },
  ];
  if (o.withSecondStructure !== false) {
    objects.push({
      cls: 'StorageBox_Large_C', names: ['StorageBox_Large_C_3'], loc: [5000, 5000, 0],
      props: [int('TargetingTeam', 1234567), str('OwnerName', 'Tribe of Test'), ref('MyInventoryComponent', 4)],
      extra: Buffer.alloc(4),
    });
  } else {
    objects.push({ cls: 'Placeholder_C', names: ['Placeholder_C_1'], props: [] });
  }
  objects.push(
    {
      cls: 'PrimalInventoryComponent_StorageBox_C', names: ['PrimalInventory_StorageBox_C_3', 'StorageBox_Large_C_3'],
      props: [{ name: 'InventoryItems', type: 'ArrayProperty', inner: 'ObjectProperty', value: (w) => w.i32(1).i32(0).i32(5) }],
    },
    {
      cls: 'PrimalItem_WeaponEmptyCryopod_C', names: ['PrimalItem_WeaponEmptyCryopod_C_7'], isItem: true,
      props: [
        struct('ItemId', 'ItemNetID', [int('ItemID1', 7), int('ItemID2', 8)]), int('ItemQuantity', o.quantity ?? 1),
        ref('OwnerInventory', 4), path('ItemArchetype', 'BlueprintGeneratedClass /Game/Cryopod.Cryopod_C'), double('NextSpoilingTime', o.stasisTime ?? 5),
        structArray('CustomItemDatas', [[
          { name: 'CustomDataName', type: 'NameProperty', value: (w) => w.name('Dino') },
          struct('CustomDataBytes', 'CustomItemByteArrays', [structArray('ByteArrays', [[bytesArray('Bytes', cryoPayload())], [bytesArray('Bytes', Buffer.from([1, 2, 3]))]])]),
        ]]),
      ],
      extra: Buffer.alloc(4),
    },
    {
      cls: 'PlayerPawnTest_Female_C', names: ['PlayerPawnTest_Female_C_2'], loc: [-100, -200, 300],
      props: [u64('LinkedPlayerDataID', 123456789012345678n), int('TargetingTeam', 1234567), str('PlatformProfileName', 'Tester')],
      extra: pawnVectors(),
    },
  );
  if (o.extraStructure) {
    objects.push({ cls: 'Wall_Wood_C', names: ['Wall_Wood_C_99'], loc: [10, 20, 30], props: [int('TargetingTeam', 1234567)], extra: Buffer.alloc(4) });
  }
  return buildSave(objects, { map: 'TestMap' });
}

export function profile(): Buffer {
  const md: Prop[] = [{ name: 'PlayerDataID', type: 'UInt32Property', value: (w) => w.u32(4242) }, str('PlayerName', 'Tester'), int('TribeId', 1234567)];
  return buildContainerFile([
    { cls: 'PrimalPlayerDataBP_C', names: ['PrimalPlayerDataBP_C_1', 'ArkGameMode', 'PersistentLevel', 'TestMap'], props: [struct('MyData', 'PrimalPlayerDataStruct', md), ref('MyPersistentBuffDatas', 1)] },
    { cls: 'PrimalBuffPersistentData', names: ['PrimalBuffPersistentData_3'], props: [str('ForPrimalBuffClassString', 'Buff_C')] },
  ]);
}

export function tribe(): Buffer {
  return buildContainerFile([
    { cls: 'PrimalTribeData', names: ['PrimalTribeData_1', 'ArkGameMode', 'PersistentLevel', 'TestMap'], props: [struct('TribeData', 'TribeData', [str('TribeName', 'Tribe of Test'), int('TribeId', 1234567)])] },
  ]);
}

function buildContainerFile(objects: Obj[]): Buffer {
  return buildContainer(objects, 1);
}
