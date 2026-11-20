// Which commands the manager sends over RCON. Rules (ASE 358.24, from binary analysis and tests on a test server):
// - only commands that work over RCON and are no crash candidate
// - never GetTribeIdPlayerList (crashes the server)
// - no "cheat"/"admincheat" prefix (the server ignores the command then), no "|" chains (only the first part runs)
// - GetChat/GetGameLog drain a buffer shared by all RCON clients: forbidden while another tool (BattleMetrics) reads it
import { ASE_358_COMMANDS, type AseRconClass } from './ase-358-commands.ts';
import { validateCommandLine } from './rcon.ts';

/** Server crashes observed on a test server, regardless of the static class. */
export const CONFIRMED_CRASHES = [
  'SetDay', 'GetTribeIdPlayerList', 'GTIDPL', 'DisableSpectator', 'EnableSpectator', 'GlobalObjectCount', 'LevelUp',
  'PlayerCommand', 'ResetLiveTuningOverloads', 'ToggleDamageLogging', 'DrawDebugBoxForVolumes', 'DumpAssetProperties',
  'SetChatLogMaxAgeInDays', 'SetNetworkTime',
];

/** Tested over RCON on ASE 358.24 without a crash and with the expected effect. */
export const VERIFIED_COMMANDS = [
  'ListPlayers', 'ServerChat', 'ServerChatTo', 'ServerChatToPlayer', 'Broadcast', 'KickPlayer', 'BanPlayer', 'UnbanPlayer',
  'AllowPlayerToJoinNoCheck', 'DisallowPlayerToJoinNoCheck', 'SaveWorld', 'SetMessageOfTheDay', 'ShowMessageOfTheDay',
  'GetPlayerIDForSteamID', 'GetSteamIDForPlayerID', 'RenamePlayer', 'RenameTribe', 'GetChat', 'GetGameLog', 'ScriptCommand',
];

/** Work over RCON but change or stop the whole map. */
export const RISKY_COMMANDS = [
  'DoExit', 'SetGlobalPause', 'DestroyWildDinos', 'DestroyAll', 'DestroyStructures', 'DestroyAllEnemies', 'SetTimeOfDay',
  'AllowPlayerToJoinNoCheck', 'DisallowPlayerToJoinNoCheck', 'RenamePlayer', 'RenameTribe',
];

/** Commands that read and empty the shared chat/log buffer. */
export const BUFFER_COMMANDS = ['GetChat', 'GetGameLog'];

/** First word after ScriptCommand that may be sent (mod commands; they run with a GameMode as "player"). */
export const DEFAULT_SCRIPT_COMMANDS = [
  'TCsAR',                                                         // TCsAutoRewards: points
  'TamedCount_DS', 'UnclaimedCount_DS', 'PrintColor_DS', 'SpawnDino_DS', 'TrapDino_DS',   // Dino Storage v2
];

export type Level = 'verified' | 'risky' | 'unverified';

export interface PolicyOptions {
  /** true while another program (e.g. BattleMetrics) reads GetChat/GetGameLog on this map. */
  externalBufferReader?: boolean;
  scriptCommands?: string[];
  /** Additional command names that count as verified (tested by the operator). */
  extraVerified?: string[];
  /** Command names that are always refused. */
  extraDenied?: string[];
}

export interface PolicyResult {
  ok: boolean;
  /** Command line as it will be sent (prefix removed). */
  command: string;
  name: string;
  level?: Level;
  rconClass?: AseRconClass | 'not-listed';
  reason?: string;
  notes: string[];
}

const lower = (list: readonly string[]) => new Set(list.map((s) => s.toLowerCase()));
const CRASHES = lower(CONFIRMED_CRASHES);
const VERIFIED = lower(VERIFIED_COMMANDS);
const RISKY = lower(RISKY_COMMANDS);
const BUFFER = lower(BUFFER_COMMANDS);
const CLASS_BY_LOWER = new Map(Object.entries(ASE_358_COMMANDS).map(([k, v]) => [k.toLowerCase(), v] as const));

/** Decides whether a command line may be sent and how dangerous it is. */
export function checkCommand(line: string, options: PolicyOptions = {}): PolicyResult {
  const notes: string[] = [];
  let command = line.trim().replace(/\t/g, ' ');
  const prefix = /^(admincheat|cheat)\s+/i.exec(command);
  if (prefix) {
    command = command.slice(prefix[0].length);
    notes.push(`prefix "${prefix[1]}" removed (over RCON a prefix makes the server ignore the command)`);
  }
  const name = command.split(/\s+/)[0] ?? '';
  const deny = (reason: string, extra: Partial<PolicyResult> = {}): PolicyResult => ({ ok: false, command, name, reason, notes, ...extra });
  const invalid = validateCommandLine(command);
  if (invalid) return deny(invalid);
  if (command.includes('|')) return deny('"|" chains do not work over RCON, only the first command would run');
  const key = name.toLowerCase();
  const rconClass = CLASS_BY_LOWER.get(key) ?? 'not-listed';
  if (lower(options.extraDenied ?? []).has(key)) return deny('refused by configuration', { rconClass });
  if (CRASHES.has(key)) return deny('crashed the server in tests', { rconClass });
  if (rconClass === 'allowed-mypc' || rconClass === 'noguard-mypc') return deny('crash candidate (uses the missing player controller)', { rconClass });
  if (rconClass === 'blocked') return deny('does nothing over RCON (the server checks for RCON and stops)', { rconClass });
  if (rconClass === 'unknown') return deny('not classified, could not be checked', { rconClass });
  if (BUFFER.has(key) && options.externalBufferReader) {
    return deny('another program reads the chat/log buffer of this map (BattleMetrics); reading it would take the lines away', { rconClass });
  }
  const verified = VERIFIED.has(key) || lower(options.extraVerified ?? []).has(key);
  if (rconClass === 'not-listed' && !verified) return deny('unknown command (not in the ASE 358.24 command table)', { rconClass });
  if (key === 'scriptcommand') {
    const sub = command.split(/\s+/)[1] ?? '';
    const allowedSubs = lower(options.scriptCommands ?? DEFAULT_SCRIPT_COMMANDS);
    if (!allowedSubs.has(sub.toLowerCase())) return deny(`ScriptCommand "${sub}" is not on the list of allowed mod commands`, { rconClass });
  }
  const level: Level = RISKY.has(key) ? 'risky' : verified ? 'verified' : 'unverified';
  if (level === 'unverified') notes.push('works over RCON according to the binary analysis, but has not been tested');
  return { ok: true, command, name, level, rconClass, notes };
}

/** Quotes a text parameter for ARK (needed for every text parameter that is not the last one). */
export function quoteArg(value: string): string {
  return `"${value.replace(/"/g, "'")}"`;
}
