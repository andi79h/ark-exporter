// The manager: one RCON connection per map, player tracking via ListPlayers, chat and game log from the log files,
// cluster-wide bans, console, saved and scheduled commands, triggers, Discord relay and an audit log of every action.
import { EventEmitter } from 'node:events';
import { RconClient, RconError, parseListPlayers, toArkAscii } from './rcon.ts';
import { checkCommand, quoteArg, type PolicyResult } from './policy.ts';
import { CommandLogSource, GameLogFollower, parseLogLine, type FollowState, type LogEvent, type LogSource } from './gamelog.ts';
import { Store, type BanRow, type EventRow } from './store.ts';
import { can, type Permission, type Role } from './auth.ts';
import { DiscordRelay, escapeDiscord } from './discord.ts';
import { cronMatches, parseCron, type CronSpec } from './cron.ts';
import { readCfgPassword, type ManagerConfig, type MapConfig } from './config.ts';

export interface Actor {
  name: string;
  type: 'user' | 'api' | 'cli' | 'scheduler' | 'trigger' | 'system';
  role: Role;
}
export const SYSTEM: Actor = { name: 'system', type: 'system', role: 'superadmin' };

export class ManagerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface OnlinePlayer { steamId: string; name: string; since: number; lastWrite: number }
export type MapStatus = 'starting' | 'online' | 'offline' | 'auth-failed';

export interface ExecResult { map: string; ok: boolean; command: string; response?: string; error?: string; policy?: PolicyResult }

export interface Action {
  type: 'command' | 'broadcast' | 'message' | 'kick' | 'ban' | 'discord' | 'delay' | 'note' | 'saved';
  command?: string;
  text?: string;
  webhook?: string;
  seconds?: number;
  minutes?: number | null;
  reason?: string;
  flag?: string | null;
  id?: number;
  params?: Record<string, string>;
  /** "event" (map of the event, default for triggers), "all" (default for schedules) or a list of map names. */
  target?: 'event' | 'all' | 'player' | string[];
}

export interface ActionContext {
  map?: string;
  player?: { steamId: string; name: string };
  text?: string;
  match?: string[];
  params?: Record<string, string>;
}

interface TriggerDef {
  id: number; name: string; event: string; maps: string[] | null; cond: { match?: string; types?: string[] } | null;
  actions: Action[]; cooldown: number; regex: RegExp | null;
}
interface ScheduleDef {
  id: number; name: string; spec: CronSpec; targets: string[] | null; actions: Action[];
  warnings: Array<{ minutes: number; text: string }>; lastRun: number;
}

export const TRIGGER_EVENTS = ['join', 'first-join', 'first-join-map', 'leave', 'chat', 'log', 'map-online', 'map-offline', 'ban-kick'] as const;

class MapRuntime {
  readonly cfg: MapConfig;
  client: RconClient | null = null;
  connecting: Promise<RconClient> | null = null;
  status: MapStatus = 'starting';
  lastError: string | null = null;
  lastPoll = 0;
  failures = 0;
  nextAttempt = 0;
  online = new Map<string, OnlinePlayer>();
  log: LogSource | null = null;
  /** names from "joined"/"left" log lines (UTF-8) → time, to repair "?" names from RCON */
  logNames = new Map<string, number>();
  recentlyLeft = new Map<string, { steamId: string; ts: number }>();
  firstPoll = true;
  constructor(cfg: MapConfig) { this.cfg = cfg; }
}

const STEAM_ID = /^\d{17}$/;
const minute = (ts: number) => Math.floor(ts / 60_000) * 60_000;

