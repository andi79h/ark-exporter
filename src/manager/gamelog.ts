// Reads the game log files an ASE server writes with -servergamelog (ShooterGame/Saved/Logs/ServerGame.<pid>.<date>.log).
// They hold the same lines as the RCON command GetGameLog, but reading the file takes nothing away from other RCON
// clients, keeps umlauts (RCON turns them into "?") and survives a restart of the manager (the read offset is stored).
//
// Line format: [2026.11.19-05.03.29:578][745]2026.11.19_05.03.29: Name joined this ARK!
// The first bracket is UTC with milliseconds; the second the engine frame.
import { open, readdir, stat } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export type LogEventType = 'join' | 'leave' | 'chat' | 'server-chat' | 'admin' | 'tribe' | 'tame' | 'death' | 'mod' | 'other';

export interface LogEvent {
  /** UTC milliseconds */
  ts: number;
  type: LogEventType;
  /** Message text without timestamps and colour tags. */
  text: string;
  /** Player name (Steam name) for join/leave/chat/admin. */
  name?: string;
  character?: string;
  steamId?: string;
  playerId?: string;
  tribe?: string;
  tribeId?: string;
  /** Admin command, mod tag, tamed creature … */
  detail?: string;
  raw: string;
}

const RCON_LINE = /^﻿?(\d{4})\.(\d\d)\.(\d\d)_(\d\d)\.(\d\d)\.(\d\d): (.*)$/;
const LINE = /^﻿?\[(\d{4})\.(\d\d)\.(\d\d)-(\d\d)\.(\d\d)\.(\d\d):(\d{3})\]\[\s*\d+\](?:\d{4}\.\d\d\.\d\d_\d\d\.\d\d\.\d\d: )?(.*)$/;

export function stripRichText(text: string): string {
  return text.replace(/<RichColor[^>]*>/gi, '').replace(/<\/>/g, '').replace(/<\/?[A-Za-z]+[^>]*>/g, '').trim();
}

/** Parses one log line. Lines without the timestamp prefix (continuations) get `fallbackTs` and type "other". */
export function parseLogLine(raw: string, fallbackTs = Date.now()): LogEvent | null {
  const line = raw.replace(/\r$/, '');
  if (!line.trim()) return null;
  let ts: number;
  let body: string;
  const m = LINE.exec(line);
  const r = m ? null : RCON_LINE.exec(line);
  if (m) {
    ts = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
    body = m[8];
  } else if (r) {                                                  // GetGameLog over RCON: same text, no bracket
    ts = Date.UTC(+r[1], +r[2] - 1, +r[3], +r[4], +r[5], +r[6]);
    body = r[7];
  } else {
    return { ts: fallbackTs, type: 'other', text: stripRichText(line), raw: line };
  }
  // ASA adds " [UniqueNetId:… Platform:…]" to join/leave lines
  const msg = body.replace(/\s*\[UniqueNetId:[^\]]*\]/, '');
  const ev = (type: LogEventType, extra: Partial<LogEvent> = {}): LogEvent => ({ ts, type, text: stripRichText(msg), raw: line, ...extra });
  let p: RegExpExecArray | null;
  if ((p = /^(.*) joined this ARK!$/.exec(msg))) return ev('join', { name: p[1] });
  if ((p = /^(.*) left this ARK!$/.exec(msg))) return ev('leave', { name: p[1] });
  if ((p = /^AdminCmd: (.*) \(PlayerName: (.*), ARKID: (\d+), SteamID: (\d+)\)$/.exec(msg))) {
    return ev('admin', { detail: p[1], name: p[2], playerId: p[3], steamId: p[4] });
  }
  if ((p = /^Tribe (.*), ID (\d+): Day \d+, [\d:]+: (.*)$/.exec(msg))) {
    return ev('tribe', { tribe: p[1], tribeId: p[2], text: stripRichText(p[3]) });
  }
  if ((p = /^(?:(.*) of )?Tribe (.*) Tamed an? (.*)!$/.exec(msg))) {
    return ev('tame', { name: p[1], tribe: p[2], detail: p[3] });
  }
  if ((p = /^SERVER: (.*)$/.exec(msg))) return ev('server-chat', { text: stripRichText(p[1]) });
  // "Name - Lvl 77 (Tribe) was killed by Raptor - Lvl 20 ()!" or "… was killed! [KillerSID: 11112222]"
  if ((p = /^(.+?) - Lvl \d+ \(([^)]*)\) was killed(?: by (.+?))?!(?: \[KillerSID: \d+\])?$/.exec(msg))) {
    return ev('death', { name: p[1], tribe: p[2] || undefined, detail: p[3] });
  }
  if ((p = /^[A-Z][a-z]{2} \d+, \d{4}, [\d:]+ [AP]M \[([^\]]+)\] (.*)$/.exec(msg))) return ev('mod', { detail: p[1], text: p[2] });
  if ((p = /^(.+?) \(([^()]*)\): (.*)$/.exec(msg)) && !/ - Lvl \d+/.test(p[1])) {
    return ev('chat', { name: p[1], character: p[2], text: p[3] });
  }
  return ev('other');
}

