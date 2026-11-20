// `ark-export cluster ...`: read, check and extend ASE cluster files (see cluster.ts).
import { createHash } from 'node:crypto';
import { chownSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { InstallDir } from './class-paths.ts';
import { addItem, clusterEntries, type NewItem, readCluster, readClusterTree, writeClusterTree } from './cluster.ts';
import { addDino, copyItem, creaturesInCluster, creaturesInSave, type CreatureSource } from './cluster-dinos.ts';
import { readContainerTree, type TreeNotes, writeContainerTree } from './tree.ts';

export const CLUSTER_USAGE = `Cluster files (clusters/<ClusterId>/<SteamID>):
  ark-export cluster show <file> [--full]           items, creatures and characters as JSON
  ark-export cluster check <file | dir>...          read and write back every file, report differences (reads only)
  ark-export cluster add-item <file> --blueprint BP (--out FILE | --in-place --backup DIR) [options]
                                                     append an item; writes a new file or replaces the file atomically
  ark-export cluster dinos <file>... [--install-dir DIR] [--level PATH]
                                                     creatures that add-dino can copy: uploads, souls and cryopods in
                                                     cluster files; souls, cryopods, vivariums and tamed creatures
                                                     in the world of savegames (.ark)
  ark-export cluster add-dino <file> --from FILE (--pick N | --source-id A:B) (--out FILE | --in-place --backup DIR) [options]
                                                     add a creature to the uploads (new DinoIDs, upload time now)
  ark-export cluster copy-item <file> --from FILE --index N (--out FILE | --in-place --backup DIR) [options]
                                                     copy an uploaded item (e.g. a filled soul) with new ItemID and owner

add-item options:
  --blueprint BP        item class: Blueprint'/Game/.../X.X', /Game/.../X.X_C or /Game/.../X
  --stats A,B,...       ItemStatValues 0..7 (0-65535): quality, armor, durability, damage, ammo,
                        hypothermal, weight, hyperthermal
  --quality N           ItemQualityIndex 0-5 (primitive ... ascendant), default 0
  --rating R            ItemRating, default 0
  --durability D        ItemDurability (current durability), default 0
  --quantity N          number of pieces, default 1 (written as ItemQuantity N-1, as the game does)
  --colors A,B,...      ItemColorID 0..5
  --blueprint-copy      upload as blueprint
  --custom-name S, --custom-description S, --crafter S, --tribe S, --ammo N
  --owner ID            OwnerPlayerDataID, default: the player's PlayerDataID from the file
  --upload-time T       unix seconds, default now
  --expires-in S        seconds after the upload time, default 86400
  --expires-at T        absolute expiry: unix seconds or ISO date (wins over --expires-in)
  --item-id A:B         ItemID1:ItemID2, default random and unique within the file
  --out FILE            write the result to FILE (--force overwrites it)
  --in-place            replace <file>; needs --backup DIR for a copy of the original

dinos and add-dino options:
  --install-dir DIR     game or server installation (holding ShooterGame/): class paths that the save
                        does not hold are looked up in ShooterGame/Content (one match only)
  --level PATH          map package for creatures from the world, e.g. /Game/Maps/TheIslandSubMaps/TheIsland;
                        default: from souls and cryopods of the same map in the save

add-dino options:
  --from FILE           cluster file or savegame (.ark) holding the creature
  --pick N              number from \`cluster dinos FILE\`
  --source-id A:B       DinoID1:DinoID2 of the creature in FILE
  --name S              new name (TamedName and the upload list)
  --keep-id             keep the DinoIDs (only if the original no longer exists); default: new random IDs
  --dino-id A:B         use these DinoIDs
  --blueprint BP        class path when the source has none: Blueprint'/Game/.../X.X' or /Game/.../X.X
  --species S           species shown in the upload list
  --upload-time T       unix seconds or ISO date, default now

copy-item options:
  --from FILE           cluster file holding the item
  --index N             position in its ArkItems (see \`cluster show FILE\`)
  --owner ID            OwnerPlayerDataID, default: the player's PlayerDataID from <file>
  --steam-id ID         replace SteamIDs in the item's texts (owner of a Dino Storage soul),
                        default: the name of <file> if it is a SteamID
  --keep-ids            keep the DinoIDs of creatures inside; default: new random IDs
  --upload-time T, --expires-in S, --expires-at T   as for add-item
`;

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const iso = (t: unknown): string | null => (typeof t === 'number' && t > 0 ? new Date(t * 1000).toISOString() : null);
const print = (v: unknown): void => {
  process.stdout.write(`${JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)}\n`);
};

function show(file: string, full: boolean): void {
  const buf = readFileSync(file);
  const v = readCluster(buf);
  const now = Date.now() / 1000;
  print({
    file, bytes: buf.length, hasData: v.hasData, objectName: v.objectName, notes: v.notes,
    items: v.items.map((it) => {
      const times = { uploaded: iso(it.uploadTime), expires: iso(it.expiration), expired: typeof it.expiration === 'number' && it.expiration < now };
      if (full) return { ...it, ...times };
      const { info: _info, ...rest } = it;
      return { ...rest, ...times };
    }),
    dinos: v.dinos.map((d) => (full ? d : {
      index: d.index, className: d.className, name: d.name, dinoId: d.dinoId, uploaded: iso(d.uploadTime),
      objects: d.objects?.map((o) => o.cls) ?? null,
    })),
    characters: v.characters.map((c) => (full ? c : {
      index: c.index, playerDataId: c.playerDataId, name: c.name, map: c.map, server: c.server, uploaded: iso(c.uploadTime),
      objects: c.objects?.map((o) => o.cls) ?? null,
    })),
    other: v.other,
  });
}

function filesOf(targets: string[]): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const path = resolve(t);
    if (statSync(path).isDirectory()) {
      for (const f of readdirSync(path).sort()) {
        if (statSync(join(path, f)).isFile()) out.push(join(path, f));
      }
    } else {
      out.push(path);
    }
  }
  return out;
}

