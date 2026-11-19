// Turns parsed objects into snapshot rows: stable keys, categories, owners, JSON with references
// rendered as stable keys, and a hash over everything that is not volatile.
//
// Stable keys (they survive saves and server restarts):
//   item:<ItemID1>:<ItemID2>       items (ItemId struct)
//   dino:<DinoID1>:<DinoID2>       creatures, also inside cryopods
//   pawn:<LinkedPlayerDataID>      player characters in the world
//   player:<PlayerDataID>          player profiles (.arkprofile)
//   tribe:<TribeId>                tribes (.arktribe)
//   actor:<name>                   other placed actors (structures, ...)
//   actor:<name>@<data file>       actors stored in a sublevel (foliage, NPC zones)
//   <owner key>/<name>             components (inventories, status) below their owner
// A key that is already taken gets "#2", "#3", ... (ARK keeps many structures twice).
import { createHash } from 'node:crypto';
import type { SaveFile } from './savegame.ts';
import { type Embedded, type GameObject, jsonContext, ObjectRef, type Props, type Value } from './types.ts';

/**
 * Fields that change without a player doing anything: timers the game refreshes on its own,
 * values rerolled at server start, platform IDs. They stay in the JSON but do not count as a
 * change. Found by comparing Gen2 saves 2 h and 24 h apart (`ark-export compare`).
 */
export const VOLATILE_FIELDS = new Set<string>([
  // stasis and range timers (refreshed on every save, all objects after a restart)
  'LastEnterStasisTime',
  'LastInAllyRangeTime',
  'LastInAllyRangeTimeSerialized',
  // spoiling, fuel, crops, inventories
  'NextSpoilingTime',
  'LastCheckedFuelTime',
  'CropRefreshInterval',
  'LastCropRefreshTime',
  'CropRefreshTimeCache',
  'SolarRefreshInterval',
  'LastInventoryRefreshTime',
  'LastActivatedTime',
  'LastDeactivatedTime',
  'LastFireTime',
  'LastChecked_IN',
  // creature timers and values the game rerolls
  'LastTriedDiggingTime',
  'UntamedPoopTimeCache',
  'LastScreamTime',
  'RequiredTamingFoodIndex',
  'bAutoChargeActive',
  'Saved Hacking Pattern',
  // spawners, world clock
  'NumSpawnFailures',
  'LastIncreaseNPCTime',
  'NetworkTime',
  'DayTime',
  'DayNumber',
  'LastServerSaveTime',
  // player characters
  'PlatformProfileID',
]);

export type Source = 'world' | 'cryo' | 'profile' | 'tribe' | 'tribute';

export interface Row {
  key: string;
  source: Source;
  category: string;
  cls: string;
  names: string;
  container: string | null;
  owner: string | null;
  team: number | null;
  x: number | null; y: number | null; z: number | null;
  pitch: number | null; yaw: number | null; roll: number | null;
  dataFile: number | null;
  guid: string | null;
  hash: string;
  props: string;
  extra: string | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

function isStruct(v: Value | undefined): v is { [key: string]: Value } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

export function category(o: GameObject): string {
  const p = o.props;
  if (o.isItem) return 'item';
  if ('DinoID1' in p) return 'dino';
  if ('LinkedPlayerDataID' in p) return 'pawn';
  if (o.loc !== null && ('TargetingTeam' in p || 'OwnerName' in p)) return 'structure';
  if (o.loc !== null) return 'actor';
  return 'component';
}

/** Keys from IDs stored in the properties, independent of the object's position in the file. */
function idKey(o: GameObject): string | null {
  const p = o.props;
  if (o.isItem && isStruct(p.ItemId)) return `item:${p.ItemId.ItemID1}:${p.ItemId.ItemID2}`;
  if ('DinoID1' in p) return `dino:${p.DinoID1}:${p.DinoID2}`;
  if ('LinkedPlayerDataID' in p) return `pawn:${p.LinkedPlayerDataID}`;
  return null;
}

function hashOf(s: string): string {
  return createHash('md5').update(s).digest('base64url').slice(0, 22);
}

/** Serializes props; volatile fields go last and are left out of the hash. */
function serialize(props: Props): { json: string; hash: string } {
  let stable: Props | null = null;
  let volatile: Props | null = null;
  for (const k in props) {
    if (VOLATILE_FIELDS.has(k)) {
      if (stable === null) {
        stable = {};
        for (const j in props) { if (j === k) break; stable[j] = props[j]; }
      }
      (volatile ??= {})[k] = props[k];
    } else if (stable !== null) {
      stable[k] = props[k];
    }
  }
  const stableJson = JSON.stringify(stable ?? props);
  const hash = hashOf(stableJson);
  if (volatile === null) return { json: stableJson, hash };
  const volatileJson = JSON.stringify(volatile);
  const json = stableJson === '{}' ? volatileJson : `${stableJson.slice(0, -1)},${volatileJson.slice(1)}`;
  return { json, hash };
}

/** Assigns unique keys: the first holder keeps the key, later ones get #2, #3, ... */
export class KeyRegistry {
  private readonly seen = new Map<string, number>();
  duplicates = 0;

  has(key: string): boolean { return this.seen.has(key); }

