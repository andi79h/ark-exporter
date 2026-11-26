// ASE cluster files (clusters/<ClusterId>/<SteamID>): items, creatures and characters a player
// uploaded at an obelisk, terminal or transmitter, readable by every server of the cluster.
//
// The file is an inline-named container (tree.ts) with version 4 and a single object
// ArkCloudInventoryData. Its property MyArkData (struct ArkInventoryData) holds up to three arrays:
//   ArkItems           { ArkTributeItem: struct ItemNetInfo, Version: float 2, UploadTime: int (unix) }
//   ArkTamedDinosData  { DinoClassName, DinoClass, DinoData: bytes, DinoName, DinoStats[12], DinoID1/2, ... }
//   ArkPlayerData      { PlayerDataID, PlayerDataBytes: bytes, PlayerName, PlayerStats[12], ... }
// Arrays without entries are left out; players without uploads have a file of 0 bytes. DinoData and
// PlayerDataBytes are embedded archives like the creatures in cryopods (objects.ts reads them).
import { randomInt } from 'node:crypto';
import { enableCryopods } from './savegame.ts';
import {
  findProperty, type Property, readContainerTree, type TreeContainer, type TreeNotes, treeToProps, writeContainerTree,
} from './tree.ts';
import { Embedded, type GameObject, PathRef, type Props, ReadContext, type Value } from './types.ts';

export const CLUSTER_VERSION = 4;
export const CLUSTER_CLASS = 'ArkCloudInventoryData';

/** Strict, lossless read. null for an empty file (no uploads). */
export function readClusterTree(buf: Buffer, notes?: TreeNotes): TreeContainer | null {
  if (buf.length === 0) return null;
  const c = readContainerTree(buf, { notes });
  if (c.version !== CLUSTER_VERSION) throw new RangeError(`cluster file version ${c.version}, expected ${CLUSTER_VERSION}`);
  clusterData(c);
  return c;
}

export function writeClusterTree(c: TreeContainer | null): Buffer {
  return c === null ? Buffer.alloc(0) : writeContainerTree(c);
}

/** The property list of MyArkData. */
export function clusterData(c: TreeContainer): Property[] {
  const o = c.objects.find((x) => x.cls === CLUSTER_CLASS);
  if (!o) throw new RangeError(`no ${CLUSTER_CLASS} object in cluster file`);
  const p = findProperty(o.props, 'MyArkData');
  if (!p || p.type !== 'StructProperty' || p.opaque || !Array.isArray(p.value)) throw new RangeError('no readable MyArkData in cluster file');
  return p.value as Property[];
}

/** Entries of ArkItems, ArkTamedDinosData or ArkPlayerData (each a property list). */
export function clusterEntries(c: TreeContainer | null, array: string): Property[][] {
  if (c === null) return [];
  const p = findProperty(clusterData(c), array);
  if (!p) return [];
  if (p.opaque || p.elementStruct || !Array.isArray(p.value)) throw new RangeError(`${array} is not an array of structs`);
  return p.value as Property[][];
}

/** A new, empty cluster file structure (what the game writes, minus the arrays). */
export function createClusterTree(): TreeContainer {
  return {
    version: CLUSTER_VERSION,
    objects: [{
      guid: Buffer.alloc(16), cls: CLUSTER_CLASS, isItem: 1, names: [`${CLUSTER_CLASS}_0`], fromDataFile: 0, dataFile: 0,
      hasLocation: 0, location: null, headerTail: 0,
      props: [{ name: 'MyArkData', type: 'StructProperty', index: 0, inner: 'ArkInventoryData', value: [] }],
      extra: Buffer.alloc(4),
    }],
    gap: Buffer.alloc(0),
    order: [0],
  };
}

// ---------------------------------------------------------------- read view