/** Round trip of every file and of the embedded archives (creatures, characters) inside. Reads only. */
function check(targets: string[]): number {
  const t0 = performance.now();
  const files = filesOf(targets);
  const notes: TreeNotes = new Map();
  const r = {
    files: files.length, empty: 0, identical: 0, different: [] as string[], failed: [] as { file: string; error: string }[],
    items: 0, dinos: 0, characters: 0, bytes: 0,
    embedded: { total: 0, identical: 0, different: [] as string[], notDecoded: 0 },
    notes: {} as Record<string, number>, seconds: 0,
  };
  for (const file of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(file);
      r.bytes += buf.length;
      if (buf.length === 0) { r.empty++; continue; }
      const tree = readClusterTree(buf, notes);
      if (writeClusterTree(tree).equals(buf)) r.identical++;
      else r.different.push(file);
      r.items += clusterEntries(tree, 'ArkItems').length;
      for (const [array, field] of [['ArkTamedDinosData', 'DinoData'], ['ArkPlayerData', 'PlayerDataBytes']] as const) {
        const entries = clusterEntries(tree, array);
        if (array === 'ArkTamedDinosData') r.dinos += entries.length;
        else r.characters += entries.length;
        for (const e of entries) {
          const bytes = e.find((p) => p.name === field)?.value;
          if (!Buffer.isBuffer(bytes)) continue;
          r.embedded.total++;
          try {
            if (writeContainerTree(readContainerTree(bytes, { version: false, notes })).equals(bytes)) r.embedded.identical++;
            else r.embedded.different.push(`${file} ${array}`);
          } catch {
            r.embedded.notDecoded++;
          }
        }
      }
    } catch (e) {
      r.failed.push({ file, error: (e as Error).message });
    }
  }
  r.notes = Object.fromEntries(notes);
  r.seconds = +((performance.now() - t0) / 1000).toFixed(2);
  print(r);
  return r.different.length || r.failed.length || r.embedded.different.length ? 1 : 0;
}