  claim(key: string): string {
    const n = this.seen.get(key);
    if (n === undefined) { this.seen.set(key, 1); return key; }
    this.seen.set(key, n + 1);
    this.duplicates++;
    return `${key}#${n + 1}`;
  }
}

const SEP = '\u0001';

/**
 * Computes keys for all objects of one archive. Components are keyed below their outer object,
 * which is found through the names list (names[1..] are the names of the outer object).
 */
export function indexNames(objects: GameObject[]): Map<string, number> {
  const byNames = new Map<string, number>();
  for (let i = 0; i < objects.length; i++) {
    const names = objects[i].names;
    if (!names.length) continue;
    const k = names.join(SEP);
    if (!byNames.has(k)) byNames.set(k, i); // duplicates: the first holder owns the components
  }
  return byNames;
}

export function assignKeys(
  objects: GameObject[], registry: KeyRegistry, prefix: string | null, byNames = indexNames(objects),
): (string | null)[] {
  const keys: (string | null)[] = new Array(objects.length).fill(null);
  const order = Array.from(objects.keys()).sort((a, b) => objects[a].names.length - objects[b].names.length || a - b);
  for (const i of order) {
    const o = objects[i];
    let key = idKey(o);
    // Inside an embedded archive an ID can repeat its container's: the Ferox keeps its other
    // form (same DinoID) as embedded data. Such copies live below their container.
    if (key !== null && prefix !== null && registry.has(key)) key = `${prefix}/${o.names[0] ?? `#${i}`}`;
    if (key === null) {
      if (o.names.length > 1) {
        const outer = byNames.get(o.names.slice(1).join(SEP));
        const outerKey = outer !== undefined ? keys[outer] : null;
        key = outerKey !== null ? `${outerKey}/${o.names[0]}` : `${prefix ?? 'obj'}:${o.names.join('/')}`;
      } else {
        const name = o.names[0] ?? `#${i}`;
        // Sublevels each have their own InstancedFoliageActor_0 etc.; the data file tells them apart.
        key = prefix !== null ? `${prefix}/${name}` : o.fromDataFile ? `actor:${name}@${o.dataFile}` : `actor:${name}`;
      }
    }
    keys[i] = registry.claim(key);
  }
  return keys;
}

function outerIndex(objects: GameObject[], byNames: Map<string, number>, o: GameObject): number | undefined {
  return o.names.length > 1 ? byNames.get(o.names.slice(1).join(SEP)) : undefined;
}

export interface EmitStats { rows: number; cryoArchives: number; cryoObjects: number; duplicateKeys: number; }

/**
 * Emits one row per object of an archive (world save, profile, tribe or embedded archive).
 * Embedded archives found while serializing are emitted right after their container.
 */
export function emitArchive(
  objects: GameObject[], keys: (string | null)[], source: Source, container: string | null,
  registry: KeyRegistry, emit: (row: Row) => void, stats: EmitStats,
  options: {
    overrides?: (o: GameObject, i: number) => { category?: string; owner?: string | null; team?: number | null } | undefined;
    byNames?: Map<string, number>;
    /** Drop each object's properties once its row is out (keeps memory flat for big saves). */
    release?: boolean;
  } = {},
): void {
  const byNames = options.byNames ?? indexNames(objects);
  // Inventory component -> owning actor, so items can point at the actor that carries them.
  const inventoryOwner = new Map<number, number>();
  for (let i = 0; i < objects.length; i++) {
    const inv = objects[i].props.MyInventoryComponent;
    if (inv instanceof ObjectRef && inv.index >= 0 && !inventoryOwner.has(inv.index)) inventoryOwner.set(inv.index, i);
  }
  const pending: { embedded: Embedded; container: string }[] = [];
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const key = keys[i] as string;
    jsonContext.keys = keys;
    jsonContext.onEmbedded = (e: Embedded) => {
      pending.push({ embedded: e, container: key });
      return { $embedded: e.objects.length };
    };
    const { json, hash } = serialize(o.props);
    jsonContext.onEmbedded = null;
    let owner: string | null = null;
    const outer = outerIndex(objects, byNames, o);
    if (outer !== undefined) owner = keys[outer];
    const inv = o.props.OwnerInventory;
    if (inv instanceof ObjectRef && inv.index >= 0) {
      const holder = inventoryOwner.get(inv.index) ?? outerIndex(objects, byNames, objects[inv.index] ?? o);
      owner = holder !== undefined ? keys[holder] : keys[inv.index] ?? owner;
    }
    const ov = options.overrides?.(o, i);
    const loc = o.loc;
    emit({
      key, source, category: ov?.category ?? category(o), cls: o.cls, names: JSON.stringify(o.names),
      container, owner: ov?.owner !== undefined ? ov.owner : owner,
      team: ov?.team !== undefined ? ov.team : num(o.props.TargetingTeam),
      x: loc ? num(loc.x) : null, y: loc ? num(loc.y) : null, z: loc ? num(loc.z) : null,
      pitch: loc ? num(loc.pitch) : null, yaw: loc ? num(loc.yaw) : null, roll: loc ? num(loc.roll) : null,
      dataFile: o.fromDataFile ? o.dataFile : null, guid: o.guid, hash,
      props: json, extra: o.extra === undefined ? (o.error ? JSON.stringify({ error: o.error }) : null) : JSON.stringify(o.error ? { error: o.error, data: o.extra } : o.extra),
    });
    stats.rows++;
    if (options.release) { o.props = {}; o.extra = undefined; }
    for (const p of pending.splice(0)) {
      stats.cryoArchives++;
      stats.cryoObjects += p.embedded.objects.length;
      const subKeys = assignKeys(p.embedded.objects, registry, p.container);
      emitArchive(p.embedded.objects, subKeys, 'cryo', p.container, registry, emit, stats);
      jsonContext.keys = keys;
    }
  }
}

/** World save: keys, then rows. */
export function emitWorld(save: SaveFile, registry: KeyRegistry, emit: (row: Row) => void, stats: EmitStats, release = false): void {
  const byNames = indexNames(save.objects);
  const keys = assignKeys(save.objects, registry, null, byNames);
  emitArchive(save.objects, keys, 'world', null, registry, emit, stats, { byNames, release });
}
