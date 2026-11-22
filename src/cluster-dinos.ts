// Creatures in cluster files: put a creature into a player's uploads, copy items such as filled souls.
//
// An uploaded creature (an ArkTamedDinosData entry, see cluster.ts) carries the creature itself in
// DinoData: an embedded inline-named archive with three objects, the creature (DinoID1/2, TamedName,
// TargetingTeam, TamerString, ...), its status component (levels, stats, experience) and its
// inventory component. Cryopods and Dino Storage souls keep the very same archive in
// CustomItemDatas[].CustomDataBytes.ByteArrays[].Bytes. On download the game spawns the creature from
// DinoData (APrimalDinoCharacter::SpawnFromDinoDataEx, which also gets the downloading player's team
// and a duplicate check); the other fields of the entry (name, DinoStats texts, experience) are what
// the upload list shows.
//
// addDino turns any such archive into a new upload entry: fresh DinoIDs (unless kept), a new
// UploadTime and the listing fields from the source entry or derived from the archive.
// copyItem copies an ArkItems entry (e.g. a filled soul or cryopod) with a new ItemID, upload time,
// expiry and owner and gives the creatures inside new DinoIDs as well.
//
// Creatures that stand in the world of a save are objects of the save itself. They are packed into
// the same archive form with toInlineArchive and then shaped like the archives the game writes (see
// asGameArchive), so a creature from any backup can be handed back as an upload. A world save holds
// no maximum stat values; for the texts of the upload list they are estimated from the archives of
// the same class in the save (creature-stats.ts).
import { randomInt } from 'node:crypto';
import { assetName, classPathsInNames, InstallDir } from './class-paths.ts';
import {
  clusterData, clusterEntries, createClusterTree, DEFAULT_EXPIRES_IN, defaultOwner, itemIds, randomItemId,
} from './cluster.ts';
import { type MaxStatus, MaxStatusEstimator } from './creature-stats.ts';
import { SaveEditor } from './editor.ts';
import { toInlineArchive } from './inline.ts';
import { readSave, type SaveFile } from './savegame.ts';
import {
  cloneProperty, findProperty, type Property, readContainerTree, remapRefs, type TreeContainer, type TreeObject, writeContainerTree,
} from './tree.ts';
import { Embedded, type Props, type Value } from './types.ts';

// ---------------------------------------------------------------- creature archives

export interface CreatureArchive {
  tree: TreeContainer;
  creature: TreeObject;
  status: TreeObject | null;
}

/** A creature archive (DinoData, cryopod or soul bytes), or null if the bytes are something else. */
export function readCreatureArchive(bytes: Buffer): CreatureArchive | null {
  if (bytes.length < 40) return null;
  let tree: TreeContainer;
  try {
    tree = readContainerTree(bytes, { version: false });
  } catch {
    return null;
  }
  const creature = tree.objects[0];
  if (!creature || !findProperty(creature.props, 'DinoID1') || !findProperty(creature.props, 'DinoID2')) return null;
  const ref = findProperty(creature.props, 'MyCharacterStatusComponent')?.value;
  const byRef = ref && typeof ref === 'object' && !Array.isArray(ref) && 'index' in ref ? tree.objects[ref.index as number] : undefined;
  const status = byRef ?? tree.objects.find((o) => /StatusComponent/.test(o.cls ?? '')) ?? null;
  return { tree, creature, status };
}

const num = (list: Property[] | undefined, name: string, index = 0): number | null => {
  const v = list ? findProperty(list, name, index)?.value : undefined;
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null;
};
const text = (list: Property[] | undefined, name: string): string | null => {
  const v = list ? findProperty(list, name)?.value : undefined;
  return typeof v === 'string' ? v : null;
};

export function creatureId(a: CreatureArchive): [number, number] {
  return [num(a.creature.props, 'DinoID1') ?? 0, num(a.creature.props, 'DinoID2') ?? 0];
}

export interface CreatureInfo {
  dinoId: [number, number];
  /** Object class, e.g. "Raptor_Character_BP_C". */
  cls: string;
  tamedName: string | null;
  level: number | null;
  experience: number | null;
  female: boolean;
  /** TargetingTeam: the tribe (or player) the creature belongs to. */
  team: number | null;
  tamer: string | null;
  owningPlayer: string | null;
  imprinter: string | null;
  mutations: number;
}

export function creatureInfo(a: CreatureArchive): CreatureInfo {
  const c = a.creature.props;
  const s = a.status?.props;
  const base = num(s, 'BaseCharacterLevel');
  return {
    dinoId: creatureId(a),
    cls: a.creature.cls ?? '',
    tamedName: text(c, 'TamedName'),
    level: base === null ? null : base + (num(s, 'ExtraCharacterLevel') ?? 0),
    experience: num(s, 'ExperiencePoints'),
    female: findProperty(c, 'bIsFemale')?.value === true,
    team: num(c, 'TargetingTeam'),
    tamer: text(c, 'TamerString'),
    owningPlayer: text(c, 'OwningPlayerName'),
    imprinter: text(c, 'ImprinterName'),
    mutations: (num(c, 'RandomMutationsFemale') ?? 0) + (num(c, 'RandomMutationsMale') ?? 0),
  };
}

/** Sets an existing numeric property, keeping its type (UInt32 in the game's files, Int in older tools). */
function setNumber(list: Property[], name: string, v: number): void {
  const p = findProperty(list, name);
  if (!p) throw new RangeError(`${name} missing`);
  p.value = p.type === 'UInt64Property' || p.type === 'Int64Property' ? BigInt(v) : v;
}