function numbers(s: string | undefined, what: string): number[] | undefined {
  if (s === undefined) return undefined;
  return s.split(',').map((x, i) => {
    const v = x.trim() === '' ? 0 : Number(x);
    if (!Number.isFinite(v)) throw new Error(`${what} ${i}: ${x} is not a number`);
    return v;
  });
}

function number(s: string | undefined, what: string): number | undefined {
  if (s === undefined) return undefined;
  const v = Number(s);
  if (s.trim() === '' || !Number.isFinite(v)) throw new Error(`--${what}: ${s} is not a number`);
  return v;
}

function unixTime(s: string | undefined, what: string): number | undefined {
  if (s === undefined) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`--${what}: ${s} is neither unix seconds nor a date`);
  return Math.floor(t / 1000);
}

/** Writes next to the target, flushes, then renames: readers see the old or the new file, never a part. */
function writeAtomic(target: string, data: Buffer, like: { mode: number; uid: number; gid: number } | null, beforeRename?: () => void): void {
  const tmp = join(dirname(target), `.${basename(target)}.ark-export-${process.pid}.tmp`);
  const fd = openSync(tmp, 'wx', like ? like.mode & 0o777 : 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (like) {
      const st = statSync(tmp);
      if (st.uid !== like.uid || st.gid !== like.gid) chownSync(tmp, like.uid, like.gid);
    }
    beforeRename?.();
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Replaces target with data, keeping mode and owner, after saving `expected` (the bytes the change is
 * based on) to backupDir. Throws without touching target when its content is no longer `expected`
 * (the game server wrote it in the meantime). Returns the path of the backup.
 */
export function replaceFile(target: string, expected: Buffer, data: Buffer, backupDir: string): string {
  const stat = statSync(target);
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `${basename(target)}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
  writeAtomic(backup, expected, null);
  writeAtomic(target, data, { mode: stat.mode, uid: stat.uid, gid: stat.gid }, () => {
    if (!readFileSync(target).equals(expected)) throw new Error(`${target} changed while editing; nothing written (backup kept)`);
  });
  return backup;
}

interface Output { out?: string; 'in-place'?: boolean; backup?: string; force?: boolean }

const OUTPUT_OPTIONS = {
  out: { type: 'string' }, 'in-place': { type: 'boolean', default: false }, backup: { type: 'string' }, force: { type: 'boolean', default: false },
} as const;

function checkOutput(values: Output): void {
  if (!!values.out === !!values['in-place']) throw new Error('give either --out FILE or --in-place');
  if (values['in-place'] && !values.backup) throw new Error('--in-place needs --backup DIR');
}

/** Writes `after` to --out or replaces src (--in-place, after a backup); returns where it went. */
function commit(src: string, before: Buffer, after: Buffer, values: Output): { target: string; backup: string | null } {
  if (values['in-place']) return { target: src, backup: replaceFile(src, before, after, resolve(values.backup!)) };
  const target = resolve(values.out!);
  if (target === src) throw new Error('--out is the input file; use --in-place --backup DIR');
  if (existsSync(target) && !values.force) throw new Error(`${target} exists (--force overwrites it)`);
  writeAtomic(target, after, null);
  return { target, backup: null };
}

/** The target file read strictly; missing files count as empty (players without uploads). */
function readTarget(src: string, inPlace: boolean): Buffer {
  if (!existsSync(src)) {
    if (inPlace) throw new Error(`${src} does not exist; --in-place only replaces existing files`);
    return Buffer.alloc(0);
  }
  const before = readFileSync(src);
  if (!writeClusterTree(readClusterTree(before)).equals(before)) throw new Error(`${src}: writing it back would change it; refusing to edit`);
  return before;
}

const pair = (s: string, what: string): [number, number] => {
  const ids = s.split(/[:,]/).map(Number);
  if (ids.length !== 2 || ids.some((x) => !Number.isInteger(x) || x < 0)) throw new Error(`${what} must be A:B`);
  return [ids[0], ids[1]];
};

const isSave = (file: string, buf: Buffer): boolean => file.endsWith('.ark') || (buf.length > 2 && buf.readInt16LE(0) >= 5 && buf.readInt16LE(0) <= 11 && buf.readInt32LE(0) !== 4);

interface SourceOptions { installDir?: InstallDir; level?: string; }

function creaturesIn(file: string, o: SourceOptions = {}, warnings: string[] = []): CreatureSource[] {
  const buf = readFileSync(file);
  return isSave(file, buf)
    ? creaturesInSave(buf, { installDir: o.installDir, level: o.level, warnings })
    : creaturesInCluster(readClusterTree(buf), { installDir: o.installDir });
}

const SOURCE_OPTIONS = { 'install-dir': { type: 'string' }, level: { type: 'string' } } as const;
const sourceOptions = (v: { 'install-dir'?: string; level?: string }): SourceOptions => ({
  installDir: v['install-dir'] === undefined ? undefined : new InstallDir(resolve(v['install-dir'])), level: v.level,
});

function dinosCommand(args: string[]): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: SOURCE_OPTIONS });
  if (!positionals.length) throw new Error('dinos needs files');
  const opts = sourceOptions(values);
  const out = positionals.map((f) => {
    const file = resolve(f);
    const warnings: string[] = [];
    const creatures = creaturesIn(file, opts, warnings).map((s, pick) => ({
      pick, where: s.where, kind: s.kind, ...s.info, blueprint: s.blueprint, blueprintFrom: s.blueprintFrom ?? null,
      ...(s.blueprintCandidates ? { blueprintCandidates: s.blueprintCandidates } : {}),
      species: s.species, bytes: s.data.length,
      ...(s.world ? {
        location: s.world.location, tribeName: s.world.tribeName, droppedRefs: s.world.droppedRefs,
        removedProps: s.world.removedProps, removedObjects: s.world.removedObjects, level: s.world.level?.[2] ?? null,
      } : {}),
      ...(s.problem ? { problem: s.problem } : {}),
    }));
    return { file, creatures, warnings };
  });
  print(positionals.length === 1 ? out[0] : out);
  return 0;
}

function addDinoCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      from: { type: 'string' }, pick: { type: 'string' }, 'source-id': { type: 'string' }, name: { type: 'string' },
      'keep-id': { type: 'boolean', default: false }, 'dino-id': { type: 'string' }, blueprint: { type: 'string' },
      species: { type: 'string' }, 'upload-time': { type: 'string' }, ...SOURCE_OPTIONS, ...OUTPUT_OPTIONS,
    },
  });
  if (positionals.length !== 1) throw new Error('add-dino needs exactly one cluster file');
  if (!values.from) throw new Error('--from is required');
  if ((values.pick === undefined) === (values['source-id'] === undefined)) throw new Error('give either --pick N or --source-id A:B');
  checkOutput(values);
  const src = resolve(positionals[0]);
  const sources = creaturesIn(resolve(values.from), sourceOptions(values));
  let source: CreatureSource | undefined;
  if (values.pick !== undefined) {
    source = sources[number(values.pick, 'pick')!];
    if (!source) throw new Error(`--pick ${values.pick}: ${values.from} has ${sources.length} creatures (see cluster dinos)`);
  } else {
    const id = pair(values['source-id']!, '--source-id').join(':');
    const found = sources.filter((s) => s.info.dinoId.join(':') === id);
    if (found.length !== 1) throw new Error(`--source-id ${id}: ${found.length} creatures with this id in ${values.from}; use --pick`);
    source = found[0];
  }

  const before = readTarget(src, values['in-place']);
  const tree = readClusterTree(before);
  const dinosBefore = clusterEntries(tree, 'ArkTamedDinosData').length;
  const { tree: changed, added } = addDino(tree, source, {
    name: values.name, blueprint: values.blueprint, species: values.species, keepId: values['keep-id'],
    dinoId: values['dino-id'] === undefined ? undefined : pair(values['dino-id'], '--dino-id'),
    uploadTime: unixTime(values['upload-time'], 'upload-time'),
  });
  const after = writeClusterTree(changed);
  const check = readCluster(after);
  const last = check.dinos.at(-1);
  if (check.dinos.length !== dinosBefore + 1 || !last || (last.dinoId as number[]).join(':') !== added.dinoId.join(':') || !last.objects) {
    throw new Error('the written file does not read back as expected');
  }
  if (!writeClusterTree(readClusterTree(after)).equals(after)) throw new Error('the written file does not round-trip');
  const { target, backup } = commit(src, before, after, values);
  const warnings = added.dinos > 20 ? [`${added.dinos} uploaded creatures in the file; MaxTributeDinos is 20 unless raised`] : [];
  print({
    file: target, backup,
    source: {
      file: resolve(values.from), where: source.where, kind: source.kind, dinoId: source.info.dinoId,
      blueprintFrom: values.blueprint ? 'option' : source.blueprintFrom ?? null,
      ...(source.world ? { droppedRefs: source.world.droppedRefs, removedProps: source.world.removedProps } : {}),
    },
    before: { bytes: before.length, sha256: sha256(before), dinos: dinosBefore },
    after: { bytes: after.length, sha256: sha256(after), dinos: check.dinos.length },
    added: { ...added, uploaded: iso(added.uploadTime) }, warnings,
  });
  return 0;
}

function copyItemCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      from: { type: 'string' }, index: { type: 'string' }, owner: { type: 'string' }, 'steam-id': { type: 'string' },
      'keep-ids': { type: 'boolean', default: false }, 'upload-time': { type: 'string' }, 'expires-in': { type: 'string' },
      'expires-at': { type: 'string' }, ...OUTPUT_OPTIONS,
    },
  });
  if (positionals.length !== 1) throw new Error('copy-item needs exactly one cluster file');
  if (!values.from || values.index === undefined) throw new Error('--from and --index are required');
  checkOutput(values);
  const src = resolve(positionals[0]);
  const from = resolve(values.from);
  const entries = clusterEntries(readClusterTree(readFileSync(from)), 'ArkItems');
  const entry = entries[number(values.index, 'index')!];
  if (!entry) throw new Error(`--index ${values.index}: ${from} has ${entries.length} items`);
  const steamId = values['steam-id'] ?? (/^7656119\d{10}$/.test(basename(src)) ? basename(src) : undefined);

  const before = readTarget(src, values['in-place']);
  const tree = readClusterTree(before);
  const itemsBefore = clusterEntries(tree, 'ArkItems').length;
  const { tree: changed, added } = copyItem(tree, entry, {
    owner: values.owner, steamId, keepIds: values['keep-ids'], uploadTime: unixTime(values['upload-time'], 'upload-time'),
    expiresIn: number(values['expires-in'], 'expires-in'), expiration: unixTime(values['expires-at'], 'expires-at'),
  });
  const after = writeClusterTree(changed);
  const check = readCluster(after);
  const last = check.items.at(-1);
  if (check.items.length !== itemsBefore + 1 || !last || last.itemId.join(':') !== added.itemId.join(':')) {
    throw new Error('the written file does not read back as expected');
  }
  if (!writeClusterTree(readClusterTree(after)).equals(after)) throw new Error('the written file does not round-trip');
  const { target, backup } = commit(src, before, after, values);
  print({
    file: target, backup, source: { file: from, index: Number(values.index), blueprint: readCluster(readFileSync(from)).items[Number(values.index)].blueprint },
    before: { bytes: before.length, sha256: sha256(before), items: itemsBefore },
    after: { bytes: after.length, sha256: sha256(after), items: check.items.length },
    added: { ...added, steamId: steamId ?? null, uploaded: iso(added.uploadTime), expires: iso(added.expiration) },
  });
  return 0;
}

function addItemCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      blueprint: { type: 'string' }, stats: { type: 'string' }, quality: { type: 'string' }, rating: { type: 'string' },
      durability: { type: 'string' }, quantity: { type: 'string' }, colors: { type: 'string' },
      'blueprint-copy': { type: 'boolean', default: false }, 'custom-name': { type: 'string' },
      'custom-description': { type: 'string' }, crafter: { type: 'string' }, tribe: { type: 'string' }, ammo: { type: 'string' },
      owner: { type: 'string' }, 'upload-time': { type: 'string' }, 'expires-in': { type: 'string' },
      'expires-at': { type: 'string' }, 'item-id': { type: 'string' }, ...OUTPUT_OPTIONS,
    },
  });
  if (positionals.length !== 1) throw new Error('add-item needs exactly one cluster file');
  if (!values.blueprint) throw new Error('--blueprint is required');
  checkOutput(values);
  const src = resolve(positionals[0]);
  let itemId: [number, number] | undefined;
  if (values['item-id'] !== undefined) {
    const ids = values['item-id'].split(/[:,]/).map(Number);
    if (ids.length !== 2) throw new Error('--item-id must be ID1:ID2');
    itemId = [ids[0], ids[1]];
  }
  const item: NewItem = {
    blueprint: values.blueprint,
    stats: numbers(values.stats, 'stat'),
    colors: numbers(values.colors, 'color'),
    quality: number(values.quality, 'quality'),
    rating: number(values.rating, 'rating'),
    durability: number(values.durability, 'durability'),
    quantity: number(values.quantity, 'quantity'),
    ammo: number(values.ammo, 'ammo'),
    isBlueprint: values['blueprint-copy'],
    customName: values['custom-name'],
    customDescription: values['custom-description'],
    crafterName: values.crafter,
    crafterTribe: values.tribe,
    owner: values.owner,
    uploadTime: unixTime(values['upload-time'], 'upload-time'),
    expiresIn: number(values['expires-in'], 'expires-in'),
    expiration: unixTime(values['expires-at'], 'expires-at'),
    itemId,
  };

  const before = readTarget(src, values['in-place']);
  const tree = readClusterTree(before);
  const itemsBefore = clusterEntries(tree, 'ArkItems').length;
  const { tree: changed, added } = addItem(tree, item);
  const after = writeClusterTree(changed);

  // The result has to read back with the new item last and everything else unchanged.
  const check = readCluster(after);
  const last = check.items.at(-1);
  if (check.items.length !== itemsBefore + 1 || !last || last.itemId.join(':') !== added.itemId.join(':')) {
    throw new Error('the written file does not read back as expected');
  }
  if (!writeClusterTree(readClusterTree(after)).equals(after)) throw new Error('the written file does not round-trip');

  const { target, backup } = commit(src, before, after, values);
  print({
    file: target, backup,
    before: { bytes: before.length, sha256: sha256(before), items: itemsBefore },
    after: { bytes: after.length, sha256: sha256(after), items: check.items.length },
    added: { ...added, uploaded: iso(added.uploadTime), expires: iso(added.expiration) },
  });
  return 0;
}

export async function clusterCommand(argv: string[]): Promise<number> {
  const [sub, ...args] = argv;
  switch (sub) {
    case 'show': {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { full: { type: 'boolean', default: false } } });
      if (positionals.length !== 1) throw new Error('show needs exactly one cluster file');
      show(resolve(positionals[0]), values.full);
      return 0;
    }
    case 'check':
      if (!args.length) throw new Error('check needs files or directories');
      return check(args);
    case 'add-item':
      return addItemCommand(args);
    case 'dinos':
      return dinosCommand(args);
    case 'add-dino':
      return addDinoCommand(args);
    case 'copy-item':
      return copyItemCommand(args);
    default:
      process.stdout.write(CLUSTER_USAGE);
      return sub && sub !== 'help' ? 2 : 0;
  }
}
