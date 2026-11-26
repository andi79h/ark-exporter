// Reads the JSON chat log that ASE and ASA write with LogChatMessages=True ([ServerSettings] in GameUserSettings.ini).
// The ServerGame log and RCON GetChat only carry global and local chat; this log has all four channels, including
// tribe and alliance chat, with the sender's ID (SteamID64 on ASE, EOS ID on ASA), tribe ID and ARK player ID.
//
// Folder: ShooterGame/Saved/Logs/ChatLogs/<SessionName without special characters>/
// Files:  ChatLog_<yyyy-mm-dd>_<h>-<m>_<Map>.json, UTC, hour and minute without leading zero, about one per minute.
// Each file is a JSON array: a metadata entry ("Metadata": true, FileTimestamp), the chat entries, and "{}" at the end.
// The open file lacks the closing "{}" and "]"; the server rewrites it on every flush (at most every 15 s).
// ASE entries carry "Timestamp" (the same millisecond as the ServerGame log line); ASA entries have no time at all,
// only the order of the files and the position in the file.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export type ChatChannel = 'global' | 'tribe' | 'alliance' | 'local';

const CHANNELS: Record<string, ChatChannel> = {
  GlobalChat: 'global',
  GlobalTribeChat: 'tribe',
  AllianceChat: 'alliance',
  LocalChat: 'local',
};

export interface ChatLogEntry {
  /** UTC milliseconds from "Timestamp" (ASE); null on ASA. */
  ts: number | null;
  /** null for an unknown SendMode (treated like a private channel). */
  channel: ChatChannel | null;
  sendMode: string;
  /** SenderSteamId: SteamID64 (ASE) or 32-digit EOS ID (ASA); null if missing or malformed. */
  senderId: string | null;
  /** SenderSteamName: the name the ServerGame log shows in front of the brackets. */
  name: string;
  /** SenderName: the survivor. */
  character: string;
  tribe: string | null;
  tribeId: string | null;
  /** SenderId: the ARK player ID (LinkedPlayerDataID), which player commands such as GiveItemToPlayer need. */
  playerId: string | null;
  message: string;
}

export interface ChatLogFile {
  /** FileTimestamp of the metadata entry; tells a rewrite of the same file from a new file with the same name. */
  fileTs: string | null;
  mapName: string | null;
  entries: ChatLogEntry[];
  /** true once the server has closed the file ("{}" and "]"). */
  complete: boolean;
}

const SENDER_ID = /^(?:\d{17}|[0-9a-f]{32})$/i;

/** Global and local chat as well as every line starting with "!" (chat command). Nothing else of tribe or alliance chat. */
export function keepChatLogEntry(e: ChatLogEntry): boolean {
  return e.channel === 'global' || e.channel === 'local' || e.message.trimStart().startsWith('!');
}

/**
 * The text of the ServerGame log line for the same message ("<Steam-Name> (<Character>): <Text>"), without the time.
 * Both sources reduce to it, which is how duplicates of global and local chat are found.
 */
export function chatLineKey(name: string, character: string, text: string): string {
  return `${name.replace(/^\[ShadowMuted\] /, '')} (${character}): ${text}`.trim();
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function toEntry(o: Record<string, unknown>): ChatLogEntry | null {
  if (o.Metadata === true || typeof o.Message !== 'string') return null;
  const sendMode = str(o.SendMode) ?? '';
  const ts = typeof o.Timestamp === 'string' ? Date.parse(o.Timestamp) : NaN;
  const senderId = str(o.SenderSteamId);
  const tribeId = str(o.SenderTribeID);
  const playerId = str(o.SenderId);
  return {
    ts: Number.isFinite(ts) ? ts : null,
    channel: CHANNELS[sendMode] ?? null,
    sendMode,
    senderId: senderId && SENDER_ID.test(senderId) ? senderId : null,
    name: str(o.SenderSteamName) ?? '',
    character: str(o.SenderName) ?? '',
    tribe: str(o.SenderTribeName) || null,
    // -1 = no tribe (ASA writes it for survivors without a tribe)
    tribeId: tribeId && tribeId !== '-1' && tribeId !== '0' ? tribeId : null,
    playerId: playerId && playerId !== '0' && playerId !== '-1' ? playerId : null,
    message: o.Message,
  };
}

/**
 * The complete top-level objects of a JSON array, also for an array that is still open or cut off in the middle of a
 * write. Stops at the first incomplete object; strings (which may hold braces) are skipped.
 */
export function splitJsonObjects(text: string): { objects: string[]; closed: boolean } {
  const objects: string[] = [];
  let i = text.indexOf('[');
  if (i < 0) return { objects, closed: false };
  i++;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ']') return { objects, closed: true };
    if (c !== '{') { i++; continue; }
    const start = i;
    let depth = 0;
    let inString = false;
    for (; i < n; i++) {
      const d = text[i];
      if (inString) {
        if (d === '\\') i++;
        else if (d === '"') inString = false;
      } else if (d === '"') inString = true;
      else if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i >= n) break;                                                   // cut off: wait for the next write
    objects.push(text.slice(start, i + 1));
    i++;
  }
  return { objects, closed: false };
}