export interface ClusterItem {
  /** Position in ArkItems. */
  index: number;
  /** ItemArchetype, e.g. "BlueprintGeneratedClass /Game/.../PrimalItemArmor_RiotShirt.PrimalItemArmor_RiotShirt_C". */
  blueprint: string | null;
  itemId: [number, number];
  /** Number of pieces: ItemQuantity + 1 (see quantityRaw), null without ItemQuantity. */
  quantity: Value;
  /** ItemQuantity as stored: pieces - 1. Single items and blueprints 0, a full stack of 100 is 99. */
  quantityRaw: Value;
  quality: Value;
  rating: Value;
  durability: Value;
  /** ItemStatValues 0..7 (UInt16): generic quality, armor, max durability, damage, ammo, hypothermal, weight, hyperthermal. */
  stats: Value[];
  colors: Value[];
  isBlueprint: Value;
  /** bAllowRemovalFromInventory. ARK did not let players download add-item items without it. */
  allowRemoval: Value;
  customName: Value;
  customDescription: Value;
  crafterName: Value;
  crafterTribe: Value;
  owner: Value;
  /** Unix seconds. */
  uploadTime: Value;
  expiration: Value;
  version: Value;
  /** Complete ItemNetInfo. */
  info: Props;
}

export interface ClusterDino {
  index: number;
  className: Value;
  name: Value;
  dinoId: [Value, Value];
  stats: Value[];
  uploadTime: Value;
  version: Value;
  /** Objects of DinoData (creature, status component, inventory), null if it could not be decoded. */
  objects: GameObject[] | null;
  /** All fields except DinoData. */
  props: Props;
}

export interface ClusterCharacter {
  index: number;
  playerDataId: Value;
  name: Value;
  stats: Value[];
  map: Value;
  server: Value;
  uploadTime: Value;
  version: Value;
  /** Objects of PlayerDataBytes, null if it could not be decoded. */
  objects: GameObject[] | null;
  props: Props;
}

export interface Cluster {
  /** false for files of 0 bytes. */
  hasData: boolean;
  objectName: string | null;
  items: ClusterItem[];
  dinos: ClusterDino[];
  characters: ClusterCharacter[];
  /** MyArkData properties other than the three arrays. */
  other: Props;
  /** Parts kept as bytes (should be empty). */
  notes: Record<string, number>;
  ctx: ReadContext;
}

const staticArray = (p: Props, name: string, n: number): Value[] =>
  Array.from({ length: n }, (_, i) => p[i ? `${name}[${i}]` : name] ?? null);

const pathOf = (v: Value): string | null => (v instanceof PathRef ? v.path : null);

function itemView(entry: Property[], index: number, ctx: ReadContext): ClusterItem {
  const props = treeToProps(entry, ctx);
  const info = (props.ArkTributeItem ?? {}) as Props;
  const id = (info.ItemId ?? {}) as Props;
  return {
    index,
    blueprint: pathOf(info.ItemArchetype),
    itemId: [Number(id.ItemID1), Number(id.ItemID2)],
    quantity: typeof info.ItemQuantity === 'number' ? info.ItemQuantity + 1 : null,
    quantityRaw: info.ItemQuantity ?? null,
    quality: info.ItemQualityIndex ?? null,
    rating: info.ItemRating ?? null,
    durability: info.ItemDurability ?? null,
    stats: staticArray(info, 'ItemStatValues', 8),
    colors: staticArray(info, 'ItemColorID', 6),
    isBlueprint: info.bIsBlueprint ?? null,
    allowRemoval: info.bAllowRemovalFromInventory ?? null,
    customName: info.CustomItemName ?? null,
    customDescription: info.CustomItemDescription ?? null,
    crafterName: info.CrafterCharacterName ?? null,
    crafterTribe: info.CrafterTribeName ?? null,
    owner: info.OwnerPlayerDataID ?? null,
    uploadTime: props.UploadTime ?? null,
    expiration: info.ExpirationTimeUTC ?? null,
    version: props.Version ?? null,
    info,
  };
}

function embeddedObjects(v: Value): GameObject[] | null {
  return v instanceof Embedded ? v.objects : null;
}

function dinoView(entry: Property[], index: number, ctx: ReadContext): ClusterDino {
  const props = treeToProps(entry, ctx);
  const objects = embeddedObjects(props.DinoData);
  delete props.DinoData;
  return {
    index, className: props.DinoClassName ?? null, name: props.DinoName ?? null,
    dinoId: [props.DinoID1 ?? null, props.DinoID2 ?? null], stats: staticArray(props, 'DinoStats', 12),
    uploadTime: props.UploadTime ?? null, version: props.Version ?? null, objects, props,
  };
}