function setString(list: Property[], name: string, v: string): void {
  const p = findProperty(list, name);
  if (p) p.value = v;
  else list.push({ name, type: 'StrProperty', index: 0, value: v });
}

// ---------------------------------------------------------------- sources

export interface CreatureSource {
  /** Where it was found, e.g. "ArkTamedDinosData[2]", "ArkItems[5] SoulTrap_DS_C", "Cryopod_C_12 (object 4711)". */
  where: string;
  /**
   * soul = Dino Storage soul, recovery = Dino Storage admin recovery list, vivarium = S+ vivarium,
   * world = tamed creature standing in the world of a save.
   */
  kind: 'upload' | 'soul' | 'recovery' | 'cryopod' | 'vivarium' | 'item' | 'world';
  data: Buffer;
  /** The ArkTamedDinosData entry the creature came from; its fields are copied by addDino. */
  entry?: Property[];
  /** Blueprint path "/Game/.../X.X" if known. */
  blueprint: string | null;
  /**
   * Where the blueprint path came from: the source's own data, another creature of the same class in
   * the same file, the save's name table, the game files (installDir); null if unknown.
   */
  blueprintFrom?: 'own' | 'same-class' | 'name-table' | 'install-dir' | null;
  /** Paths found when a lookup had more than one answer; none of them is used. */
  blueprintCandidates?: string[];
  /** Display name of the species ("Tek Rex") if known. */
  species: string | null;
  info: CreatureInfo;
  /** For kind world: where it stands and what packing it changed. */
  world?: WorldPacking;
  /** Set when the creature cannot be copied as it is; addDino refuses it. */
  problem?: string;
}

export interface WorldPacking {
  /** Object index in the save. */
  index: number;
  location: { x: number; y: number; z: number } | null;
  tribeName: string | null;
  /** References to objects outside the creature that were removed (bed, saddle structures, items), by property path. */
  droppedRefs: Record<string, number>;
  /** Properties left out because the game leaves them out of creature archives (see asGameArchive). */
  removedProps: string[];
  /** Objects left out (painting component). */
  removedObjects: string[];
  /** Outer names added to every object: ["PersistentLevel", map, map package]; null if unknown. */
  level: string[] | null;
  /**
   * MaxStatusValues 0–7 for the texts of the upload list (DinoStats), estimated from archives of
   * the same class in the save; null without such archives.
   */
  maxStatus: MaxStatus | null;
}

const LISTING = /^(.*) - Lvl (\d+) \((.+)\)$/;

/** "/Game/A/B.B" from Blueprint'/Game/A/B.B', BlueprintGeneratedClass /Game/A/B.B_C, /Game/A/B.B_C or /Game/A/B.B. */
export function creatureBlueprint(spec: string): string {
  let s = spec.trim().replace(/^"(.*)"$/, '$1');
  if (s.startsWith('BlueprintGeneratedClass ')) s = s.slice('BlueprintGeneratedClass '.length).trim();
  const quoted = /^\w+'(.*)'$/.exec(s);
  if (quoted) s = quoted[1];
  if (!/^\/Game\/[\w\-/]+\.\w+$/.test(s)) throw new RangeError(`not a creature class path: ${spec}`);
  const [pkgPath, obj] = s.split('.');
  const pkg = pkgPath.slice(pkgPath.lastIndexOf('/') + 1);
  const name = obj.endsWith('_C') && obj !== `${pkg}` ? obj.slice(0, -2) : obj;
  if (name !== pkg) throw new RangeError(`class name does not match its package: ${spec}`);
  return `${pkgPath}.${name}`;
}

/** Blueprint path in item data (cryopods: CustomDataClasses, Dino Storage: CustomDataStrings) for a creature class. */
function blueprintIn(strings: (string | null)[], classes: Value[], cls: string): string | null {
  const want = cls.endsWith('_C') ? cls.slice(0, -2) : cls;
  for (const c of [...classes.map((v) => (v && typeof v === 'object' && 'path' in v ? (v as { path: string | null }).path : v)), ...strings]) {
    if (typeof c !== 'string') continue;
    try {
      const bp = creatureBlueprint(c);
      if (bp.endsWith(`.${want}`)) return bp;
    } catch { /* not a class path */ }
  }
  return null;
}

const speciesIn = (strings: (string | null)[]): string | null => {
  for (const s of strings) {
    const m = s ? LISTING.exec(s) : null;
    if (m) return m[3];
  }
  return null;
};

function itemKind(archetype: string | null): CreatureSource['kind'] {
  if (!archetype) return 'item';
  if (/Cryopod/i.test(archetype)) return 'cryopod';
  if (/DinoStorage2CCA/i.test(archetype)) return 'recovery';
  if (/SoulTrap|DinoStorage/i.test(archetype)) return 'soul';
  if (/Vivarium/i.test(archetype)) return 'vivarium';
  return 'item';
}

export interface ClassPathSources {
  /** Blueprint paths by asset name, from the save's name table (classPathsInNames). */
  names?: Map<string, Set<string>>;
  /** Game or server installation (ShooterGame/Content). */
  install?: InstallDir;
}

/**
 * Sources without a class path (creatures in the world, vivariums, Ferox forms) get it from, in
 * this order: other sources of the same class, the name table, the game files. A step with more than
 * one answer ends the search without a path (blueprintCandidates): short names are not unique.
 */