/** Parses one chat log file (ASE or ASA, LF or CRLF, with or without BOM, closed or still open). */
export function parseChatLogFile(text: string): ChatLogFile {
  const { objects, closed } = splitJsonObjects(text.replace(/^﻿/, ''));
  const file: ChatLogFile = { fileTs: null, mapName: null, entries: [], complete: false };
  for (const raw of objects) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.Metadata === true) {
      file.fileTs = str(o.FileTimestamp);
      file.mapName = str(o.MapName);
      continue;
    }
    if (Object.keys(o).length === 0) { file.complete = closed; continue; }   // "{}" before "]"
    const e = toEntry(o);
    if (e) file.entries.push(e);
  }
  return file;
}

/** Sort key of a chat log file name (hour and minute have no leading zero): "202611250611", or null for other files. */
export function chatLogFileKey(name: string): string | null {
  const m = /^ChatLog_(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2})-(\d{1,2})_.+\.json$/.exec(name);
  if (!m) return null;
  return m[1] + [m[2], m[3], m[4], m[5]].map((x) => x.padStart(2, '0')).join('');
}

export interface ChatLogFileState {
  /** sort key from the file name */
  key: string;
  /** FileTimestamp; a different one under the same name is a new file */
  stamp: string | null;
  /** chat entries of this file already handled (also the ones not kept) */
  n: number;
}

export interface ChatLogState {
  /** files with this key or older that are not in `files` are done */
  horizon: string;
  /** by path relative to the followed folder */
  files: Record<string, ChatLogFileState>;
}

/** What the follower emits: an entry and where it came from. */
export interface ChatLogItem {
  entry: ChatLogEntry;
  /** path relative to the followed folder */
  file: string;
  /** position in the file (0 = first chat entry) */
  index: number;
  /** last change of the file when the entry was first seen: the best guess for its time if it has no Timestamp */
  fileMtime: number;
}

/** How many files the state remembers; older ones are below the horizon. The server writes only the newest. */
const KEEP_FILES = 12;

/**
 * Follows a ChatLogs folder: its files and those one level down (the folder of the session name), so it can point at
 * Saved/Logs/ChatLogs or at the session folder. Emits 'entry' (ChatLogItem) in file order, 'state' (ChatLogState) after
 * each read with new entries, and 'error'.
 *
 * A file can be rewritten several times; the state counts the entries handled per file, so each entry comes once.
 * Entries that `keep` rejects (by default: tribe and alliance chat that is no command) are counted but never emitted,
 * and their text is not stored anywhere.
 */