/** Regex that matches the UTF-8 original of a name ARK sent over RCON with "?" for every non-ASCII character. */
export function rconNamePattern(rconName: string): RegExp {
  const src = [...rconName].map((c) => (c === '?' ? '(?:[\\ud800-\\udbff][\\udc00-\\udfff]|[^\\x00-\\x7f]|\\?)' : c.replace(/[.*+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${src}$`);
}

/** Fills {{player.name}}, {{player.steamId}}, {{map}}, {{text}}, {{match.N}}, {{param.x}} … */
export function renderTemplate(template: string, values: Record<string, string>, forCommand: boolean): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = values[key] ?? '';
    // inside RCON commands: ASCII only, no quotes (they delimit arguments), no "|"
    return forCommand ? toArkAscii(v).replace(/["|]/g, '') : v;
  });
}

export class Manager extends EventEmitter {
  readonly config: ManagerConfig;
  readonly store: Store;
  readonly maps = new Map<string, MapRuntime>();
  readonly discord: DiscordRelay;
  private timers: NodeJS.Timeout[] = [];
  private bannedIds = new Set<string>();
  private triggers: TriggerDef[] = [];
  private schedules: ScheduleDef[] = [];
  private cooldowns = new Map<string, number>();
  private warningsSent = new Set<string>();
  private stopped = false;
  private heartbeat = 0;
  readonly timeZone: string;

  constructor(config: ManagerConfig, store: Store, opts: { timeZone?: string; fetchImpl?: typeof fetch } = {}) {
    super();
    this.setMaxListeners(100);
    this.config = config;
    this.store = store;
    this.timeZone = opts.timeZone ?? 'Europe/Berlin';
    this.discord = new DiscordRelay(config.discord.webhooks, opts.fetchImpl);
    this.discord.onError = (err) => this.emit('warning', `discord: ${err.message}`);
    for (const m of config.maps) this.maps.set(m.name, new MapRuntime(m));
  }

  // --- lifecycle -------------------------------------------------------------------------------------------
  async start(): Promise<void> {
    await this.store.init();
    this.heartbeat = Number(await this.store.getState('heartbeat') ?? 0) || Date.now();
    for (const rt of this.maps.values()) {
      await this.store.upsertMap(rt.cfg.name, rt.cfg.title, rt.cfg.role);
      // sessions left open by the previous run: keep them; the first poll closes those who are gone
      for (const s of await this.store.openSessions(rt.cfg.name)) {
        rt.online.set(s.steam_id, { steamId: s.steam_id, name: s.name ?? s.steam_id, since: s.start_ts, lastWrite: 0 });
      }
      await this.startLog(rt);
    }
    await this.reloadBans();
    await this.reloadAutomation();
    const pollMs = Math.max(2, this.config.pollSeconds) * 1000;
    this.every(pollMs, () => this.pollAll());
    this.every(15_000, () => this.tickSchedules());
    this.every(60_000, async () => {
      this.heartbeat = Date.now();
      await this.store.setState('heartbeat', String(this.heartbeat));
      await this.expireBans();
    });
    if (this.config.retentionDays > 0) this.every(6 * 3600_000, () => this.prune());
    for (const hook of this.config.hooks) {
      const mod = await import(hook) as { default?: (m: Manager) => unknown };
      if (typeof mod.default === 'function') await mod.default(this);
    }
    void this.pollAll();
  }

  private every(ms: number, fn: () => unknown): void {
    const run = async () => {
      try { await fn(); } catch (err) { this.emit('warning', (err as Error).stack ?? String(err)); }
    };
    this.timers.push(setInterval(run, ms));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const rt of this.maps.values()) { rt.log?.stop(); rt.client?.close(); }
    this.discord.stop();
    await this.store.setState('heartbeat', String(Date.now())).catch(() => undefined);
  }

  private map(name: string): MapRuntime {
    const rt = this.maps.get(name);
    if (!rt) throw new ManagerError(404, `unknown map ${name}`);
    return rt;
  }

  private targets(targets: string[] | 'all' | null | undefined): MapRuntime[] {
    if (!targets || targets === 'all' || (Array.isArray(targets) && targets.includes('all'))) return [...this.maps.values()];
    return targets.map((t) => this.map(t));
  }

  require(actor: Actor, perm: Permission): void {
    if (!can(actor.role, perm)) throw new ManagerError(403, `${actor.name} (${actor.role}) lacks permission ${perm}`);
  }

  // --- RCON ------------------------------------------------------------------------------------------------
  private async client(rt: MapRuntime): Promise<RconClient> {
    if (rt.client?.connected) return rt.client;
    if (rt.connecting) return rt.connecting;
    if (Date.now() < rt.nextAttempt) throw new RconError('offline', rt.lastError ?? 'offline');
    rt.connecting = this.connect(rt, false).finally(() => { rt.connecting = null; });
    return rt.connecting;
  }

  private async connect(rt: MapRuntime, retried: boolean): Promise<RconClient> {
    const c = new RconClient({ host: rt.cfg.host, port: rt.cfg.rconPort, password: rt.cfg.password, timeoutMs: 5000 });
    try {
      await c.connect();
    } catch (e) {
      const err = e as RconError;
      rt.failures++;
      // password changed in the arkmanager file (and the map restarted with it)? take it over and retry at once
      const fresh = err.kind === 'auth' && !retried && rt.cfg.cfgFile ? readCfgPassword(rt.cfg.cfgFile) : null;
      if (fresh && fresh !== rt.cfg.password) {
        rt.cfg.password = fresh;
        return this.connect(rt, true);
      }
      // a wrong password is not retried quickly (some hosts block addresses after failed logins)
      const delay = err.kind === 'auth' ? 300_000 : Math.min(60_000, 1000 * 2 ** Math.min(rt.failures, 6));
      rt.nextAttempt = Date.now() + delay;
      rt.lastError = err.message;
      if (err.kind === 'auth') this.setStatus(rt, 'auth-failed');
      throw err;
    }
    rt.client = c;
    rt.failures = 0;
    c.on('close', () => { if (rt.client === c) rt.client = null; });
    return c;
  }

  /** Sends a command after the safety check. No permission check: callers do that. */
  private async send(rt: MapRuntime, line: string, opts: { allowUnverified?: boolean; allowRisky?: boolean } = {}): Promise<ExecResult> {
    const policy = checkCommand(line, {
      externalBufferReader: rt.cfg.externalBufferReader,
      scriptCommands: this.config.scriptCommands,
      extraVerified: this.config.extraVerified,
      extraDenied: this.config.extraDenied,
    });
    if (!policy.ok) return { map: rt.cfg.name, ok: false, command: policy.command, error: `refused: ${policy.reason}`, policy };
    if (policy.level === 'risky' && !opts.allowRisky) return { map: rt.cfg.name, ok: false, command: policy.command, error: 'refused: command with large effect needs permission console.risky', policy };
    if (policy.level === 'unverified' && !opts.allowUnverified) {
      return { map: rt.cfg.name, ok: false, command: policy.command, error: 'refused: untested command (needs console.unverified, on live maps also "force")', policy };
    }
    try {
      const response = await (await this.client(rt)).exec(policy.command);
      return { map: rt.cfg.name, ok: true, command: policy.command, response, policy };
    } catch (err) {
      return { map: rt.cfg.name, ok: false, command: policy.command, error: (err as Error).message, policy };
    }
  }

  // --- polling and players ---------------------------------------------------------------------------------
  async pollAll(): Promise<void> {
    if (this.stopped) return;
    await Promise.all([...this.maps.values()].map((rt) => this.poll(rt).catch((err) => this.emit('warning', `${rt.cfg.name}: ${(err as Error).message}`))));
  }

  private setStatus(rt: MapRuntime, status: MapStatus): void {
    if (rt.status === status) return;
    const before = rt.status;
    rt.status = status;
    this.emit('status', { map: rt.cfg.name, status, before, error: rt.lastError });
  }

  private async poll(rt: MapRuntime): Promise<void> {
    let text: string;
    try {
      text = await (await this.client(rt)).exec('ListPlayers');
    } catch (err) {
      rt.lastError = (err as Error).message;
      await this.mapDown(rt);
      return;
    }
    const now = Date.now();
    rt.lastError = null;
    const wasUp = rt.status === 'online';
    if (!wasUp) {
      this.setStatus(rt, 'online');
      await this.mapEvent(rt, 'map-online', 'Karte ist online');
      await this.resyncBans(rt);
    }
    const listed = text.includes('No Players Connected') ? [] : parseListPlayers(text);
    const seen = new Set<string>();
    for (const p of listed) {
      seen.add(p.steamId);
      const known = rt.online.get(p.steamId);
      if (!known) await this.playerJoined(rt, p.steamId, p.name, now);
      else if (now - known.lastWrite > 60_000) {
        known.lastWrite = now;
        await this.store.db.run('UPDATE mgr_players SET last_seen = ?, last_map = ? WHERE steam_id = ?', [now, rt.cfg.name, p.steamId]);
      }
      if (this.bannedIds.has(p.steamId)) await this.enforceBan(rt, p.steamId);
    }
    for (const [steamId, p] of [...rt.online]) {
      if (seen.has(steamId)) continue;
      // after a restart of the manager we do not know when the player left: use the last heartbeat
      const ts = rt.firstPoll ? Math.min(now, Math.max(p.since, this.heartbeat)) : now;
      await this.playerLeft(rt, steamId, ts, 'leave');
    }
    rt.firstPoll = false;
    rt.lastPoll = now;
    await this.store.setMapStatus(rt.cfg.name, 'online', rt.online.size);
    if (rt.cfg.logSource === 'rcon' && !rt.cfg.externalBufferReader) await this.pullGameLog(rt);
    this.emit('poll', { map: rt.cfg.name, ts: now, players: [...rt.online.values()] });
  }

  private async mapDown(rt: MapRuntime): Promise<void> {
    if (rt.status === 'online' || rt.firstPoll) {
      const ts = rt.lastPoll || Math.max(this.heartbeat, ...[...rt.online.values()].map((p) => p.since));
      for (const steamId of [...rt.online.keys()]) await this.playerLeft(rt, steamId, ts, 'map-offline');
      if (rt.status === 'online') await this.mapEvent(rt, 'map-offline', `Karte nicht erreichbar: ${rt.lastError ?? ''}`.trim());
    }
    rt.firstPoll = false;
    if (rt.status !== 'auth-failed') this.setStatus(rt, 'offline');
    await this.store.setMapStatus(rt.cfg.name, rt.status, null);
  }

  private async mapEvent(rt: MapRuntime, type: 'map-online' | 'map-offline', text: string): Promise<void> {
    await this.recordEvent({ ts: Date.now(), map: rt.cfg.name, type, text, source: 'manager' });
    this.route('map', `**${rt.cfg.name}**: ${text}`);
    await this.fireTriggers(type, { map: rt.cfg.name, text });
  }

  private betterName(rt: MapRuntime, rconName: string, candidates: Array<string | null | undefined>): string {
    if (!rconName.includes('?')) return rconName;
    const re = rconNamePattern(rconName);
    for (const c of candidates) if (c && c !== rconName && re.test(c)) return c;
    for (const [n, ts] of rt.logNames) if (Date.now() - ts < 600_000 && re.test(n)) return n;
    return rconName;
  }

  private async playerJoined(rt: MapRuntime, steamId: string, rconName: string, ts: number): Promise<void> {
    const before = await this.store.player(steamId);
    const name = this.betterName(rt, rconName, [before?.name]);
    const first = await this.store.playerSeen(steamId, name, rt.cfg.name, ts);
    await this.store.openSession(steamId, name, rt.cfg.name, ts);
    rt.online.set(steamId, { steamId, name, since: ts, lastWrite: ts });
    if (rt.cfg.logSource === 'none') await this.recordEvent({ ts, map: rt.cfg.name, type: 'join', steamId, name, text: `${name} joined`, source: 'rcon' });
    this.emit('player', { map: rt.cfg.name, type: 'join', steamId, name, ts, ...first });
    this.route('join', `→ **${escapeDiscord(name)}** (${steamId}) betritt **${rt.cfg.name}**${first.firstEver ? ' – zum ersten Mal' : ''}`);
    const player = { steamId, name };
    await this.fireTriggers('join', { map: rt.cfg.name, player });
    if (first.firstEver) await this.fireTriggers('first-join', { map: rt.cfg.name, player });
    if (first.firstOnMap) await this.fireTriggers('first-join-map', { map: rt.cfg.name, player });
  }

  private async playerLeft(rt: MapRuntime, steamId: string, ts: number, reason: string): Promise<void> {
    const p = rt.online.get(steamId);
    rt.online.delete(steamId);
    await this.store.closeSession(steamId, rt.cfg.name, ts, reason);
    const name = p?.name ?? steamId;
    rt.recentlyLeft.set(name, { steamId, ts: Date.now() });
    if (rt.cfg.logSource === 'none') await this.recordEvent({ ts, map: rt.cfg.name, type: 'leave', steamId, name, text: `${name} left (${reason})`, source: 'rcon' });
    this.emit('player', { map: rt.cfg.name, type: 'leave', steamId, name, ts, reason });
    if (reason === 'leave') {
      this.route('leave', `← **${escapeDiscord(name)}** verlässt **${rt.cfg.name}**`);
      await this.fireTriggers('leave', { map: rt.cfg.name, player: { steamId, name } });
    }
  }

  /** Online players of all maps. */
  online(): Array<OnlinePlayer & { map: string }> {
    return [...this.maps.values()].flatMap((rt) => [...rt.online.values()].map((p) => ({ ...p, map: rt.cfg.name })));
  }

  /** Map(s) where a player is online right now. */
  whereOnline(steamId: string): string[] {
    return [...this.maps.values()].filter((rt) => rt.online.has(steamId)).map((rt) => rt.cfg.name);
  }

  mapsStatus(): Array<{ name: string; title: string; role: string; status: MapStatus; error: string | null; lastPoll: number; players: OnlinePlayer[]; logSource: string; externalBufferReader: boolean }> {
    return [...this.maps.values()].map((rt) => ({
      name: rt.cfg.name, title: rt.cfg.title, role: rt.cfg.role, status: rt.status, error: rt.lastError, lastPoll: rt.lastPoll,
      players: [...rt.online.values()], logSource: rt.cfg.logSource, externalBufferReader: rt.cfg.externalBufferReader,
    }));
  }

  // --- chat and game log -----------------------------------------------------------------------------------
  private async startLog(rt: MapRuntime): Promise<void> {
    if (rt.cfg.logSource !== 'file') return;
    let source: LogSource;
    if (rt.cfg.logCommand) {
      source = new CommandLogSource(rt.cfg.logCommand);
    } else if (rt.cfg.logDir) {
      const saved = await this.store.getState(`log:${rt.cfg.name}`);
      const follower = new GameLogFollower(rt.cfg.logDir, saved ? JSON.parse(saved) as FollowState : null);
      let pending: string | null = null;
      let writing = false;
      follower.on('state', (s: FollowState) => {
        pending = JSON.stringify(s);
        if (writing) return;
        writing = true;
        queueMicrotask(async () => {
          while (pending) { const v = pending; pending = null; await this.store.setState(`log:${rt.cfg.name}`, v).catch(() => undefined); }
          writing = false;
        });
      });
      source = follower;
    } else {
      return;
    }
    // lines are handled strictly in order
    let chain = Promise.resolve();
    source.on('line', (line: string) => {
      chain = chain.then(() => this.onLogLine(rt, line)).catch((err) => { this.emit('warning', `${rt.cfg.name} log: ${(err as Error).message}`); });
    });
    source.on('error', (err: Error) => this.emit('warning', `${rt.cfg.name} log: ${err.message}`));
    rt.log = source;
    // first read now, so "start at the end of the file" refers to the moment the manager starts
    if (source instanceof GameLogFollower) await source.poll().catch((err) => this.emit('warning', `${rt.cfg.name} log: ${(err as Error).message}`));
    source.start();
  }

  private async pullGameLog(rt: MapRuntime): Promise<void> {
    const res = await this.send(rt, 'GetGameLog');
    if (!res.ok || !res.response) return;
    for (const line of res.response.split(/\r?\n/)) if (line.trim()) await this.onLogLine(rt, line);
  }

  private steamIdForName(rt: MapRuntime, name: string): string | null {
    for (const p of rt.online.values()) if (p.name === name || rconNamePattern(p.name).test(name)) return p.steamId;
    const left = rt.recentlyLeft.get(name);
    if (left && Date.now() - left.ts < 600_000) return left.steamId;
    for (const [n, l] of rt.recentlyLeft) if (Date.now() - l.ts < 600_000 && rconNamePattern(n).test(name)) return l.steamId;
    return null;
  }

  async onLogLine(rt: MapRuntime | string, line: string): Promise<void> {
    if (typeof rt === 'string') rt = this.map(rt);
    const ev = parseLogLine(line, Date.now());
    if (!ev) return;
    if (ev.type === 'join' || ev.type === 'leave') {
      rt.logNames.set(ev.name!, Date.now());
      if (rt.logNames.size > 200) rt.logNames.delete(rt.logNames.keys().next().value!);
    }
    let steamId = ev.steamId ?? null;
    if (!steamId && ev.name && (ev.type === 'join' || ev.type === 'leave' || ev.type === 'chat')) {
      steamId = this.steamIdForName(rt, ev.name) ?? (await this.store.findPlayerByName(ev.name))?.steam_id ?? null;
    }
    // a join line may arrive after ListPlayers saw the player under a "?" name: repair it
    if (ev.type === 'join' && steamId) {
      const p = rt.online.get(steamId);
      if (p && p.name !== ev.name && p.name.includes('?') && rconNamePattern(p.name).test(ev.name!)) {
        p.name = ev.name!;
        await this.store.playerSeen(steamId, p.name, rt.cfg.name, Date.now());
      }
    }
    if (ev.type === 'admin' && steamId) await this.store.setPlayerIds(steamId, { playerId: ev.playerId, name: ev.name });
    if (ev.type === 'chat' && steamId && ev.character) await this.store.setPlayerIds(steamId, { character: ev.character });
    const data: Record<string, unknown> = {};
    for (const k of ['character', 'playerId', 'tribe', 'tribeId', 'detail'] as const) if (ev[k] !== undefined) data[k] = ev[k];
    await this.recordEvent({ ts: ev.ts, map: rt.cfg.name, type: ev.type, steamId, name: ev.name ?? null, text: ev.text,
      data: Object.keys(data).length ? data : undefined, source: 'log' });
    await this.afterLogEvent(rt, ev, steamId);
  }

  private async afterLogEvent(rt: MapRuntime, ev: LogEvent, steamId: string | null): Promise<void> {
    const map = rt.cfg.name;
    if (ev.type === 'chat') {
      this.route('chat', `[${map}] **${escapeDiscord(ev.name ?? '?')}**${ev.character ? ` (${escapeDiscord(ev.character)})` : ''}: ${escapeDiscord(ev.text)}`);
      await this.fireTriggers('chat', { map, text: ev.text, player: steamId ? { steamId, name: ev.name ?? steamId } : undefined }, ev);
    } else if (ev.type === 'admin') {
      this.route('admin', `[${map}] Admin **${escapeDiscord(ev.name ?? '?')}** (${ev.steamId}): \`${(ev.detail ?? '').replace(/`/g, "'")}\``);
      await this.importIngameBan(ev);
    } else if (ev.type === 'tame') {
      this.route('tame', `[${map}] ${escapeDiscord(ev.text)}`);
    } else if (ev.type === 'tribe') {
      this.route('tribe', `[${map}] ${escapeDiscord(ev.tribe ?? '')}: ${escapeDiscord(ev.text)}`);
    }
    if (ev.type !== 'chat') {
      await this.fireTriggers('log', { map, text: ev.text, player: steamId ? { steamId, name: ev.name ?? steamId } : undefined }, ev);
    }
  }

  /** BanPlayer/UnbanPlayer typed by an admin in the game also land in the ban list of the manager. */
  private async importIngameBan(ev: LogEvent): Promise<void> {
    const m = /^(?:admincheat |cheat )?(BanPlayer|UnbanPlayer)\s+"?(\d{17})"?/i.exec(ev.detail ?? '');
    if (!m) return;
    const steamId = m[2];
    const by = `ingame:${ev.name ?? ev.steamId}`;
    if (m[1].toLowerCase() === 'banplayer') {
      if (this.bannedIds.has(steamId)) return;
      await this.store.addBan({ steamId, reason: 'im Spiel gebannt', by, expiresTs: null });
      await this.store.audit({ actor: by, actorType: 'ingame', action: 'ban', target: steamId, result: 'ok', message: 'BanPlayer im Spiel' });
    } else {
      for (const b of (await this.store.activeBans()).filter((x) => x.steam_id === steamId)) {
        await this.store.revokeBan(b.id, by, 'im Spiel aufgehoben');
      }
      await this.store.audit({ actor: by, actorType: 'ingame', action: 'unban', target: steamId, result: 'ok', message: 'UnbanPlayer im Spiel' });
    }
    await this.reloadBans();
  }

  private async recordEvent(e: { ts: number; map: string | null; type: string; steamId?: string | null; name?: string | null; text?: string | null; data?: unknown; source: string }): Promise<void> {
    const id = await this.store.addEvent(e);
    const row: EventRow = { id, ts: e.ts, map: e.map, type: e.type, steam_id: e.steamId ?? null, name: e.name ?? null, text: e.text ?? null,
      data: e.data === undefined ? null : JSON.stringify(e.data), source: e.source };
    this.emit('event', row);
  }

  private route(kind: string, line: string): void {
    const hook = this.config.discord.routes[kind];
    if (hook) this.discord.send(hook, line);
  }

  // --- console ---------------------------------------------------------------------------------------------
  /** Runs a console command on maps. Unverified commands on live maps need `force`. */
  async exec(actor: Actor, targets: string[] | 'all', line: string, opts: { force?: boolean } = {}): Promise<ExecResult[]> {
    this.require(actor, 'console');
    const maps = this.targets(targets);
    const results: ExecResult[] = [];
    for (const rt of maps) {
      const allowUnverified = can(actor.role, 'console.unverified') && (rt.cfg.role === 'test' || Boolean(opts.force));
      results.push(await this.send(rt, line, { allowRisky: can(actor.role, 'console.risky'), allowUnverified }));
    }
    await this.auditResults(actor, 'exec', line, results);
    this.emit('console', { actor: actor.name, command: line, results, ts: Date.now() });
    return results;
  }

  /** Policy check without sending, for the UI. */
  check(line: string, mapName?: string): PolicyResult {
    const rt = mapName ? this.maps.get(mapName) : undefined;
    return checkCommand(line, {
      externalBufferReader: rt?.cfg.externalBufferReader ?? false,
      scriptCommands: this.config.scriptCommands, extraVerified: this.config.extraVerified, extraDenied: this.config.extraDenied,
    });
  }

  private async auditResults(actor: Actor, action: string, line: string, results: ExecResult[]): Promise<void> {
    const okCount = results.filter((r) => r.ok).length;
    await this.audit(actor, action, results.map((r) => r.map).join(','), {
      command: line,
      results: results.map((r) => ({ map: r.map, ok: r.ok, error: r.error, response: r.response?.slice(0, 500) })),
    }, okCount === results.length ? 'ok' : okCount ? 'partial' : (results.every((r) => r.error?.startsWith('refused')) ? 'denied' : 'error'));
  }

  async audit(actor: Actor, action: string, target: string | null, detail: unknown, result: string, message?: string): Promise<void> {
    await this.store.audit({ actor: actor.name, actorType: actor.type, action, target, detail, result, message: message ?? null });
    const entry = { ts: Date.now(), actor: actor.name, actorType: actor.type, action, target, result, message: message ?? null, detail };
    this.emit('audit', entry);
    if (actor.type !== 'system') {
      const cmd = (detail as { command?: string })?.command;
      this.route('audit', `🛡 ${escapeDiscord(actor.name)}: ${action}${target ? ` → ${escapeDiscord(target)}` : ''}${cmd ? ` \`${cmd.replace(/`/g, "'")}\`` : ''} (${result})`);
    }
  }

  // --- chat ------------------------------------------------------------------------------------------------
  async broadcast(actor: Actor, targets: string[] | 'all', text: string): Promise<ExecResult[]> {
    this.require(actor, 'chat');
    const clean = toArkAscii(text.replace(/\s+/g, ' ').trim());
    if (!clean) throw new ManagerError(400, 'empty message');
    const results: ExecResult[] = [];
    for (const rt of this.targets(targets)) {
      if (rt.status !== 'online' && targets === 'all') continue;
      results.push(await this.send(rt, `ServerChat ${clean}`));
    }
    await this.auditResults(actor, 'broadcast', `ServerChat ${clean}`, results);
    return results;
  }

  async messagePlayer(actor: Actor, steamId: string, text: string): Promise<ExecResult[]> {
    this.require(actor, 'chat');
    const maps = this.whereOnline(steamId);
    if (!maps.length) throw new ManagerError(409, 'player is not online');
    const clean = toArkAscii(text.replace(/\s+/g, ' ').trim());
    const results = await Promise.all(maps.map((m) => this.send(this.map(m), `ServerChatTo ${quoteArg(steamId)} ${clean}`)));
    await this.auditResults(actor, 'message', `ServerChatTo ${steamId} ${clean}`, results);
    return results;
  }

  async kick(actor: Actor, steamId: string, reason = ''): Promise<ExecResult[]> {
    this.require(actor, 'kick');
    if (!STEAM_ID.test(steamId)) throw new ManagerError(400, 'invalid SteamID');
    const maps = this.whereOnline(steamId);
    if (!maps.length) throw new ManagerError(409, 'player is not online');
    const results = await Promise.all(maps.map((m) => this.send(this.map(m), `KickPlayer ${steamId}`)));
    await this.auditResults(actor, 'kick', `KickPlayer ${steamId}`, results);
    if (reason) await this.store.addNote(steamId, actor.name, `Kick: ${reason}`, 'kick');
    return results;
  }

  // --- bans ------------------------------------------------------------------------------------------------
  async reloadBans(): Promise<void> {
    this.bannedIds = new Set((await this.store.activeBans()).map((b) => b.steam_id));
  }

  isBanned(steamId: string): boolean { return this.bannedIds.has(steamId); }

  /** Cluster-wide ban: stored, sent as BanPlayer to every reachable map (they share and rewrite BanList.txt), kicked. */
  async ban(actor: Actor, b: { steamId: string; reason: string; minutes?: number | null; name?: string | null }): Promise<{ id: number; results: ExecResult[] }> {
    this.require(actor, 'ban');
    if (!STEAM_ID.test(b.steamId)) throw new ManagerError(400, 'invalid SteamID (17 digits)');
    if (!b.reason?.trim()) throw new ManagerError(400, 'a reason is required');
    const expiresTs = b.minutes ? Date.now() + Math.round(b.minutes * 60_000) : null;
    const name = b.name ?? (await this.store.player(b.steamId))?.name ?? null;
    const id = await this.store.addBan({ steamId: b.steamId, name, reason: b.reason.trim(), by: actor.name, expiresTs });
    await this.reloadBans();
    const results: ExecResult[] = [];
    for (const rt of this.maps.values()) {
      if (rt.status !== 'online') continue;
      results.push(await this.send(rt, `BanPlayer ${b.steamId}`));
      if (rt.online.has(b.steamId)) results.push(await this.send(rt, `KickPlayer ${b.steamId}`));
    }
    await this.audit(actor, 'ban', b.steamId, { reason: b.reason, minutes: b.minutes ?? null, name, results: results.map((r) => ({ map: r.map, ok: r.ok, error: r.error })) },
      results.every((r) => r.ok) ? 'ok' : 'partial');
    this.route('ban', `⛔ **${escapeDiscord(name ?? b.steamId)}** (${b.steamId}) gebannt von ${escapeDiscord(actor.name)}${expiresTs ? ` bis ${new Date(expiresTs).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ' dauerhaft'}: ${escapeDiscord(b.reason)}`);
    return { id, results };
  }

  async unban(actor: Actor, banId: number, reason: string): Promise<ExecResult[]> {
    this.require(actor, 'unban');
    const ban = await this.store.revokeBan(banId, actor.name, reason || 'aufgehoben');
    if (!ban) throw new ManagerError(404, 'ban not found');
    return this.liftNative(actor, ban, 'unban');
  }

  private async liftNative(actor: Actor, ban: BanRow, action: string): Promise<ExecResult[]> {
    await this.reloadBans();
    const results: ExecResult[] = [];
    if (!this.bannedIds.has(ban.steam_id)) {
      for (const rt of this.maps.values()) if (rt.status === 'online') results.push(await this.send(rt, `UnbanPlayer ${ban.steam_id}`));
    }
    await this.audit(actor, action, ban.steam_id, { banId: ban.id, results: results.map((r) => ({ map: r.map, ok: r.ok, error: r.error })) }, 'ok');
    this.route('ban', `✅ Bann von **${escapeDiscord(ban.name ?? ban.steam_id)}** (${ban.steam_id}) aufgehoben (${escapeDiscord(actor.name)})`);
    return results;
  }

  private async expireBans(): Promise<void> {
    for (const ban of await this.store.expiredBans()) {
      const revoked = await this.store.revokeBan(ban.id, 'system', 'abgelaufen');
      if (revoked) await this.liftNative(SYSTEM, revoked, 'ban-expired');
    }
  }

  private async enforceBan(rt: MapRuntime, steamId: string): Promise<void> {
    const res = await this.send(rt, `KickPlayer ${steamId}`);
    const name = rt.online.get(steamId)?.name ?? steamId;
    await this.recordEvent({ ts: Date.now(), map: rt.cfg.name, type: 'ban-kick', steamId, name, text: `${name} ist gebannt und wurde gekickt`, source: 'manager' });
    await this.audit(SYSTEM, 'ban-kick', steamId, { map: rt.cfg.name, response: res.response, error: res.error }, res.ok ? 'ok' : 'error');
    await this.fireTriggers('ban-kick', { map: rt.cfg.name, player: { steamId, name } });
  }

  /** A map that comes (back) online gets every active ban, so its ban list in memory matches the manager. */
  private async resyncBans(rt: MapRuntime): Promise<void> {
    const bans = await this.store.activeBans();
    if (!bans.length || bans.length > 500) return;
    for (const b of bans) await this.send(rt, `BanPlayer ${b.steam_id}`);
  }

  // --- saved commands --------------------------------------------------------------------------------------
  async runSaved(actor: Actor, id: number, targets: string[] | 'all' | null, params: Record<string, string>): Promise<ExecResult[]> {
    this.require(actor, 'commands.run');
    const cmd = await this.store.item('mgr_commands', id);
    if (!cmd) throw new ManagerError(404, 'saved command not found');
    const need = (cmd.permission as Permission | null) ?? 'commands.run';
    this.require(actor, need);
    const defs = cmd.params ? JSON.parse(String(cmd.params)) as Array<{ name: string; type?: string; required?: boolean }> : [];
    const values: Record<string, string> = {};
    for (const d of defs) {
      const v = (params[d.name] ?? '').trim();
      if (d.required !== false && !v) throw new ManagerError(400, `parameter ${d.name} missing`);
      if (d.type === 'steamId' && v && !STEAM_ID.test(v)) throw new ManagerError(400, `parameter ${d.name}: invalid SteamID`);
      if (d.type === 'number' && v && !/^-?\d+(\.\d+)?$/.test(v)) throw new ManagerError(400, `parameter ${d.name}: not a number`);
      values[`param.${d.name}`] = v;
    }
    const line = renderTemplate(String(cmd.template), values, true);
    // "player" target: the map where the SteamID parameter is online (e.g. Dino Storage SpawnDino_DS)
    let maps: string[] | 'all';
    const stored = cmd.targets ? JSON.parse(String(cmd.targets)) as string[] | 'player' : null;
    if (stored === 'player' || (Array.isArray(stored) && stored[0] === 'player')) {
      const sid = defs.find((d) => d.type === 'steamId');
      const where = sid ? this.whereOnline(values[`param.${sid.name}`]) : [];
      if (!where.length) throw new ManagerError(409, 'player is not online on any map');
      maps = where;
    } else {
      maps = targets ?? (Array.isArray(stored) && stored.length ? stored : 'all');
    }
    const results: ExecResult[] = [];
    for (const rt of this.targets(maps)) {
      const allowUnverified = can(actor.role, 'console.unverified') && rt.cfg.role === 'test';
      results.push(await this.send(rt, line, { allowRisky: need === 'console.risky' || can(actor.role, 'console.risky'), allowUnverified }));
    }
    await this.auditResults(actor, `saved:${cmd.name}`, line, results);
    this.emit('console', { actor: actor.name, command: line, results, ts: Date.now() });
    return results;
  }

  // --- notes -----------------------------------------------------------------------------------------------
  async addNote(actor: Actor, steamId: string, text: string, flag: string | null): Promise<number> {
    this.require(actor, 'notes');
    if (!text.trim()) throw new ManagerError(400, 'empty note');
    const id = await this.store.addNote(steamId, actor.name, text.trim(), flag);
    await this.audit(actor, 'note', steamId, { flag, text: text.slice(0, 200) }, 'ok');
    return id;
  }

  // --- automation: triggers and schedules -----------------------------------------------------------------
  async reloadAutomation(): Promise<void> {
    const trig: TriggerDef[] = [];
    for (const t of await this.store.list('mgr_triggers')) {
      if (!Number(t.enabled)) continue;
      try {
        const cond = t.cond ? JSON.parse(String(t.cond)) as TriggerDef['cond'] : null;
        trig.push({
          id: Number(t.id), name: String(t.name), event: String(t.event), maps: t.maps ? JSON.parse(String(t.maps)) : null, cond,
          actions: JSON.parse(String(t.actions)), cooldown: Number(t.cooldown ?? 0), regex: cond?.match ? new RegExp(cond.match, 'i') : null,
        });
      } catch (err) { this.emit('warning', `trigger ${t.name}: ${(err as Error).message}`); }
    }
    this.triggers = trig;
    const sched: ScheduleDef[] = [];
    for (const s of await this.store.list('mgr_schedules')) {
      if (!Number(s.enabled)) continue;
      try {
        sched.push({
          id: Number(s.id), name: String(s.name), spec: parseCron(String(s.cron)), targets: s.targets ? JSON.parse(String(s.targets)) : null,
          actions: JSON.parse(String(s.actions)), warnings: s.warnings ? JSON.parse(String(s.warnings)) : [], lastRun: Number(s.last_run ?? 0),
        });
      } catch (err) { this.emit('warning', `schedule ${s.name}: ${(err as Error).message}`); }
    }
    this.schedules = sched;
  }

  private async fireTriggers(event: string, ctx: ActionContext, ev?: LogEvent): Promise<void> {
    for (const t of this.triggers) {
      if (t.event !== event) continue;
      if (t.maps?.length && ctx.map && !t.maps.includes(ctx.map)) continue;
      if (t.cond?.types?.length && (!ev || !t.cond.types.includes(ev.type))) continue;
      let match: string[] | undefined;
      if (t.regex) {
        const m = t.regex.exec(ctx.text ?? '');
        if (!m) continue;
        match = [...m];
      }
      const key = `${t.id}:${ctx.player?.steamId ?? ctx.map ?? ''}`;
      const last = this.cooldowns.get(key) ?? 0;
      if (t.cooldown && Date.now() - last < t.cooldown * 1000) continue;
      this.cooldowns.set(key, Date.now());
      await this.store.markRun('mgr_triggers', t.id, Date.now());
      const actor: Actor = { name: `trigger:${t.name}`, type: 'trigger', role: 'admin' };
      // triggers must not block the event pipeline (they may contain delays)
      void this.runActions(actor, t.actions, { ...ctx, match }, 'event').catch((err) => this.emit('warning', `trigger ${t.name}: ${(err as Error).message}`));
    }
  }

  private async tickSchedules(): Promise<void> {
    const now = Date.now();
    const thisMinute = minute(now);
    for (const s of this.schedules) {
      for (const w of s.warnings) {
        const at = thisMinute + w.minutes * 60_000;
        const key = `${s.id}:${w.minutes}:${at}`;
        if (!this.warningsSent.has(key) && cronMatches(s.spec, at, this.timeZone)) {
          this.warningsSent.add(key);
          const actor: Actor = { name: `schedule:${s.name}`, type: 'scheduler', role: 'admin' };
          await this.runActions(actor, [{ type: 'broadcast', text: w.text, target: s.targets ?? 'all' }], {}, 'all');
        }
      }
      if (s.lastRun >= thisMinute || !cronMatches(s.spec, thisMinute, this.timeZone)) continue;
      s.lastRun = now;
      await this.store.markRun('mgr_schedules', s.id, now);
      const actor: Actor = { name: `schedule:${s.name}`, type: 'scheduler', role: 'admin' };
      void this.runActions(actor, s.actions.map((a) => ({ ...a, target: a.target ?? s.targets ?? 'all' })), {}, 'all')
        .catch((err) => this.emit('warning', `schedule ${s.name}: ${(err as Error).message}`));
    }
    if (this.warningsSent.size > 1000) this.warningsSent.clear();
  }

  async runSchedule(actor: Actor, id: number): Promise<void> {
    this.require(actor, 'schedules.manage');
    const row = await this.store.item('mgr_schedules', id);
    if (!row) throw new ManagerError(404, 'schedule not found');
    await this.audit(actor, 'schedule-run', String(row.name), null, 'ok');
    const targets = row.targets ? JSON.parse(String(row.targets)) : 'all';
    const runner: Actor = { name: `schedule:${row.name}`, type: 'scheduler', role: 'admin' };
    await this.runActions(runner, (JSON.parse(String(row.actions)) as Action[]).map((a) => ({ ...a, target: a.target ?? targets })), {}, 'all');
  }

  /** Executes trigger/schedule actions in order. */
  async runActions(actor: Actor, actions: Action[], ctx: ActionContext, defaultTarget: 'event' | 'all'): Promise<void> {
    const rt = ctx.map ? this.maps.get(ctx.map) : undefined;
    const values: Record<string, string> = {
      map: ctx.map ?? '', 'map.title': rt?.cfg.title ?? '', text: ctx.text ?? '', 'player.name': ctx.player?.name ?? '',
      'player.steamId': ctx.player?.steamId ?? '', count: String(rt?.online.size ?? 0),
      time: new Date().toLocaleTimeString('de-DE', { timeZone: this.timeZone, hour: '2-digit', minute: '2-digit' }),
    };
    (ctx.match ?? []).forEach((m, i) => { values[`match.${i}`] = m ?? ''; });
    for (const [k, v] of Object.entries(ctx.params ?? {})) values[`param.${k}`] = v;
    const resolveTargets = (a: Action): MapRuntime[] => {
      const t = a.target ?? defaultTarget;
      if (t === 'event' || t === 'player') {
        if (t === 'player' && ctx.player) return this.whereOnline(ctx.player.steamId).map((m) => this.map(m));
        return rt ? [rt] : [];
      }
      return this.targets(t).filter((m) => t !== 'all' || m.status === 'online');
    };
    for (const a of actions) {
      switch (a.type) {
        case 'delay':
          await new Promise((r) => setTimeout(r, Math.min(3600, Math.max(0, a.seconds ?? 0)) * 1000));
          break;
        case 'command': {
          const line = renderTemplate(a.command ?? '', values, true);
          const results: ExecResult[] = [];
          for (const m of resolveTargets(a)) results.push(await this.send(m, line, { allowRisky: can(actor.role, 'console.risky') }));
          await this.auditResults(actor, 'exec', line, results);
          break;
        }
        case 'broadcast': {
          const line = `ServerChat ${renderTemplate(a.text ?? '', values, true)}`;
          const results: ExecResult[] = [];
          for (const m of resolveTargets(a)) results.push(await this.send(m, line));
          await this.auditResults(actor, 'broadcast', line, results);
          break;
        }
        case 'message': {
          if (!ctx.player) break;
          const line = `ServerChatTo ${quoteArg(ctx.player.steamId)} ${renderTemplate(a.text ?? '', values, true)}`;
          const results = await Promise.all(this.whereOnline(ctx.player.steamId).map((m) => this.send(this.map(m), line)));
          await this.auditResults(actor, 'message', line, results);
          break;
        }
        case 'kick':
          if (ctx.player && this.whereOnline(ctx.player.steamId).length) await this.kick(actor, ctx.player.steamId, renderTemplate(a.reason ?? '', values, false));
          break;
        case 'ban':
          if (ctx.player) await this.ban(actor, { steamId: ctx.player.steamId, reason: renderTemplate(a.reason ?? actor.name, values, false), minutes: a.minutes ?? null, name: ctx.player.name });
          break;
        case 'note':
          if (ctx.player) await this.store.addNote(ctx.player.steamId, actor.name, renderTemplate(a.text ?? '', values, false), a.flag ?? null);
          break;
        case 'discord':
          if (a.webhook) this.discord.send(a.webhook, renderTemplate(a.text ?? '', { ...values, text: escapeDiscord(values.text), 'player.name': escapeDiscord(values['player.name']) }, false));
          break;
        case 'saved':
          if (a.id) await this.runSaved({ ...actor, role: 'admin' }, a.id, a.target && a.target !== 'event' && a.target !== 'all' && a.target !== 'player' ? a.target : null,
            Object.fromEntries(Object.entries(a.params ?? {}).map(([k, v]) => [k, renderTemplate(v, values, false)])));
          break;
      }
    }
  }

  // --- housekeeping ----------------------------------------------------------------------------------------
  private async prune(): Promise<void> {
    const before = Date.now() - this.config.retentionDays * 86_400_000;
    await this.store.db.run('DELETE FROM mgr_events WHERE ts < ?', [before]);
  }
}