function fillBlueprints(list: CreatureSource[], more: ClassPathSources = {}): CreatureSource[] {
  const known = new Map<string, Set<string>>();
  for (const s of list) {
    if (!s.blueprint) continue;
    s.blueprintFrom ??= 'own';
    (known.get(s.info.cls) ?? known.set(s.info.cls, new Set()).get(s.info.cls)!).add(s.blueprint);
  }
  const steps: [NonNullable<CreatureSource['blueprintFrom']>, (cls: string) => Iterable<string>][] = [
    ['same-class', (cls) => known.get(cls) ?? []],
    ['name-table', (cls) => more.names?.get(assetName(cls)) ?? []],
    ['install-dir', (cls) => more.install?.lookup(cls).paths ?? []],
  ];
  for (const s of list) {
    if (s.blueprint) continue;
    s.blueprintFrom = null;
    for (const [from, find] of steps) {
      const found = [...new Set(find(s.info.cls))].sort();
      if (found.length === 1) {
        s.blueprint = found[0];
        s.blueprintFrom = from;
      }
      if (found.length > 1) s.blueprintCandidates = found;
      if (found.length) break;
    }
  }
  return list;
}

/** Creature archives inside the CustomItemDatas of one ItemNetInfo (lossless tree). */
function creaturesInItemInfo(info: Property[]): { data: Buffer; strings: (string | null)[]; classes: Value[]; path: [number, number] }[] {
  const out: { data: Buffer; strings: (string | null)[]; classes: Value[]; path: [number, number] }[] = [];
  const datas = findProperty(info, 'CustomItemDatas')?.value;
  if (!Array.isArray(datas)) return out;
  (datas as Property[][]).forEach((d, i) => {
    if (!Array.isArray(d)) return;
    const strings = (findProperty(d, 'CustomDataStrings')?.value ?? []) as (string | null)[];
    const classes = ((findProperty(d, 'CustomDataClasses')?.value ?? []) as unknown[]).map((v) => v as Value);
    const bytes = findProperty(d, 'CustomDataBytes')?.value;
    const arrays = Array.isArray(bytes) ? findProperty(bytes as Property[], 'ByteArrays')?.value : undefined;
    if (!Array.isArray(arrays)) return;
    (arrays as Property[][]).forEach((ba, k) => {
      const b = Array.isArray(ba) ? findProperty(ba, 'Bytes')?.value : undefined;
      if (Buffer.isBuffer(b) && readCreatureArchive(b)) out.push({ data: b, strings, classes, path: [i, k] });
    });
  });
  return out;
}

/** Uploaded creatures and creatures in uploaded items (souls, cryopods) of a cluster file. */
export function creaturesInCluster(c: TreeContainer | null, opts: { installDir?: string | InstallDir } = {}): CreatureSource[] {
  const out: CreatureSource[] = [];
  clusterEntries(c, 'ArkTamedDinosData').forEach((e, i) => {
    const data = findProperty(e, 'DinoData')?.value;
    const a = Buffer.isBuffer(data) ? readCreatureArchive(data) : null;
    if (!a) return;
    const className = text(e, 'DinoClassName');
    const cls = findProperty(e, 'DinoClass')?.value as { path?: string | null } | undefined;
    let blueprint: string | null = null;
    for (const s of [className, cls?.path ?? null]) {
      if (blueprint || !s) continue;
      try { blueprint = creatureBlueprint(s); } catch { /* keep looking */ }
    }
    const name = text(e, 'DinoName');
    out.push({
      where: `ArkTamedDinosData[${i}]`, kind: 'upload', data: data as Buffer, entry: e, blueprint,
      species: (name && LISTING.exec(name)?.[3]) ?? null, info: creatureInfo(a),
    });
  });
  clusterEntries(c, 'ArkItems').forEach((e, i) => {
    const info = findProperty(e, 'ArkTributeItem')?.value;
    if (!Array.isArray(info)) return;
    const arch = (findProperty(info as Property[], 'ItemArchetype')?.value as { path?: string | null } | undefined)?.path ?? null;
    const short = arch ? arch.slice(arch.lastIndexOf('.') + 1) : 'item';
    for (const x of creaturesInItemInfo(info as Property[])) {
      const a = readCreatureArchive(x.data)!;
      out.push({
        where: `ArkItems[${i}] ${short}`, kind: itemKind(arch), data: x.data, blueprint: blueprintIn(x.strings, x.classes, a.creature.cls ?? ''),
        species: speciesIn(x.strings), info: creatureInfo(a),
      });
    }
  });
  return fillBlueprints(out, { install: installDir(opts.installDir) });
}

const installDir = (d: string | InstallDir | undefined): InstallDir | undefined => (typeof d === 'string' ? new InstallDir(d) : d);

export interface SaveCreatureOptions {
  /** Also tamed creatures standing in the world (default true). */
  world?: boolean;
  /** Game or server installation for class paths that the save does not hold. */
  installDir?: string | InstallDir;
  /**
   * Package of the map for the outer names of world creatures, e.g. "/Game/Maps/TheIslandSubMaps/TheIsland".
   * Default: from the creature archives of the same map in the save, else from its name table.
   */
  level?: string;
  /** Collects notes: creatures left out, unknown map package, save version. */
  warnings?: string[];
}

/**
 * Creatures of a savegame (.ark): in cryopods, souls, the Dino Storage recovery list and vivariums
 * (archives the game wrote), and tamed creatures standing in the world (packed here, see
 * worldCreatures).
 */