export class ChatLogFollower extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private state: ChatLogState | null;
  private seen = new Map<string, { size: number; mtimeMs: number }>();
  private busy = false;
  readonly dir: string;
  readonly intervalMs: number;
  readonly keep: (e: ChatLogEntry) => boolean;

  /** `state` = where the last run stopped; null = skip what is there now and follow from here on. */
  constructor(dir: string, state: ChatLogState | null = null, intervalMs = 2000, keep: (e: ChatLogEntry) => boolean = keepChatLogEntry) {
    super();
    this.dir = dir;
    this.state = state ? { horizon: state.horizon ?? '', files: { ...state.files } } : null;
    this.intervalMs = intervalMs;
    this.keep = keep;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => { this.poll().catch((err) => this.emit('error', err)).finally(() => { if (this.timer) this.timer = setTimeout(tick, this.intervalMs); }); };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Chat log files below the folder, oldest first. A missing folder (chat log not written yet) is empty. */
  private async listFiles(): Promise<Array<{ rel: string; key: string }>> {
    const out: Array<{ rel: string; key: string }> = [];
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
      throw err;
    }
    for (const d of names) {
      if (d.isFile()) {
        const key = chatLogFileKey(d.name);
        if (key) out.push({ rel: d.name, key });
      } else if (d.isDirectory()) {
        for (const name of await readdir(join(this.dir, d.name)).catch(() => [] as string[])) {
          const key = chatLogFileKey(name);
          if (key) out.push({ rel: `${d.name}/${name}`, key });
        }
      }
    }
    return out.sort((a, b) => (a.key === b.key ? (a.rel < b.rel ? -1 : 1) : a.key < b.key ? -1 : 1));
  }

  private async read(rel: string): Promise<{ file: ChatLogFile; mtimeMs: number } | null> {
    const path = join(this.dir, rel);
    try {
      const st = await stat(path);
      const last = this.seen.get(rel);
      if (last && last.size === st.size && last.mtimeMs === st.mtimeMs) return null;      // unchanged since last time
      const text = await readFile(path, 'utf8');
      this.seen.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
      return { file: parseChatLogFile(text), mtimeMs: st.mtimeMs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') { this.seen.delete(rel); return null; }
      throw err;
    }
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const files = await this.listFiles();
      if (!this.state) {
        // first start: everything up to now counts as handled
        const horizon = files.length ? files[files.length - 1].key : '';
        this.state = { horizon, files: {} };
        for (const f of files.filter((x) => x.key === horizon)) {
          const r = await this.read(f.rel);
          this.state.files[f.rel] = { key: f.key, stamp: r?.file.fileTs ?? null, n: r?.file.entries.length ?? 0 };
        }
        this.emit('state', this.snapshot());
        return;
      }
      let changed = false;
      for (const f of files) {
        let st: ChatLogFileState | undefined = this.state.files[f.rel];
        if (!st && f.key <= this.state.horizon) continue;
        const r = await this.read(f.rel);
        if (!r) continue;
        if (!st || (r.file.fileTs && st.stamp && r.file.fileTs !== st.stamp)) {
          st = { key: f.key, stamp: r.file.fileTs, n: 0 };                 // new file, or a new file under the same name
          this.state.files[f.rel] = st;
          changed = true;
        }
        if (!st.stamp && r.file.fileTs) { st.stamp = r.file.fileTs; changed = true; }
        // a read in the middle of a rewrite may show fewer entries than before: never go back
        for (let i = st.n; i < r.file.entries.length; i++) {
          const entry = r.file.entries[i];
          if (this.keep(entry)) this.emit('entry', { entry, file: f.rel, index: i, fileMtime: r.mtimeMs } satisfies ChatLogItem);
        }
        if (r.file.entries.length > st.n) { st.n = r.file.entries.length; changed = true; }
      }
      changed = this.prune() || changed;
      if (changed) this.emit('state', this.snapshot());
    } finally {
      this.busy = false;
    }
  }

  /** Forgets all but the newest files; the horizon moves up to the newest one forgotten. */
  private prune(): boolean {
    const s = this.state!;
    const rels = Object.keys(s.files).sort((a, b) => (s.files[a].key === s.files[b].key ? (a < b ? -1 : 1) : s.files[a].key < s.files[b].key ? -1 : 1));
    if (rels.length <= KEEP_FILES) return false;
    for (const rel of rels.slice(0, rels.length - KEEP_FILES)) {
      if (s.files[rel].key > s.horizon) s.horizon = s.files[rel].key;
      delete s.files[rel];
      this.seen.delete(rel);
    }
    return true;
  }

  snapshot(): ChatLogState {
    const s = this.state ?? { horizon: '', files: {} };
    return { horizon: s.horizon, files: Object.fromEntries(Object.entries(s.files).map(([k, v]) => [k, { ...v }])) };
  }
}

/**
 * Global and local chat reach the service twice when both the ServerGame log and the chat log are read. The first copy
 * wins, the second is dropped. Copies match by their line text (chatLineKey) and, when both have a time (ASE), by time
 * within `toleranceMs`; otherwise (ASA chat log) by arrival within `windowMs`. Each copy matches at most one other, so
 * the same command sent twice is kept twice.
 */
export class ChatDeduplicator {
  private pending = new Map<string, Array<{ source: string; ts: number | null; at: number }>>();
  private size = 0;
  readonly windowMs: number;
  readonly toleranceMs: number;

  constructor(windowMs = 120_000, toleranceMs = 2000) {
    this.windowMs = windowMs;
    this.toleranceMs = toleranceMs;
  }

  /** true = the other source already delivered this line: drop it. */
  isDuplicate(source: string, key: string, ts: number | null, now = Date.now()): boolean {
    this.expire(now);
    const list = this.pending.get(key) ?? [];
    const i = list.findIndex((p) => p.source !== source && (p.ts !== null && ts !== null ? Math.abs(p.ts - ts) <= this.toleranceMs : now - p.at <= this.windowMs));
    if (i >= 0) {
      list.splice(i, 1);
      this.size--;
      if (!list.length) this.pending.delete(key);
      return true;
    }
    list.push({ source, ts, at: now });
    this.pending.set(key, list);
    this.size++;
    return false;
  }

  private expire(now: number): void {
    if (!this.size) return;
    for (const [key, list] of this.pending) {
      const keep = list.filter((p) => now - p.at <= this.windowMs);
      this.size -= list.length - keep.length;
      if (keep.length) this.pending.set(key, keep); else this.pending.delete(key);
    }
    // hard limit against floods: drop the oldest keys
    while (this.size > 2000) {
      const [key, list] = this.pending.entries().next().value!;
      this.pending.delete(key);
      this.size -= list.length;
    }
  }
}
