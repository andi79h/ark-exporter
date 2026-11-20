// Full class paths for short class names. A .ark stores the class of every object only as a short
// name ("TekStrider_Character_BP_C"); a cluster upload needs the full path
// ("/Game/Genesis2/Dinos/TekStrider/TekStrider_Character_BP.TekStrider_Character_BP").
//
// Two places hold such paths besides other creatures of the same class: the name table of the save
// (class paths of cryopods, vivarium lists, mod data) and the game files. Short names are not unique:
// mods ship copies of core assets under the same name, so a lookup with more than one answer is
// reported as ambiguous, never decided.
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

/** "Rex_Character_BP_C" -> "Rex_Character_BP": the asset name of a blueprint class. */
export const assetName = (cls: string): string => (cls.endsWith('_C') ? cls.slice(0, -2) : cls);

const PATH = /^(?:\w+'|BlueprintGeneratedClass )?(\/Game\/[\w\-/]+)\.(\w+?)(?:_C)?'?$/;

/**
 * Blueprint paths ("/Game/.../X.X") in a name table, by asset name. Entries count when they contain
 * a slash and end in ".X" or ".X_C" where X is the last part of the package path.
 */
export function classPathsInNames(names: Iterable<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const n of names) {
    if (!n.includes('/') || !n.includes('.')) continue;
    const m = PATH.exec(n);
    if (!m) continue;
    const [, pkg, obj] = m;
    if (pkg.slice(pkg.lastIndexOf('/') + 1) !== obj) continue;
    (out.get(obj) ?? out.set(obj, new Set()).get(obj)!).add(`${pkg}.${obj}`);
  }
  return out;
}

export interface InstallMatch {
  /** Blueprint path of each file that could be read. */
  paths: string[];
  /** The .uasset files found for the name. */
  files: string[];
  /** Files under Content/Mods whose package path is not in the file. */
  unreadable: string[];
}

/**
 * Index of the .uasset files of a game or server installation (ShooterGame/Content). Core assets
 * have the package path of their place under Content ("/Game/<path>"). Mods live under
 * Content/Mods/<id>/, but their packages keep the path they were made with
 * ("/Game/Mods/DinoStorage2/..."); that path is read from the file's own name map.
 */
export class InstallDir {
  readonly content: string;
  private index: Map<string, string[]> | null = null;
  private readonly cache = new Map<string, InstallMatch>();

  /** dir: the installation (holding ShooterGame/) or its Content folder. */
  constructor(dir: string) {
    const content = [join(dir, 'ShooterGame', 'Content'), join(dir, 'Content'), dir]
      .find((d) => basename(d) === 'Content' && existsSync(d) && statSync(d).isDirectory());
    if (!content) throw new Error(`${dir}: no ShooterGame/Content folder`);
    this.content = content;
  }

  /** Follows symbolic links (server instances often link to a shared installation), each folder once. */
  private build(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    const seen = new Set<string>();
    const walk = (dir: string): void => {
      const real = realpathSync(dir);
      if (seen.has(real)) return;
      seen.add(real);
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        const isDir = e.isDirectory() || (e.isSymbolicLink() && existsSync(p) && statSync(p).isDirectory());
        if (isDir) walk(p);
        else if (e.name.endsWith('.uasset')) {
          const name = e.name.slice(0, -'.uasset'.length);
          (index.get(name) ?? index.set(name, []).get(name)!).push(p);
        }
      }
    };
    walk(this.content);
    return index;
  }

  /** Blueprint paths for a class ("Rex_Character_BP_C" or "Rex_Character_BP"). */
  lookup(cls: string): InstallMatch {
    const name = assetName(cls);
    const cached = this.cache.get(name);
    if (cached) return cached;
    this.index ??= this.build();
    const files = (this.index.get(name) ?? []).slice().sort();
    const paths = new Set<string>();
    const unreadable: string[] = [];
    for (const f of files) {
      const pkg = this.packageOf(f);
      if (pkg) paths.add(`${pkg}.${name}`);
      else unreadable.push(f);
    }
    const match = { paths: [...paths], files, unreadable };
    this.cache.set(name, match);
    return match;
  }

  /** Package path of a .uasset: from its place for core assets, from its name map for mods. */
  packageOf(file: string): string | null {
    const rel = relative(this.content, file).split(sep).join('/').replace(/\.uasset$/, '');
    const mod = /^Mods\/[^/]+\/(.+)$/.exec(rel);
    if (!mod) return `/Game/${rel}`;
    // The name map holds the package's own path; it ends with the path inside the mod folder.
    const text = readHead(file).toString('latin1');
    const want = `/${mod[1]}`;
    // Unreal keeps a trailing "_<number>" apart from the string: "X_2" is stored as "X" plus instance 3.
    const numbered = /^(.*)(_(?:0|[1-9]\d{0,9}))$/.exec(want);
    const depth = want.split('/').length + 3; // "/Game/Mods/<root>" + the path inside the mod folder
    const found = new Set<string>();
    for (const [s] of text.matchAll(/\/Game\/Mods\/[\w\-]+\/[\w\-/]+/g)) {
      if (s.split('/').length !== depth) continue;
      if (s.endsWith(want)) found.add(s);
      else if (numbered && s.endsWith(numbered[1])) found.add(s + numbered[2]);
    }
    return found.size === 1 ? [...found][0] : null;
  }
}

/** The name map sits in the header; 4 MB is far more than any blueprint's header. */
function readHead(file: string, max = 4 << 20): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(max, statSync(file).size));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}