export function creaturesInSave(buf: Buffer, opts: SaveCreatureOptions = {}): CreatureSource[] {
  const save = readSave(buf);
  const out: CreatureSource[] = [];
  const seen = new Set<Buffer>();
  const visit = (v: Value, where: string, strings: (string | null)[], classes: Value[], owner: string | null): void => {
    if (v instanceof Embedded) {
      if (!v.bytes || seen.has(v.bytes)) return;
      seen.add(v.bytes);
      const a = readCreatureArchive(v.bytes);
      if (!a) return;
      out.push({
        where, kind: itemKind(owner), data: v.bytes, blueprint: blueprintIn(strings, classes, a.creature.cls ?? ''),
        species: speciesIn(strings), info: creatureInfo(a),
      });
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, where, strings, classes, owner);
      return;
    }
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const o = v as Props;
      const s = Array.isArray(o.CustomDataStrings) ? (o.CustomDataStrings as (string | null)[]) : strings;
      const k = Array.isArray(o.CustomDataClasses) ? (o.CustomDataClasses as Value[]) : classes;
      for (const key in o) visit(o[key], where, s, k, owner);
    }
  };
  for (const o of save.objects) {
    visit(o.props as Value, `${o.names[0] ?? o.cls} (object ${o.index})`, [], [], o.cls);
  }

  const warnings = opts.warnings ?? [];
  let ed: SaveEditor | null = null;
  try {
    ed = SaveEditor.open(buf);
  } catch (e) {
    warnings.push(`creatures in the world and the name table are read from save version 9 only: ${(e as Error).message}`);
  }
  if (ed && opts.world !== false) out.push(...worldCreatures(ed, save, out, opts.level, warnings));
  return fillBlueprints(out, { names: ed ? classPathsInNames(ed.table.names) : undefined, install: installDir(opts.installDir) });
}

/** TargetingTeam of tamed creatures (tribe or player id); wild ones have smaller teams. */
const TAMED_TEAM = 50_000;

/**
 * Tamed creatures that stand in the world, each packed with its status and inventory component
 * (without items) like the game packs a creature for a cryopod or an upload. Dead ones and second
 * entries of the same actor (the game writes some actors twice) are left out.
 */
function worldCreatures(ed: SaveEditor, save: SaveFile, archives: CreatureSource[], level: string | undefined, warnings: string[]): CreatureSource[] {
  if (!ed.hibernationEmpty) warnings.push('the hibernation block is not empty; creatures stored there are not listed');
  const chain = levelChain(save, archives, ed.table.names, level);
  if (!chain) warnings.push(`map package of ${save.dataFiles[0]} unknown (no creature archive of this map in the save); give level (--level)`);
  const stats = new MaxStatusEstimator(archives.flatMap((s) => {
    const a = readCreatureArchive(s.data);
    return a?.status ? [{ cls: a.creature.cls ?? '', map: a.creature.names[2] ?? null, status: a.status.props }] : [];
  }));
  const map = save.dataFiles[0] ?? null;
  let unknownStats = 0;
  const out: CreatureSource[] = [];
  const names = new Set<string>();
  let dead = 0;
  let twice = 0;
  for (const o of save.objects) {
    if (o.isItem || o.names.length !== 1 || !o.loc) continue;
    const p = o.props;
    if (typeof p.DinoID1 !== 'number' || typeof p.TargetingTeam !== 'number' || p.TargetingTeam < TAMED_TEAM) continue;
    if (p.bIsDead === true) { dead++; continue; }
    if (names.has(o.names[0])) { twice++; continue; }
    names.add(o.names[0]);
    const packed = toInlineArchive(ed, [o.index]);
    const shaped = asGameArchive(packed.bytes, chain);
    const a = readCreatureArchive(shaped.bytes);
    if (!a) {
      warnings.push(`${o.names[0]} (object ${o.index}): packed creature does not read back`);
      continue;
    }
    const loc = o.loc;
    const maxStatus = stats.estimate(a.creature.cls ?? '', map, a.status?.props ?? []);
    if (!maxStatus || maxStatus.values[2] === null || maxStatus.values[7] === null) unknownStats++;
    out.push({
      where: `${o.names[0]} (object ${o.index})`, kind: 'world', data: shaped.bytes, blueprint: null, species: null, info: creatureInfo(a),
      world: {
        index: o.index,
        location: { x: Number(loc.x), y: Number(loc.y), z: Number(loc.z) },
        tribeName: typeof p.TribeName === 'string' ? p.TribeName : null,
        droppedRefs: packed.droppedRefs, removedProps: shaped.removedProps, removedObjects: shaped.removedObjects, level: chain, maxStatus,
      },
      ...(chain ? {} : { problem: 'map package unknown; give level (--level)' }),
    });
  }
  if (unknownStats) {
    warnings.push(`${unknownStats} creatures in the world without maximum torpidity or weight for the upload list (no fitting archives of their class in the save)`);
  }
  if (dead) warnings.push(`${dead} dead tamed creatures in the world left out`);
  if (twice) warnings.push(`${twice} second entries of the same creature left out (the game writes some actors twice)`);
  return out;
}

/**
 * Outer names of the objects in a creature archive. The game writes the creature as
 * [name, "PersistentLevel", map, map package] and its components as [name, creature, ...the same];
 * a world save has only [name] and [name, creature]. The chain comes from creature archives of the
 * same map in the save (most frequent), else from a name table entry "/Game/.../<map>".
 */