function characterView(entry: Property[], index: number, ctx: ReadContext): ClusterCharacter {
  const props = treeToProps(entry, ctx);
  const objects = embeddedObjects(props.PlayerDataBytes);
  delete props.PlayerDataBytes;
  return {
    index, playerDataId: props.PlayerDataID ?? null, name: props.PlayerName ?? null, stats: staticArray(props, 'PlayerStats', 12),
    map: props.UploadingServerMapName ?? null, server: props.UploadingServerName ?? null,
    uploadTime: props.UploadTime ?? null, version: props.Version ?? null, objects, props,
  };
}

const ARRAYS = new Set(['ArkItems', 'ArkTamedDinosData', 'ArkPlayerData']);

/** Decoded view of a cluster file (strict: throws if the file does not have the expected layout). */
export function readCluster(buf: Buffer, ctx = new ReadContext()): Cluster {
  enableCryopods(ctx);
  const notes: TreeNotes = new Map();
  const c = readClusterTree(buf, notes);
  const view: Cluster = {
    hasData: c !== null, objectName: null, items: [], dinos: [], characters: [], other: {}, notes: {}, ctx,
  };
  if (c === null) return view;
  const o = c.objects.find((x) => x.cls === CLUSTER_CLASS)!;
  view.objectName = o.names[0] ?? null;
  view.items = clusterEntries(c, 'ArkItems').map((e, i) => itemView(e, i, ctx));
  view.dinos = clusterEntries(c, 'ArkTamedDinosData').map((e, i) => dinoView(e, i, ctx));
  view.characters = clusterEntries(c, 'ArkPlayerData').map((e, i) => characterView(e, i, ctx));
  view.other = treeToProps(clusterData(c).filter((p) => !ARRAYS.has(p.name)), ctx);
  view.notes = Object.fromEntries(notes);
  return view;
}

// ---------------------------------------------------------------- new items

export interface NewItem {
  /** Item class: "/Game/.../PrimalItemArmor_RiotShirt.PrimalItemArmor_RiotShirt_C", a Blueprint'...' path or the full ItemArchetype. */
  blueprint: string;
  /**
   * Number of pieces, 1 or more. Default 1. Written as ItemQuantity = pieces - 1: in real files full
   * stacks of 100 store 99, of 50 store 49, single items and blueprints 0; ItemQuantity 100 gave
   * 101 pieces in the game. More than the stack size is cut on download (1000 ingots gave 300, the
   * rest was lost): split large amounts with splitQuantity.
   */
  quantity?: number;
  /** ItemQualityIndex 0..5 (primitive ... ascendant). Default 0. */
  quality?: number;
  /** ItemRating (float). Default 0. */
  rating?: number;
  /**
   * ItemDurability, the current durability as an absolute value (float). Default 0. The game does not
   * clamp it: 100000 on a riot shirt (maximum 720) gave 139 times the maximum.
   */
  durability?: number;
  /** ItemStatValues 0..7 (UInt16 each), missing entries are 0. The game takes them unclamped (65535 included). */
  stats?: number[];
  /** ItemColorID 0..5 (Int16 each). */
  colors?: number[];
  /** Upload the item as a blueprint. */
  isBlueprint?: boolean;
  /**
   * bAllowRemovalFromInventory. Default true: in the game test ARK refused to download add-item
   * items with false (same file, true downloaded fine). Real uploads have it mixed, blueprints
   * mostly false; whether blueprints need it is not tested yet.
   */
  allowRemoval?: boolean;
  customName?: string | null;
  customDescription?: string | null;
  crafterName?: string | null;
  crafterTribe?: string | null;
  /** WeaponClipAmmo. Default 0. */
  ammo?: number;
  /** OwnerPlayerDataID, see ItemOwner. Default 0: the item waits at the obelisk. */
  owner?: ItemOwner;
  /** UploadTime, unix seconds (int32). Default: now. Use validUntil to keep an item longer than a day. */
  uploadTime?: number;
  /** Last moment the item can be downloaded (unix seconds); sets UploadTime = validUntil - lifetime. */
  validUntil?: number;
  /** The server's TributeItemExpirationSeconds. Default 86400 (ASE default). */
  lifetime?: number;
  /**
   * Raw ExpirationTimeUTC (UInt32). Default UploadTime + lifetime, as the server rewrites it. The
   * game ignores the field: only UploadTime + TributeItemExpirationSeconds decides (game test 2026-11-26).
   */
  expiration?: number;
  /** ItemID1, ItemID2. Default: random, below 10^9 like the game's, unique within the file. */
  itemId?: [number, number];
}

