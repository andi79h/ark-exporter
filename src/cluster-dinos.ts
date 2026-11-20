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
// recolorDino sets the colour regions of an uploaded creature in place (colors.ts).
import { randomInt } from 'node:crypto';
import {
  clusterData, clusterEntries, createClusterTree, DEFAULT_EXPIRES_IN, defaultOwner, itemIds, randomItemId,
} from './cluster.ts';
import { colorName, isKnownColor, REGIONS, storedColorSetName } from './colors.ts';
import { readSave } from './savegame.ts';
import {
  cloneProperty, findProperty, type Property, readContainerTree, type TreeContainer, type TreeObject, writeContainerTree,
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
  /** ColorSetIndices 0..5, 0 = region unused (see colors.ts). */
  colors: number[];
}

/** ColorSetIndices 0..5 of a creature; regions without the property are 0. */
export function creatureColors(a: CreatureArchive): number[] {
  return Array.from({ length: REGIONS }, (_, i) => num(a.creature.props, 'ColorSetIndices', i) ?? 0);
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
    colors: creatureColors(a),
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
  /** soul = Dino Storage soul, recovery = Dino Storage admin recovery list, vivarium = S+ vivarium. */
  kind: 'upload' | 'soul' | 'recovery' | 'cryopod' | 'vivarium' | 'item';
  data: Buffer;
  /** The ArkTamedDinosData entry the creature came from; its fields are copied by addDino. */
  entry?: Property[];
  /** Blueprint path "/Game/.../X.X" if known. */
  blueprint: string | null;
  /** Display name of the species ("Tek Rex") if known. */
  species: string | null;
  info: CreatureInfo;
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

/** Sources without a class path (vivariums, Ferox forms) get it from another source of the same class. */
function fillBlueprints(list: CreatureSource[]): CreatureSource[] {
  const known = new Map<string, string>();
  for (const s of list) if (s.blueprint) known.set(s.info.cls, s.blueprint);
  for (const s of list) if (!s.blueprint) s.blueprint = known.get(s.info.cls) ?? null;
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
export function creaturesInCluster(c: TreeContainer | null): CreatureSource[] {
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
  return fillBlueprints(out);
}

/**
 * Creatures in cryopods, souls and other items of a savegame (.ark). Creatures that live in the world
 * are stored as objects of the save itself, not as an archive, and are not listed.
 */
export function creaturesInSave(buf: Buffer): CreatureSource[] {
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
  return fillBlueprints(out);
}

// ---------------------------------------------------------------- new upload entries

const STAT_NAMES = [
  'Health', 'Stamina', 'Torpidity', 'Oxygen', 'Food', 'Water', 'Temperature', 'Weight', 'Melee Damage', 'Movement Speed',
  'Fortitude', 'Crafting Skill',
];

/** The 12 texts the upload list shows, in the format of the game ("Health: 2572.1 / 2572.1", "Melee Damage: 172.2 %"). */
export function dinoStatTexts(a: CreatureArchive): string[] {
  const s = a.status?.props;
  return STAT_NAMES.map((name, i) => {
    const cur = num(s, 'CurrentStatusValues', i) ?? 0;
    const max = num(s, 'MaxStatusValues', i) ?? (i === 2 ? 0 : cur);
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
      stats: dinoStatTexts(a), experience: info.experience ?? 0, dinoId, uploadTime,
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

// ---------------------------------------------------------------- recolouring uploads

export interface Recolor {
  /** Colour ID per region (0..5); regions left out keep their colour. 0 makes a region unused. */
  colors: Record<number, number>;
  /** ColorSetNames: 'game' (default) writes them the way the game does, 'keep' leaves them as they are. */
  names?: 'game' | 'keep';
  /** Allow IDs other than 0, 1..100 and 201..226 (any byte). */
  anyColor?: boolean;
}

export interface Recolored {
  index: number;
  dinoId: [number, number];
  cls: string;
  before: number[];
  after: number[];
  /** Regions whose ColorSetNames entry was rewritten. */
  names: number[];
}

/**
 * Sets the colours of an uploaded creature (ArkTamedDinosData) in its DinoData archive. Only
 * ColorSetIndices (and with names 'game' the matching ColorSetNames) change; DinoIDs, upload time and
 * every other byte stay. The game spawns the creature from this archive on download. The tree passed in
 * is changed.
 */
export function recolorDino(
  c: TreeContainer, which: { index?: number; dinoId?: [number, number] }, r: Recolor,
): { tree: TreeContainer; recolored: Recolored } {
  const entries = clusterEntries(c, 'ArkTamedDinosData');
  let index: number;
  if (which.index !== undefined) {
    if (!entries[which.index]) throw new RangeError(`no uploaded creature at index ${which.index} (${entries.length} in the file)`);
    index = which.index;
  } else if (which.dinoId) {
    const want = which.dinoId.join(':');
    const found = entries.flatMap((e, i) => (`${num(e, 'DinoID1')}:${num(e, 'DinoID2')}` === want ? [i] : []));
    if (found.length !== 1) throw new RangeError(`DinoID ${want}: ${found.length} uploaded creatures with this id`);
    index = found[0];
  } else {
    throw new RangeError('give the index or the DinoID of the uploaded creature');
  }
  const entry = entries[index];
  const dataProp = findProperty(entry, 'DinoData');
  const data = dataProp?.value;
  const a = Buffer.isBuffer(data) ? readCreatureArchive(data) : null;
  if (!dataProp || !a) throw new RangeError(`ArkTamedDinosData[${index}]: no creature in DinoData`);
  if (!writeContainerTree(a.tree).equals(data as Buffer)) throw new RangeError(`ArkTamedDinosData[${index}]: the creature does not round-trip; refusing to change it`);
  const dinoId = creatureId(a);
  if (`${num(entry, 'DinoID1')}:${num(entry, 'DinoID2')}` !== dinoId.join(':')) {
    throw new RangeError(`ArkTamedDinosData[${index}]: DinoID of the entry and of the creature differ`);
  }

  const want = Object.entries(r.colors).map(([k, v]) => [Number(k), v] as const);
  if (!want.length) throw new RangeError('no colours given');
  for (const [region, id] of want) {
    if (!Number.isInteger(region) || region < 0 || region >= REGIONS) throw new RangeError(`region must be 0..${REGIONS - 1}, got ${region}`);
    if (!Number.isInteger(id) || id < 0 || id > 255) throw new RangeError(`region ${region}: colour must be 0..255, got ${id}`);
    if (!r.anyColor && !isKnownColor(id)) throw new RangeError(`region ${region}: ${id} is no ASE colour (0, 1-100, 201-226)`);
  }

  const props = a.creature.props;
  const before = creatureColors(a);
  const names: number[] = [];
  for (const [region, id] of want) {
    const at = props.findIndex((x) => x.name === 'ColorSetIndices' && x.index === region);
    const prop = at < 0 ? undefined : props[at];
    if (prop && (prop.type !== 'ByteProperty' || prop.inner !== 'None' || prop.opaque)) {
      throw new RangeError(`ColorSetIndices[${region}] is a ${prop.type}, expected a plain ByteProperty`);
    }
    if (id === 0) {
      // The game leaves unused regions out of the save.
      if (at >= 0) props.splice(at, 1);
      continue;
    }
    if (prop) {
      prop.value = id;
    } else {
      // Keep the regions in order: after the last lower region, else before the first higher one,
      // else before ColorSetNames, else before the DinoIDs.
      const others = props.flatMap((x, i) => (x.name === 'ColorSetIndices' ? [{ i, region: x.index }] : []));
      const lower = others.filter((o) => o.region < region).at(-1);
      const higher = others.find((o) => o.region > region);
      let pos = lower ? lower.i + 1 : higher ? higher.i : props.findIndex((x) => x.name === 'ColorSetNames');
      if (pos < 0) pos = props.findIndex((x) => x.name === 'DinoID1');
      if (pos < 0) pos = props.length;
      props.splice(pos, 0, { name: 'ColorSetIndices', type: 'ByteProperty', index: region, inner: 'None', value: id });
    }
    if (r.names !== 'keep') {
      const name = findProperty(props, 'ColorSetNames', region);
      if (name && name.type === 'NameProperty' && !name.opaque) {
        name.value = storedColorSetName(id);
        names.push(region);
      }
    }
  }

  const bytes = writeContainerTree(a.tree);
  const check = readCreatureArchive(bytes);
  const after = before.slice();
  for (const [region, id] of want) after[region] = id;
  if (!check || creatureId(check).join(':') !== dinoId.join(':') || creatureColors(check).join(',') !== after.join(',')) {
    throw new Error('the recoloured creature does not read back');
  }
  dataProp.value = bytes;
  return { tree: c, recolored: { index, dinoId, cls: a.creature.cls ?? '', before, after, names } };
}

/** Colours with their names for output: [{ region, id, name }]. */
export const describeColors = (ids: number[]): { region: number; id: number; name: string | null }[] =>
  ids.map((id, region) => ({ region, id, name: colorName(id) }));

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
}

export interface CopiedItem {
  index: number;
  itemId: [number, number];
  uploadTime: number;
  expiration: number;
  owner: string;
  creatures: { from: [number, number]; to: [number, number] }[];
}

const STEAM_ID = /^7656119\d{10}$/;

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
  return { tree, added: { index: items.length - 1, itemId, uploadTime, expiration, owner: owner.toString(), creatures } };
}