export function levelChain(save: Pick<SaveFile, 'dataFiles'>, archives: CreatureSource[], names: string[], level?: string): string[] | null {
  if (level !== undefined) {
    if (!/^\/Game\/[\w\-/]+\/\w+$/.test(level)) throw new RangeError(`level must be a package path like /Game/Maps/TheIslandSubMaps/TheIsland, got ${level}`);
    return ['PersistentLevel', level.slice(level.lastIndexOf('/') + 1), level];
  }
  const map = save.dataFiles[0];
  if (!map) return null;
  const count = new Map<string, number>();
  for (const s of archives) {
    const chain = readCreatureArchive(s.data)?.creature.names.slice(1);
    if (chain?.length === 3 && chain[0] === 'PersistentLevel' && chain[1] === map && chain[2]?.endsWith(`/${map}`)) {
      count.set(chain[2], (count.get(chain[2]) ?? 0) + 1);
    }
  }
  const best = [...count].sort((x, y) => y[1] - x[1])[0]?.[0];
  if (best) return ['PersistentLevel', map, best];
  const inNames = [...new Set(names.filter((n) => n.startsWith('/Game/') && n.endsWith(`/${map}`) && !n.includes('.')))];
  return inNames.length === 1 ? ['PersistentLevel', map, inNames[0]] : null;
}

/**
 * Properties of the creature that the game leaves out of creature archives. Observed in a
 * Genesis 2 save: 4,571 archives the game wrote (souls, recovery list, vivariums, from 16 maps)
 * hold none of them, while the 351 tamed creatures in the world of the same save have them:
 * time stamps of the source map (mating, gestation, baby age, last stasis), the tribe name, the
 * settings for mating, wandering and whistles, the saddle structures, Instigator, a pregnancy.
 */
const CREATURE_DROPS = new Set([
  'BabyCuddleFood', 'BabyCuddleType', 'BabyCuddleWalkStartingLocation', 'BabyGestationProgress', 'BabyNextCuddleTime',
  'bCollectVictimItems', 'bEnableTamedMating', 'bEnableTamedWandering', 'bHadStaticBase', 'bIgnoreAllWhistles', 'bIsFlying',
  'bIsLatched', 'bTargetingIgnoredByWildDinos', 'FollowStoppingDistance', 'GestationGenderOverride', 'Instigator', 'isUnderground',
  'LastEggSpawnChanceTime', 'LastEnterStasisTime', 'LastInAllyRangeTime', 'LastSkinnedTime', 'LastUpdatedBabyAgeAtTime',
  'LastUpdatedGestationAtTime', 'LastUpdatedMatingAtTime', 'NetworkCreationTime', 'NextAllowedMatingTime',
  'NonDedicatedFreezeDinoPhysicsIfLevelUnloaded', 'OriginalCreationTime', 'OriginalNPCVolumeName', 'PaintingComponent',
  'SaddleStructures', 'TamedAtTime', 'TamingLastFoodConsumptionTime', 'TribeName', 'UntamedPoopTimeCache',
]);
const CREATURE_DROP_PREFIX = /^(GestationEgg|NextBabyDino)/;
/** Inventory component: the items are not packed, and the game leaves out these as well. */
const INVENTORY_DROPS = new Set([
  'bInitializedMe', 'CustomFolderItems', 'DisplayDefaultItemInventoryCount', 'EquippedItems', 'InventoryItems', 'ItemSlots',
  'LastInventoryRefreshTime',
]);

/**
 * Shapes a creature packed from a world save (toInlineArchive) like the archives the game writes:
 * only the creature and its status and inventory components (no painting component), the outer
 * names of the map appended, the creature's GUID zero, the properties the game leaves out removed.
 * Everything else stays as it was in the save.
 */
export function asGameArchive(bytes: Buffer, level: string[] | null): { bytes: Buffer; removedProps: string[]; removedObjects: string[] } {
  const tree = readContainerTree(bytes, { version: false });
  const keep = tree.objects.map((o, i) => i === 0 || /StatusComponent|InventoryComponent/.test(o.cls ?? ''));
  const local = new Map<number, number>();
  keep.forEach((k, i) => { if (k) local.set(i, local.size); });
  const removedObjects = tree.objects.filter((_, i) => !keep[i]).map((o) => o.cls ?? '');
  const removed = new Set<string>();
  const objects = tree.objects.filter((_, i) => keep[i]).map((o, i): TreeObject => {
    const drop = (name: string): boolean => (i === 0
      ? CREATURE_DROPS.has(name) || CREATURE_DROP_PREFIX.test(name)
      : /InventoryComponent/.test(o.cls ?? '') && INVENTORY_DROPS.has(name));
    const props = o.props.filter((p) => !(drop(p.name) && removed.add(p.name)));
    remapRefs(props, (t) => local.get(t) ?? -1, true);
    return { ...o, props, names: level ? [...o.names, ...level] : o.names, guid: i === 0 ? Buffer.alloc(16) : o.guid };
  });
  return {
    bytes: writeContainerTree({ version: null, objects, gap: Buffer.alloc(0), order: [] }),
    removedProps: [...removed].sort(),
    removedObjects,
  };
}

// ---------------------------------------------------------------- new upload entries

const STAT_NAMES = [
  'Health', 'Stamina', 'Torpidity', 'Oxygen', 'Food', 'Water', 'Temperature', 'Weight', 'Melee Damage', 'Movement Speed',
  'Fortitude', 'Crafting Skill',
];

/**
 * The 12 texts the upload list shows, in the format of the game ("Health: 2572.1 / 2572.1", "Melee
 * Damage: 172.2 %"). The maximum is MaxStatusValues, else the estimate (never below the current
 * value), else the current value (torpidity 0).
 */