export interface AddedItem {
  index: number;
  itemId: [number, number];
  blueprint: string;
  /** Pieces, and ItemQuantity as written (pieces - 1). */
  quantity: number;
  quantityRaw: number;
  /** bAllowRemovalFromInventory as written. */
  allowRemoval: boolean;
  uploadTime: number;
  expiration: number;
  /** UploadTime + lifetime: the last moment the obelisk hands the item out. */
  validUntil: number;
  owner: string;
}

/** Seconds an upload stays at the obelisk: the server's TributeItemExpirationSeconds (ASE default). */
export const DEFAULT_LIFETIME = 86_400;
/** @deprecated use DEFAULT_LIFETIME */
export const DEFAULT_EXPIRES_IN = DEFAULT_LIFETIME;

/**
 * OwnerPlayerDataID of a new upload (game test 2026-11-26):
 * - 0: what the game writes for its own uploads; the item waits in the obelisk list.
 * - 'player': the PlayerDataID of the file's character; ARK moves the item into the inventory as soon
 *   as the player opens an obelisk, transmitter or terminal, without asking.
 * - any other number: written as given (a foreign ID behaves like 0).
 */
export type ItemOwner = bigint | number | string;

export function resolveOwner(c: TreeContainer | null, owner: ItemOwner | undefined): bigint {
  if (owner === undefined) return 0n;
  if (owner === 'player') {
    const id = defaultOwner(c);
    if (id === 0n) throw new RangeError('owner "player": the file has no PlayerDataID (no uploaded character, no owned items); pass the ID');
    return id;
  }
  const v = BigInt(owner);
  if (v < 0n || v >= 2n ** 64n) throw new RangeError(`owner ${v} outside UInt64`);
  return v;
}

/**
 * UploadTime and ExpirationTimeUTC of a new upload. The obelisk shows and hands out an upload while
 * UploadTime + TributeItemExpirationSeconds lies in the future and ignores ExpirationTimeUTC; a later
 * UploadTime keeps an item longer (shown as 95:59 for three days, 8783:59 for a year). Uploads past
 * that are dropped the next time the server writes the file.
 */
export function uploadTiming(
  t: { uploadTime?: number; validUntil?: number; lifetime?: number; expiration?: number }, now: number,
): { uploadTime: number; expiration: number; validUntil: number } {
  if (t.uploadTime !== undefined && t.validUntil !== undefined) throw new RangeError('give either uploadTime or validUntil, not both');
  const lifetime = checkInt(t.lifetime ?? DEFAULT_LIFETIME, 1, 2 ** 31 - 1, 'lifetime');
  const uploadTime = checkInt(t.validUntil !== undefined ? t.validUntil - lifetime : (t.uploadTime ?? now), 0, 2 ** 31 - 1, 'uploadTime');
  const expiration = checkInt(t.expiration ?? uploadTime + lifetime, 0, 2 ** 32 - 1, 'expiration');
  return { uploadTime, expiration, validUntil: uploadTime + lifetime };
}

/**
 * "BlueprintGeneratedClass /Game/A/B.B_C" for any of:
 * Blueprint'/Game/A/B.B', /Game/A/B.B_C, /Game/A/B.B, /Game/A/B, BlueprintGeneratedClass /Game/A/B.B_C.
 */
