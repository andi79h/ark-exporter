// Configuration of ark-manager: a JSON file. Maps can be listed by hand or read from arkmanager
// instance files (/etc/arkmanager/instances/*.cfg), which already hold port, admin password and server folder.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export type MapRole = 'live' | 'test';

export interface MapConfig {
  name: string;
  title: string;
  host: string;
  rconPort: number;
  password: string;
  /** ShooterGame/Saved/Logs of the server, if it is on this machine. */
  logDir: string | null;
  /** Alternative: a command printing the game log lines (e.g. via ssh). */
  logCommand: string[] | null;
  role: MapRole;
  /** Another program (BattleMetrics) reads GetChat/GetGameLog on this map: never call them. */
  externalBufferReader: boolean;
  /** Where chat/game log come from: the log file (default) or RCON GetGameLog (only if nothing else reads the buffer). */
  logSource: 'file' | 'rcon' | 'none';
  /** arkmanager instance file the map came from; re-read when the RCON password stops working. */
  cfgFile: string | null;
}

export interface DiscordConfig {
  /** name → webhook URL (or "@file" holding it) */
  webhooks: Record<string, string>;
  /** what goes where: event type (chat, join, leave, ban, audit, admin, tame, map) → webhook name */
  routes: Record<string, string>;
}

export interface ManagerConfig {
  database: string;
  maps: MapConfig[];
  pollSeconds: number;
  web: { listen: string; secureCookies: boolean; trustProxy: boolean };
  discord: DiscordConfig;
  scriptCommands?: string[];
  extraVerified?: string[];
  extraDenied?: string[];
  /** Modules (absolute paths) loaded at start: `export default function (manager) {}` */
  hooks: string[];
  /** Keep chat and game log for this many days (0 = forever). */
  retentionDays: number;
}

interface RawMap extends Partial<Omit<MapConfig, 'password'>> {
  password?: string;
  passwordFile?: string;
  passwordEnv?: string;
}

interface RawConfig {
  database?: string;
  arkmanager?: {
    instances?: string;
    include?: string[];
    exclude?: string[];
    host?: string;
    defaults?: Partial<RawMap>;
    overrides?: Record<string, Partial<RawMap>>;
  };
  maps?: RawMap[];
  pollSeconds?: number;
  web?: Partial<ManagerConfig['web']>;
  discord?: Partial<DiscordConfig>;
  scriptCommands?: string[];
  extraVerified?: string[];
  extraDenied?: string[];
  hooks?: string[];
  retentionDays?: number;
}

/** Reads key="value" lines of an arkmanager cfg (last one wins, comments ignored). */
export function readArkmanagerCfg(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|[^\s#]*)/.exec(line);
    if (m) values[m[1]] = m[3] ?? m[4] ?? m[2];
  }
  return values;
}

/** Current admin password of an arkmanager instance file (after a password change). */
export function readCfgPassword(cfgFile: string): string | null {
  try { return readArkmanagerCfg(readFileSync(cfgFile, 'utf8')).ark_ServerAdminPassword ?? null; } catch { return null; }
}

/** Turns "@/path" into the trimmed content of that file. */
export function resolveSecret(value: string, baseDir: string): string {
  if (!value.startsWith('@')) return value;
  const path = value.slice(1);
  return readFileSync(isAbsolute(path) ? path : join(baseDir, path), 'utf8').trim();
}

function finishMap(raw: RawMap, baseDir: string): MapConfig {
  if (!raw.name) throw new Error('map without name');
  let password = raw.password ?? '';
  if (raw.passwordFile) password = readFileSync(resolve(baseDir, raw.passwordFile), 'utf8').trim();
  if (raw.passwordEnv) password = process.env[raw.passwordEnv] ?? '';
  if (!raw.rconPort) throw new Error(`map ${raw.name}: rconPort missing`);
  if (!password) throw new Error(`map ${raw.name}: RCON password missing`);
  const role = raw.role ?? 'live';
  return {
    name: raw.name,
    title: raw.title ?? raw.name,
    host: raw.host ?? '127.0.0.1',
    rconPort: Number(raw.rconPort),
    password,
    logDir: raw.logDir ?? null,
    logCommand: raw.logCommand ?? null,
    role,
    // safe default: assume someone else reads the buffer on live maps until told otherwise
    externalBufferReader: raw.externalBufferReader ?? role === 'live',
    logSource: raw.logSource ?? ((raw.logDir || raw.logCommand) ? 'file' : 'none'),
    cfgFile: raw.cfgFile ?? null,
  };
}

/** Maps from arkmanager instance files. Instances without RCON (e.g. an update-only master) are skipped. */
export function discoverArkmanager(dir: string, opts: NonNullable<RawConfig['arkmanager']>): RawMap[] {
  const maps: RawMap[] = [];
  // names ending in "*" match by prefix, e.g. "claude-*"
  const matches = (list: string[] | undefined, name: string) => (list ?? []).some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : p === name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.cfg')).sort()) {
    const name = basename(file, '.cfg');
    if ((opts.include && !matches(opts.include, name)) || matches(opts.exclude, name)) continue;
    const cfg = readArkmanagerCfg(readFileSync(join(dir, file), 'utf8'));
    if (!cfg.ark_RCONPort || !cfg.ark_ServerAdminPassword) continue;
    if ((cfg.ark_RCONEnabled ?? 'True').toLowerCase() !== 'true') continue;
    if ((cfg.arkUpdateOnly ?? '').toLowerCase() === 'true') continue;
    const root = cfg.arkserverroot;
    const logDir = root ? join(root, 'ShooterGame/Saved/Logs') : null;
    maps.push({
      name,
      title: cfg.ark_SessionName ?? name,
      host: opts.host ?? '127.0.0.1',
      rconPort: Number(cfg.ark_RCONPort),
      password: cfg.ark_ServerAdminPassword,
      logDir: logDir && existsSync(logDir) ? logDir : null,
      cfgFile: join(dir, file),
      ...opts.defaults,
      ...opts.overrides?.[name],
    });
  }
  return maps;
}

export function loadConfig(path: string): ManagerConfig {
  const baseDir = dirname(resolve(path));
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
  return buildConfig(raw, baseDir);
}

export function buildConfig(raw: RawConfig, baseDir: string): ManagerConfig {
  const rawMaps: RawMap[] = [];
  if (raw.arkmanager) rawMaps.push(...discoverArkmanager(raw.arkmanager.instances ?? '/etc/arkmanager/instances', raw.arkmanager));
  for (const m of raw.maps ?? []) {
    const i = rawMaps.findIndex((x) => x.name === m.name);
    if (i >= 0) rawMaps[i] = { ...rawMaps[i], ...m }; else rawMaps.push(m);
  }
  const maps = rawMaps.map((m) => finishMap(m, baseDir));
  const webhooks: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.discord?.webhooks ?? {})) webhooks[k] = resolveSecret(v, baseDir);
  return {
    database: resolveSecret(raw.database ?? `sqlite:${join(baseDir, 'ark-manager.sqlite')}`, baseDir),
    maps,
    pollSeconds: raw.pollSeconds ?? 10,
    web: { listen: '127.0.0.1:8790', secureCookies: false, trustProxy: false, ...raw.web },
    discord: { webhooks, routes: raw.discord?.routes ?? {} },
    scriptCommands: raw.scriptCommands,
    extraVerified: raw.extraVerified,
    extraDenied: raw.extraDenied,
    hooks: (raw.hooks ?? []).map((h) => resolve(baseDir, h)),
    retentionDays: raw.retentionDays ?? 0,
  };
}