export function dinoStatTexts(a: CreatureArchive, estimated: (number | null)[] = []): string[] {
  const s = a.status?.props;
  return STAT_NAMES.map((name, i) => {
    const cur = num(s, 'CurrentStatusValues', i) ?? 0;
    const est = estimated[i];
    const max = num(s, 'MaxStatusValues', i) ?? (est != null ? Math.max(cur, est) : i === 2 ? 0 : cur);
    if (i === 2) return `${name}: 0.0 / ${max.toFixed(1)}`;
    if (i === 8 || i === 9 || i === 11) return `${name}: ${((1 + cur) * 100).toFixed(1)} %`;
    if (i === 10) return `${name}: ${cur.toFixed(1)}`;
    return `${name}: ${cur.toFixed(1)} / ${max.toFixed(1)}`;
  });
}

const speciesFromClass = (cls: string): string =>
  cls.replace(/_C$/, '').replace(/_Character_BP.*$|_BP.*$/, '').replace(/_/g, ' ');

export interface NewDino {
  /** New TamedName; also used for DinoName in the upload list. */
  name?: string;
  /** Blueprint path, needed when the source has none (Blueprint'/Game/...', /Game/.../X.X or /Game/.../X.X_C). */
  blueprint?: string;
  /** Display name of the species for the upload list. */
  species?: string;
  /** UploadTime, unix seconds. Default: now. */
  uploadTime?: number;
  /** Keep the DinoIDs of the source (only when the original no longer exists). Default: new random IDs. */
  keepId?: boolean;
  /** Use these DinoIDs. */
  dinoId?: [number, number];
}

export interface AddedDino {
  index: number;
  dinoId: [number, number];
  sourceId: [number, number];
  blueprint: string;
  name: string;
  uploadTime: number;
  /** Uploaded creatures in the file now, the game allows MaxTributeDinos (default 20). */
  dinos: number;
}

/** DinoIDs like the game's: two random numbers below 10^9. */
export const randomDinoId = (): [number, number] => [randomInt(1, 1_000_000_000), randomInt(1, 1_000_000_000)];

function dinoIds(c: TreeContainer | null): Set<string> {
  return new Set(clusterEntries(c, 'ArkTamedDinosData').map((e) => `${num(e, 'DinoID1')}:${num(e, 'DinoID2')}`));
}

function checkU32(v: number, what: string): number {
  if (!Number.isInteger(v) || v < 0 || v > 2 ** 32 - 1) throw new RangeError(`${what} must be an integer from 0 to ${2 ** 32 - 1}, got ${v}`);
  return v;
}

function pickId(taken: Set<string>, random: () => [number, number]): [number, number] {
  for (let tries = 0; tries < 100; tries++) {
    const id = random();
    if (!taken.has(`${id[0]}:${id[1]}`)) return id;
  }
  throw new Error('no free DinoID found');
}

const p = (name: string, type: string, value: Property['value'], more: Partial<Property> = {}): Property => ({ name, type, index: 0, value, ...more });

/** One ArkTamedDinosData entry with the fields in the order the game writes them. */
export function tributeDinoEntry(f: {
  blueprint: string; data: Buffer; name: string; nameInMap: string; stats: string[]; experience: number;
  dinoId: [number, number]; uploadTime: number;
}): Property[] {
  return [
    p('DinoClassName', 'StrProperty', `Blueprint'${f.blueprint}'`),
    p('DinoClass', 'ObjectProperty', { path: `BlueprintGeneratedClass ${f.blueprint}_C` }),
    p('DinoData', 'ArrayProperty', f.data, { inner: 'ByteProperty' }),
    p('DinoName', 'StrProperty', f.name),
    p('DinoNameInMap', 'StrProperty', f.nameInMap),
    ...f.stats.map((s, index) => ({ name: 'DinoStats', type: 'StrProperty', index, value: s })),
    p('DinoExperiencePoints', 'FloatProperty', f.experience),
    p('Version', 'FloatProperty', 2),
    p('DinoID1', 'UInt32Property', f.dinoId[0]),
    p('DinoID2', 'UInt32Property', f.dinoId[1]),
    p('UploadTime', 'IntProperty', f.uploadTime),
  ];
}

/**
 * Appends a creature to ArkTamedDinosData (creating the file structure for empty files). The source
 * archive is copied, the creature gets new DinoIDs (in the archive and the entry) unless keepId,
 * a new TamedName if given, and UploadTime now. The tree passed in is changed.
 */