export function itemArchetype(spec: string): string {
  let s = spec.trim().replace(/^"(.*)"$/, '$1');
  if (s.startsWith('BlueprintGeneratedClass ')) s = s.slice('BlueprintGeneratedClass '.length).trim();
  const quoted = /^\w+'(.*)'$/.exec(s);
  if (quoted) s = quoted[1];
  if (!/^\/Game\/[\w\-/.]+$/.test(s)) throw new RangeError(`not an item class path: ${spec}`);
  const slash = s.lastIndexOf('/');
  const file = s.slice(slash + 1);
  let path: string;
  if (!file.includes('.')) path = `${s}.${file}_C`;
  else if (s.endsWith('_C')) path = s;
  else path = `${s}_C`;
  const [pkg, obj] = path.slice(slash + 1).split('.');
  if (!pkg || obj !== `${pkg}_C`) throw new RangeError(`class name does not match its package: ${spec}`);
  return `BlueprintGeneratedClass ${path}`;
}

function checkInt(v: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${what} must be an integer from ${min} to ${max}, got ${v}`);
  return v;
}

function checkFloat(v: number, what: string): number {
  if (!Number.isFinite(v) || !Number.isFinite(Math.fround(v))) throw new RangeError(`${what} must be a finite float, got ${v}`);
  return v;
}

/** Every ItemID pair in ArkItems, as "id1:id2". */
export function itemIds(c: TreeContainer | null): Set<string> {
  const out = new Set<string>();
  for (const e of clusterEntries(c, 'ArkItems')) {
    const info = findProperty(e, 'ArkTributeItem')?.value;
    const id = Array.isArray(info) ? findProperty(info as Property[], 'ItemId')?.value : null;
    if (!Array.isArray(id)) continue;
    const list = id as Property[];
    out.add(`${findProperty(list, 'ItemID1')?.value}:${findProperty(list, 'ItemID2')?.value}`);
  }
  return out;
}

/** PlayerDataID of the uploaded character, else the most common owner of the items, else 0. */
export function defaultOwner(c: TreeContainer | null): bigint {
  const player = clusterEntries(c, 'ArkPlayerData')[0];
  const id = player ? findProperty(player, 'PlayerDataID')?.value : undefined;
  if (typeof id === 'bigint') return id;
  const counts = new Map<bigint, number>();
  for (const e of clusterEntries(c, 'ArkItems')) {
    const info = findProperty(e, 'ArkTributeItem')?.value;
    const owner = Array.isArray(info) ? findProperty(info as Property[], 'OwnerPlayerDataID')?.value : undefined;
    if (typeof owner === 'bigint' && owner !== 0n) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  let best = 0n;
  let n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return best;
}

const p = (name: string, type: string, value: Property['value'], more: Partial<Property> = {}): Property => ({ name, type, index: 0, value, ...more });
const many = (name: string, type: string, values: number[], more: Partial<Property> = {}): Property[] =>
  values.map((v, index) => ({ name, type, index, value: v, ...more }));
const bools = (names: string[], on: Set<string>): Property[] => names.map((n) => p(n, 'BoolProperty', on.has(n)));
const emptyArray = (name: string, inner: string): Property => p(name, 'ArrayProperty', [], { inner });
const noObject = (name: string): Property => p(name, 'ObjectProperty', { index: -1 });
const byte = (name: string, v: number): Property => p(name, 'ByteProperty', v, { inner: 'None' });
const pad = (values: number[] | undefined, n: number): number[] => Array.from({ length: n }, (_, i) => values?.[i] ?? 0);

/**
 * One ArkItems entry: ItemNetInfo with the 95 fields in the order the game (2023+) writes them,
 * then Version 2.0 and UploadTime. quantityRaw is ItemQuantity as stored (pieces - 1).
 */
export function tributeItemEntry(f: {
  archetype: string; itemId: [number, number]; quantityRaw: number; quality: number; rating: number; durability: number;
  stats: number[]; colors: number[]; isBlueprint: boolean; allowRemoval: boolean; customName: string | null; customDescription: string | null;
  crafterName: string | null; crafterTribe: string | null; ammo: number; owner: bigint; uploadTime: number; expiration: number;
}): Property[] {
  const info: Property[] = [
    p('ItemArchetype', 'ObjectProperty', { path: f.archetype }),
    p('ItemId', 'StructProperty', [p('ItemID1', 'UInt32Property', f.itemId[0]), p('ItemID2', 'UInt32Property', f.itemId[1])], { inner: 'ItemNetID' }),
    p('ItemQuantity', 'UInt32Property', f.quantityRaw),
    p('CustomItemID', 'IntProperty', 0),
    p('SlotIndex', 'IntProperty', 0),
    p('CreationTime', 'DoubleProperty', 0),
    p('CustomItemName', 'StrProperty', f.customName),
    p('CustomItemDescription', 'StrProperty', f.customDescription),
    p('UploadEarliestValidTime', 'DoubleProperty', 0),
    emptyArray('SteamUserItemID', 'UInt64Property'),
    ...bools([
      'bIsBlueprint', 'bIsEngram', 'bIsCustomRecipe', 'bIsFoodRecipe', 'bIsRepairing', 'bAllowRemovalFromInventory',
      'bHideFromInventoryDisplay', 'bAllowRemovalFromSteamInventory', 'bFromSteamInventory', 'bIsFromAllClustersInventory',
      'bForcePreventGrinding', 'bIsEquipped', 'bIsSlot', 'bIsInitialItem',
    ], new Set([
      'bAllowRemovalFromSteamInventory', ...(f.isBlueprint ? ['bIsBlueprint'] : []), ...(f.allowRemoval ? ['bAllowRemovalFromInventory'] : []),
    ])),
    p('CraftQueue', 'UInt16Property', 0),
    p('NextCraftCompletionTime', 'DoubleProperty', 0),
    p('CraftingSkill', 'FloatProperty', 0),
    p('CraftedSkillBonus', 'FloatProperty', 0),
    p('CrafterCharacterName', 'StrProperty', f.crafterName),
    p('CrafterTribeName', 'StrProperty', f.crafterTribe),
    p('WeaponClipAmmo', 'UInt32Property', f.ammo),
    p('ItemDurability', 'FloatProperty', f.durability),
    p('ItemRating', 'FloatProperty', f.rating),
    p('ExpirationTimeUTC', 'UInt32Property', f.expiration),
    byte('ItemQualityIndex', f.quality),
    noObject('ItemCustomClass'),
    ...many('ItemStatValues', 'UInt16Property', pad(f.stats, 8)),
    ...many('ItemColorID', 'Int16Property', pad(f.colors, 6)),
    noObject('ItemSkinTemplate'),
    emptyArray('CustomItemDatas', 'StructProperty'),
    emptyArray('CustomItemColors', 'StructProperty'),
    emptyArray('CustomResourceRequirements', 'StructProperty'),
    p('NextSpoilingTime', 'DoubleProperty', 0),
    p('LastSpoilingTime', 'DoubleProperty', 0),
    p('OwnerPlayerDataID', 'UInt64Property', f.owner),
    p('LastOwnerPlayer', 'ObjectProperty', { index: -1, short: true }),
    p('LastAutoDurabilityDecreaseTime', 'DoubleProperty', 0),
    p('ItemStatClampsMultiplier', 'FloatProperty', 0),
    p('OriginalItemDropLocation', 'StructProperty', { x: 0, y: 0, z: 0 }, { inner: 'Vector' }),
    ...many('PreSkinItemColorID', 'Int16Property', pad([], 6)),
    ...many('EggNumberOfLevelUpPointsApplied', 'ByteProperty', pad([], 12), { inner: 'None' }),
    p('EggTamedIneffectivenessModifier', 'FloatProperty', 0),
    ...many('EggColorSetIndices', 'ByteProperty', pad([], 6), { inner: 'None' }),
    p('EggGenderOverride', 'IntProperty', 0),
    byte('ItemVersion', 0),
    p('ClusterSpoilingTimeUTC', 'DoubleProperty', 0),
    emptyArray('EggDinoAncestors', 'StructProperty'),
    emptyArray('EggDinoAncestorsMale', 'StructProperty'),
    p('EggRandomMutationsFemale', 'IntProperty', 0),
    p('EggRandomMutationsMale', 'IntProperty', 0),
    byte('ItemProfileVersion', 1),
    p('bNetInfoFromClient', 'BoolProperty', false),
  ];
  return [
    p('ArkTributeItem', 'StructProperty', info, { inner: 'ItemNetInfo' }),
    p('Version', 'FloatProperty', 2),
    p('UploadTime', 'IntProperty', f.uploadTime),
  ];
}

/** Pieces per entry for `total` pieces in stacks of at most `stack`: 1000 by 300 gives 300, 300, 300, 100. */
export function splitQuantity(total: number, stack: number): number[] {
  checkInt(total, 1, 2 ** 32, 'quantity');
  checkInt(stack, 1, 2 ** 32, 'stack');
  const out: number[] = [];
  for (let left = total; left > 0; left -= stack) out.push(Math.min(stack, left));
  return out;
}

/** Random IDs in the range the game uses (0 < id < 10^9). */
export const randomItemId = (): [number, number] => [randomInt(1, 1_000_000_000), randomInt(1, 1_000_000_000)];

/**
 * Appends an item to ArkItems (creating the file structure for empty files) and returns the tree
 * and what was written. The tree passed in is changed.
 */
export function addItem(
  c: TreeContainer | null, item: NewItem, opts: { now?: number; randomId?: () => [number, number] } = {},
): { tree: TreeContainer; added: AddedItem } {
  const tree = c ?? createClusterTree();
  const data = clusterData(tree);
  const archetype = itemArchetype(item.blueprint);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const { uploadTime, expiration, validUntil } = uploadTiming(item, now);
  const stats = item.stats ?? [];
  const colors = item.colors ?? [];
  if (stats.length > 8) throw new RangeError('at most 8 stat values');
  if (colors.length > 6) throw new RangeError('at most 6 colors');
  stats.forEach((v, i) => checkInt(v, 0, 65_535, `stat ${i}`));
  colors.forEach((v, i) => checkInt(v, -32_768, 32_767, `color ${i}`));
  const owner = resolveOwner(c, item.owner);
  const taken = itemIds(c);
  let itemId: [number, number];
  if (item.itemId) {
    itemId = [checkInt(item.itemId[0], 0, 2 ** 32 - 1, 'ItemID1'), checkInt(item.itemId[1], 0, 2 ** 32 - 1, 'ItemID2')];
    if (taken.has(`${itemId[0]}:${itemId[1]}`)) throw new RangeError(`item id ${itemId.join(':')} already in the file`);
  } else {
    const random = opts.randomId ?? randomItemId;
    let tries = 0;
    do {
      itemId = random();
      if (++tries > 100) throw new Error('no free item id found');
    } while (taken.has(`${itemId[0]}:${itemId[1]}`));
  }
  const quantity = checkInt(item.quantity ?? 1, 1, 2 ** 32, 'quantity');
  const allowRemoval = item.allowRemoval ?? true;
  const entry = tributeItemEntry({
    archetype, itemId, uploadTime, expiration, owner,
    quantityRaw: quantity - 1,
    quality: checkInt(item.quality ?? 0, 0, 255, 'quality'),
    rating: checkFloat(item.rating ?? 0, 'rating'),
    durability: checkFloat(item.durability ?? 0, 'durability'),
    stats, colors, isBlueprint: item.isBlueprint ?? false, allowRemoval,
    customName: item.customName ?? null, customDescription: item.customDescription ?? null,
    crafterName: item.crafterName ?? null, crafterTribe: item.crafterTribe ?? null,
    ammo: checkInt(item.ammo ?? 0, 0, 2 ** 32 - 1, 'ammo'),
  });
  let arr = findProperty(data, 'ArkItems');
  if (!arr) {
    arr = { name: 'ArkItems', type: 'ArrayProperty', index: 0, inner: 'StructProperty', value: [] };
    data.unshift(arr);
  }
  if (arr.opaque || arr.elementStruct || !Array.isArray(arr.value)) throw new RangeError('ArkItems is not an array of structs');
  const list = arr.value as Property[][];
  list.push(entry);
  return {
    tree,
    added: {
      index: list.length - 1, itemId, blueprint: archetype, quantity, quantityRaw: quantity - 1, allowRemoval, uploadTime,
      expiration, validUntil, owner: owner.toString(),
    },
  };
}