/** Sort key of a game log file: the date in its name (ServerGame.<pid>.2026.11.19_04.31.36.log). */
function fileDateKey(name: string): string | null {
  const m = /^ServerGame\.\d+\.(\d{4}\.\d\d\.\d\d_\d\d\.\d\d\.\d\d)\.log$/.exec(name);
  return m ? m[1] : null;
}

export interface FollowState { file: string; offset: number }

export interface LogSource extends EventEmitter {
  start(): void;
  stop(): void;
}

/**
 * Follows the newest ServerGame.*.log of a directory. Emits 'line' (text), 'state' (FollowState) after each read
 * and 'error'. A new file (server restart) is read from its start, after the rest of the old file.
 */
export class GameLogFollower extends EventEmitter implements LogSource {
  private timer: NodeJS.Timeout | null = null;
  private dirMtime = 0;
  private state: FollowState | null;
  private partial = '';
  private busy = false;
  readonly dir: string;
  readonly intervalMs: number;

  /** `state` = where the last run stopped; null = start at the end of the newest file. */
  constructor(dir: string, state: FollowState | null = null, intervalMs = 1000) {
    super();
    this.dir = dir;
    this.state = state;
    this.intervalMs = intervalMs;
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

  private async newestFile(): Promise<string | null> {
    let best: string | null = null;
    let bestKey = '';
    for (const name of await readdir(this.dir)) {
      const key = fileDateKey(name);
      if (key && key > bestKey) { bestKey = key; best = name; }
    }
    return best;
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const dirStat = await stat(this.dir);
      let newest: string | null = this.state?.file ?? null;
      if (dirStat.mtimeMs !== this.dirMtime || !newest) {
        this.dirMtime = dirStat.mtimeMs;
        newest = await this.newestFile();
      }
      if (!newest) return;
      if (!this.state) {
        const size = (await stat(join(this.dir, newest))).size;
        this.state = { file: newest, offset: size };
        this.emit('state', { ...this.state });
        return;
      }
      if (newest !== this.state.file) {
        await this.readFrom(this.state.file).catch(() => undefined);     // rest of the old file
        if (this.partial) { this.emit('line', this.partial); this.partial = ''; }
        this.state = { file: newest, offset: 0 };
      }
      try {
        await this.readFrom(newest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        this.dirMtime = 0;                                                // file vanished: look again next time
      }
    } finally {
      this.busy = false;
    }
  }

  private async readFrom(file: string): Promise<void> {
    if (!this.state) return;
    const path = join(this.dir, file);
    const size = (await stat(path)).size;
    if (size < this.state.offset) { this.state.offset = 0; this.partial = ''; }   // truncated or replaced
    if (size === this.state.offset) return;
    const fh = await open(path, 'r');
    try {
      const length = Math.min(size - this.state.offset, 8 * 1024 * 1024);
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, this.state.offset);
      // never cut a UTF-8 character: stop after the last newline
      const lastNl = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (lastNl < 0) return;
      const text = buf.subarray(0, lastNl + 1).toString('utf8');
      this.state.offset += lastNl + 1;
      const lines = (this.partial + text).split('\n');
      this.partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) this.emit('line', line.replace(/^﻿/, ''));
      this.emit('state', { ...this.state });
    } finally {
      await fh.close();
    }
  }
}

/**
 * Runs a command that prints game log lines (e.g. `ssh host follow-gamelog.sh <dir>`) and restarts it when it ends.
 * For servers whose files are not on this machine.
 */
export class CommandLogSource extends EventEmitter implements LogSource {
  private child: ChildProcess | null = null;
  private stopped = true;
  private restartDelay = 1000;
  readonly argv: string[];

  constructor(argv: string[]) {
    super();
    this.argv = argv;
  }

  start(): void {
    this.stopped = false;
    const [cmd, ...args] = this.argv;
    // own process group, so stop() also ends grandchildren (e.g. ssh started by "sh -c")
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    this.child = child;
    let partial = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.restartDelay = 1000;
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) this.emit('line', line.replace(/^﻿/, ''));
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => this.emit('error', new Error(chunk.trim())));
    child.on('error', (err) => this.emit('error', err));
    child.on('exit', () => {
      this.child = null;
      if (this.stopped) return;
      setTimeout(() => { if (!this.stopped) this.start(); }, this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 60_000);
    });
  }

  stop(): void {
    this.stopped = true;
    const pid = this.child?.pid;
    if (pid) {
      try { process.kill(-pid, 'SIGTERM'); } catch { this.child?.kill(); }
    }
    this.child = null;
  }
}