export function addDino(
  c: TreeContainer | null, src: CreatureSource, d: NewDino = {},
  opts: { now?: number; randomId?: () => [number, number] } = {},
): { tree: TreeContainer; added: AddedDino } {
  if (src.problem) throw new RangeError(`${src.where}: ${src.problem}`);
  const a = readCreatureArchive(src.data);
  if (!a) throw new RangeError(`${src.where}: not a creature archive`);
  if (!writeContainerTree(a.tree).equals(src.data)) throw new RangeError(`${src.where}: the creature does not round-trip; refusing to copy it`);
  const tree = c ?? createClusterTree();
  const data = clusterData(tree);
  const sourceId = creatureId(a);
  const taken = dinoIds(c);
  let dinoId: [number, number];
  if (d.dinoId) dinoId = [checkU32(d.dinoId[0], 'DinoID1'), checkU32(d.dinoId[1], 'DinoID2')];
  else if (d.keepId) dinoId = sourceId;
  else dinoId = pickId(new Set([...taken, `${sourceId[0]}:${sourceId[1]}`]), opts.randomId ?? randomDinoId);
  if (taken.has(`${dinoId[0]}:${dinoId[1]}`)) throw new RangeError(`DinoID ${dinoId.join(':')} already in the file`);

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const uploadTime = d.uploadTime ?? now;
  if (!Number.isInteger(uploadTime) || uploadTime < 0 || uploadTime > 2 ** 31 - 1) throw new RangeError(`uploadTime out of range: ${uploadTime}`);

  setNumber(a.creature.props, 'DinoID1', dinoId[0]);
  setNumber(a.creature.props, 'DinoID2', dinoId[1]);
  if (d.name !== undefined) {
    if (!d.name.trim()) throw new RangeError('name must not be empty');
    setString(a.creature.props, 'TamedName', d.name);
  }
  const bytes = writeContainerTree(a.tree);
  const check = readCreatureArchive(bytes);
  if (!check || creatureId(check).join(':') !== dinoId.join(':')) throw new Error('the changed creature does not read back');

  const info = creatureInfo(a);
  const blueprint = d.blueprint ? creatureBlueprint(d.blueprint) : src.blueprint;
  if (!blueprint) throw new RangeError(`${src.where}: class path of ${info.cls} unknown; give it (blueprint)`);
  const want = info.cls.replace(/_C$/, '');
  if (!blueprint.endsWith(`.${want}`)) throw new RangeError(`blueprint ${blueprint} does not match the creature class ${info.cls}`);
  const species = d.species ?? src.species ?? speciesFromClass(info.cls);
  const listingName = (old: string | null): string => {
    const m = old ? LISTING.exec(old) : null;
    const shown = d.name ?? info.tamedName ?? m?.[1] ?? species;
    return `${shown} - Lvl ${info.level ?? m?.[2] ?? 1} (${m?.[3] ?? species})`;
  };

  let entry: Property[];
  if (src.entry) {
    entry = src.entry.map(cloneProperty);
    const set = (name: string, v: Property['value']) => {
      const prop = findProperty(entry, name);
      if (!prop) throw new RangeError(`${src.where}: ${name} missing in the source entry`);
      prop.value = v;
    };
    set('DinoData', bytes);
    set('DinoID1', dinoId[0]);
    set('DinoID2', dinoId[1]);
    set('UploadTime', uploadTime);
    if (d.name !== undefined) set('DinoName', listingName(text(src.entry, 'DinoName')));
    if (d.blueprint) {
      set('DinoClassName', `Blueprint'${blueprint}'`);
      set('DinoClass', { path: `BlueprintGeneratedClass ${blueprint}_C` });
    }
  } else {
    entry = tributeDinoEntry({
      blueprint, data: bytes, name: listingName(null), nameInMap: a.creature.names[0] ?? `${info.cls}_0`,
      stats: dinoStatTexts(a, src.world?.maxStatus?.values), experience: info.experience ?? 0, dinoId, uploadTime,
    });
  }

  let arr = findProperty(data, 'ArkTamedDinosData');
  if (!arr) {
    // The game writes ArkItems, ArkTamedDinosData, ArkPlayerData in this order.
    arr = { name: 'ArkTamedDinosData', type: 'ArrayProperty', index: 0, inner: 'StructProperty', value: [] };
    const items = data.findIndex((x) => x.name === 'ArkItems');
    data.splice(items + 1, 0, arr);
  }
  if (arr.opaque || arr.elementStruct || !Array.isArray(arr.value)) throw new RangeError('ArkTamedDinosData is not an array of structs');
  const list = arr.value as Property[][];
  list.push(entry);
  return {
    tree,
    added: {
      index: list.length - 1, dinoId, sourceId, blueprint, name: text(entry, 'DinoName') ?? '', uploadTime, dinos: list.length,
    },
  };
}

// ---------------------------------------------------------------- copying items

export interface CopyItem {
  /** OwnerPlayerDataID. Default: the PlayerDataID of the target file (see defaultOwner). */
  owner?: bigint | number | string;
  /** Replaces SteamIDs (17 digits, 7656119...) in CustomDataStrings, e.g. the owner of a Dino Storage soul. */
  steamId?: string;
  uploadTime?: number;
  /** ExpirationTimeUTC = uploadTime + expiresIn. Default 86400. */
  expiresIn?: number;
  expiration?: number;
  /** Keep the DinoIDs of creatures inside. Default: new random IDs. */
  keepIds?: boolean;
  /**
   * bAllowRemovalFromInventory of the copy. Default true: ARK refused to download items with false
   * (see NewItem.allowRemoval). null keeps the value of the source.
   */
  allowRemoval?: boolean | null;
}

export interface CopiedItem {
  index: number;
  itemId: [number, number];
  uploadTime: number;
  expiration: number;
  owner: string;
  /** bAllowRemovalFromInventory of the source and of the copy (null: not in the item). */
  allowRemovalBefore: boolean | null;
  allowRemoval: boolean | null;
  creatures: { from: [number, number]; to: [number, number] }[];
}

const STEAM_ID = /^7656119\d{10}$/;

/** Neighbours of bAllowRemovalFromInventory in the order the game writes ItemNetInfo, nearest first. */
const REMOVAL_AFTER = ['bIsRepairing', 'bIsFoodRecipe', 'bIsCustomRecipe', 'bIsEngram', 'bIsBlueprint', 'SteamUserItemID', 'ItemQuantity'];

/** Sets bAllowRemovalFromInventory, adding it after its usual neighbours if missing. Returns the old value. */
function setAllowRemoval(info: Property[], value: boolean): boolean | null {
  const p = findProperty(info, 'bAllowRemovalFromInventory');
  if (p) {
    const before = typeof p.value === 'boolean' ? p.value : null;
    p.value = value;
    return before;
  }
  const after = REMOVAL_AFTER.map((n) => info.findIndex((x) => x.name === n)).find((i) => i >= 0);
  info.splice(after === undefined ? info.length : after + 1, 0, { name: 'bAllowRemovalFromInventory', type: 'BoolProperty', index: 0, value });
  return null;
}

/**
 * Appends a copy of an ArkItems entry from another file with a new ItemID, upload time, expiry and
 * owner. Creatures inside (cryopods, souls) get new DinoIDs; Dino Storage keeps the DinoIDs as text
 * ("id1 id2") in CustomDataStrings as well, those are replaced too. The tree passed in is changed.
 */
export function copyItem(
  c: TreeContainer | null, source: Property[], o: CopyItem = {},
  opts: { now?: number; randomId?: () => [number, number]; randomDinoId?: () => [number, number] } = {},
): { tree: TreeContainer; added: CopiedItem } {
  const tree = c ?? createClusterTree();
  const data = clusterData(tree);
  const entry = source.map(cloneProperty);
  const info = findProperty(entry, 'ArkTributeItem')?.value;
  if (!Array.isArray(info)) throw new RangeError('not an ArkItems entry (no ArkTributeItem)');
  const list = info as Property[];
  const id = findProperty(list, 'ItemId')?.value;
  if (!Array.isArray(id)) throw new RangeError('item without ItemId');

  const taken = itemIds(c);
  const itemId = pickId(taken, opts.randomId ?? randomItemId);
  setNumber(id as Property[], 'ItemID1', itemId[0]);
  setNumber(id as Property[], 'ItemID2', itemId[1]);

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const uploadTime = o.uploadTime ?? now;
  const expiration = o.expiration ?? uploadTime + (o.expiresIn ?? DEFAULT_EXPIRES_IN);
  checkU32(expiration, 'expiration');
  if (findProperty(entry, 'UploadTime')) setNumber(entry, 'UploadTime', uploadTime);
  if (findProperty(list, 'ExpirationTimeUTC')) setNumber(list, 'ExpirationTimeUTC', expiration);
  const owner = o.owner === undefined ? defaultOwner(c) : BigInt(o.owner);
  if (findProperty(list, 'OwnerPlayerDataID')) findProperty(list, 'OwnerPlayerDataID')!.value = owner;
  if (o.steamId !== undefined && !STEAM_ID.test(o.steamId)) throw new RangeError(`not a SteamID64: ${o.steamId}`);
  const flag = findProperty(list, 'bAllowRemovalFromInventory')?.value;
  let allowRemovalBefore = typeof flag === 'boolean' ? flag : null;
  let allowRemoval = allowRemovalBefore;
  if (o.allowRemoval !== null) {
    allowRemoval = o.allowRemoval ?? true;
    allowRemovalBefore = setAllowRemoval(list, allowRemoval);
  }

  const creatures: CopiedItem['creatures'] = [];
  const datas = findProperty(list, 'CustomItemDatas')?.value;
  for (const d of Array.isArray(datas) ? (datas as Property[][]) : []) {
    const strings = findProperty(d, 'CustomDataStrings');
    const bytes = findProperty(d, 'CustomDataBytes')?.value;
    const arrays = Array.isArray(bytes) ? findProperty(bytes as Property[], 'ByteArrays')?.value : undefined;
    for (const ba of Array.isArray(arrays) ? (arrays as Property[][]) : []) {
      const b = findProperty(ba, 'Bytes');
      const a = b && Buffer.isBuffer(b.value) ? readCreatureArchive(b.value) : null;
      if (!a || o.keepIds) continue;
      if (!writeContainerTree(a.tree).equals(b!.value as Buffer)) throw new RangeError('a creature inside does not round-trip; refusing to copy it');
      const from = creatureId(a);
      const to = pickId(new Set([`${from[0]}:${from[1]}`]), opts.randomDinoId ?? randomDinoId);
      setNumber(a.creature.props, 'DinoID1', to[0]);
      setNumber(a.creature.props, 'DinoID2', to[1]);
      b!.value = writeContainerTree(a.tree);
      if (strings && Array.isArray(strings.value)) {
        strings.value = (strings.value as (string | null)[]).map((s) => (s === `${from[0]} ${from[1]}` ? `${to[0]} ${to[1]}` : s));
      }
      creatures.push({ from, to });
    }
    if (o.steamId && strings && Array.isArray(strings.value)) {
      strings.value = (strings.value as (string | null)[]).map((s) => (s && STEAM_ID.test(s) ? o.steamId! : s));
    }
  }

  let arr = findProperty(data, 'ArkItems');
  if (!arr) {
    arr = { name: 'ArkItems', type: 'ArrayProperty', index: 0, inner: 'StructProperty', value: [] };
    data.unshift(arr);
  }
  if (arr.opaque || arr.elementStruct || !Array.isArray(arr.value)) throw new RangeError('ArkItems is not an array of structs');
  const items = arr.value as Property[][];
  items.push(entry);
  return {
    tree,
    added: { index: items.length - 1, itemId, uploadTime, expiration, owner: owner.toString(), allowRemovalBefore, allowRemoval, creatures },
  };
}
