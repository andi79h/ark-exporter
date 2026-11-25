// Persistent data of the manager: players and their sessions, chat and game log, bans, notes, audit log,
// saved and scheduled commands, triggers, users. All tables start with "mgr_" so they can live in an existing database.
import { applySchema, upsertSql, type Db, type Param, type Row } from './db.ts';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mgr_maps (
    name {{short}} NOT NULL PRIMARY KEY, title {{name}}, role {{short}}, status {{short}}, players {{int}},
    last_online {{ts}}, updated {{ts}}) {{table}}`,
  `CREATE TABLE IF NOT EXISTS mgr_players (
    steam_id {{sid}} NOT NULL PRIMARY KEY, name {{name}}, player_id {{short}}, character_name {{name}},
    first_seen {{ts}}, last_seen {{ts}}, last_map {{short}}, sessions {{int}} NOT NULL DEFAULT 0,
    play_seconds {{ts}} NOT NULL DEFAULT 0) {{table}}`,
  `CREATE INDEX mgr_players_name ON mgr_players (name)`,
  `CREATE INDEX mgr_players_last_seen ON mgr_players (last_seen)`,
  `CREATE TABLE IF NOT EXISTS mgr_player_names (
    steam_id {{sid}} NOT NULL, name {{name}} NOT NULL, first_seen {{ts}}, last_seen {{ts}},
    PRIMARY KEY (steam_id, name)) {{table}}`,
  `CREATE TABLE IF NOT EXISTS mgr_sessions (
    id {{id}}, steam_id {{sid}} NOT NULL, map {{short}} NOT NULL, name {{name}}, start_ts {{ts}} NOT NULL,
    end_ts {{ts}}, end_reason {{short}}) {{table}}`,
  `CREATE INDEX mgr_sessions_player ON mgr_sessions (steam_id, start_ts)`,
  `CREATE INDEX mgr_sessions_map ON mgr_sessions (map, start_ts)`,
  `CREATE INDEX mgr_sessions_open ON mgr_sessions (end_ts, map)`,
  `CREATE TABLE IF NOT EXISTS mgr_events (
    id {{id}}, ts {{ts}} NOT NULL, map {{short}}, type {{short}} NOT NULL, steam_id {{sid}}, name {{name}},
    text {{text}}, data {{json}}, source {{short}}) {{table}}`,
  `CREATE INDEX mgr_events_ts ON mgr_events (ts)`,
  `CREATE INDEX mgr_events_map ON mgr_events (map, ts)`,
  `CREATE INDEX mgr_events_player ON mgr_events (steam_id, ts)`,
  `CREATE INDEX mgr_events_type ON mgr_events (type, ts)`,
  `CREATE TABLE IF NOT EXISTS mgr_bans (
    id {{id}}, steam_id {{sid}} NOT NULL, name {{name}}, reason {{text}}, created_ts {{ts}} NOT NULL,
    created_by {{name}}, expires_ts {{ts}}, revoked_ts {{ts}}, revoked_by {{name}}, revoke_reason {{text}}) {{table}}`,
  `CREATE INDEX mgr_bans_player ON mgr_bans (steam_id)`,
  `CREATE TABLE IF NOT EXISTS mgr_notes (
    id {{id}}, steam_id {{sid}} NOT NULL, ts {{ts}} NOT NULL, author {{name}}, text {{text}}, flag {{short}}) {{table}}`,
  `CREATE INDEX mgr_notes_player ON mgr_notes (steam_id)`,
  `CREATE TABLE IF NOT EXISTS mgr_audit (
    id {{id}}, ts {{ts}} NOT NULL, actor {{name}}, actor_type {{short}}, action {{short}} NOT NULL, target {{text}},
    detail {{json}}, result {{short}}, message {{text}}) {{table}}`,
  `CREATE INDEX mgr_audit_ts ON mgr_audit (ts)`,
  `CREATE TABLE IF NOT EXISTS mgr_commands (
    id {{id}}, name {{name}} NOT NULL, description {{text}}, template {{text}} NOT NULL, params {{json}},
    permission {{short}}, targets {{json}}, created_by {{name}}, updated {{ts}}) {{table}}`,
  `CREATE TABLE IF NOT EXISTS mgr_schedules (
    id {{id}}, name {{name}} NOT NULL, enabled {{int}} NOT NULL DEFAULT 1, cron {{short}} NOT NULL, targets {{json}},
    actions {{json}} NOT NULL, warnings {{json}}, last_run {{ts}}, created_by {{name}}, updated {{ts}}) {{table}}`,
  `CREATE TABLE IF NOT EXISTS mgr_triggers (
    id {{id}}, name {{name}} NOT NULL, enabled {{int}} NOT NULL DEFAULT 1, event {{short}} NOT NULL, maps {{json}},
    cond {{json}}, actions {{json}} NOT NULL, cooldown {{int}} NOT NULL DEFAULT 0, fired {{int}} NOT NULL DEFAULT 0,
    last_fired {{ts}}, created_by {{name}}, updated {{ts}}) {{table}}`,
  `CREATE TABLE IF NOT EXISTS mgr_users (
    id {{id}}, name {{name}} NOT NULL, role {{short}} NOT NULL, password_hash {{text}}, token_hash {{short}},
    steam_id {{sid}}, discord_id {{sid}}, disabled {{int}} NOT NULL DEFAULT 0, created {{ts}}, last_login {{ts}}) {{table}}`,
  `CREATE UNIQUE INDEX mgr_users_name ON mgr_users (name)`,
  `CREATE TABLE IF NOT EXISTS mgr_state (k {{short}} NOT NULL PRIMARY KEY, v {{text}}) {{table}}`,
];

export interface EventRow {
  id: number; ts: number; map: string | null; type: string; steam_id: string | null; name: string | null;
  text: string | null; data: string | null; source: string | null;
}
export interface PlayerRow {
  steam_id: string; name: string | null; player_id: string | null; character_name: string | null; first_seen: number;
  last_seen: number; last_map: string | null; sessions: number; play_seconds: number;
}
export interface BanRow {
  id: number; steam_id: string; name: string | null; reason: string | null; created_ts: number; created_by: string | null;
  expires_ts: number | null; revoked_ts: number | null; revoked_by: string | null; revoke_reason: string | null;
}
export interface SessionRow { id: number; steam_id: string; map: string; name: string | null; start_ts: number; end_ts: number | null; end_reason: string | null }
export interface UserRow {
  id: number; name: string; role: string; password_hash: string | null; token_hash: string | null; steam_id: string | null;
  discord_id: string | null; disabled: number; created: number; last_login: number | null;
}
export interface AuditRow {
  id: number; ts: number; actor: string | null; actor_type: string | null; action: string; target: string | null;
  detail: string | null; result: string | null; message: string | null;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const nums = <T extends object>(row: T, cols: string[]): T => {
  const r = row as Row;
  for (const c of cols) if (r[c] !== null && r[c] !== undefined) r[c] = Number(r[c]);
  return row;
};
const TS_COLS = ['id', 'ts', 'first_seen', 'last_seen', 'sessions', 'play_seconds', 'start_ts', 'end_ts', 'created_ts', 'expires_ts',
  'revoked_ts', 'last_run', 'updated', 'enabled', 'cooldown', 'fired', 'last_fired', 'disabled', 'created', 'last_login', 'players', 'last_online'];
const fix = <T extends object>(rows: T[]): T[] => rows.map((r) => nums(r, TS_COLS));

export class Store {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }

  async init(): Promise<void> { await applySchema(this.db, SCHEMA); }

  private all<T extends object>(sql: string, params: Param[] = []): Promise<T[]> { return this.db.all<T>(sql, params).then(fix); }
  private async get<T extends object>(sql: string, params: Param[] = []): Promise<T | undefined> { return (await this.all<T>(sql, params))[0]; }

  // --- state ---------------------------------------------------------------------------------------------
  async getState(key: string): Promise<string | null> {
    return (await this.db.get<{ v: string }>('SELECT v FROM mgr_state WHERE k = ?', [key]))?.v ?? null;
  }
  async setState(key: string, value: string): Promise<void> {
    await this.db.run(upsertSql(this.db.dialect, 'mgr_state', ['k', 'v'], ['k'], { v: 'new.v' }), [key, value]);
  }

  // --- maps ----------------------------------------------------------------------------------------------
  async upsertMap(name: string, title: string, role: string): Promise<void> {
    await this.db.run(upsertSql(this.db.dialect, 'mgr_maps', ['name', 'title', 'role', 'updated'], ['name'],
      { title: 'new.title', role: 'new.role', updated: 'new.updated' }), [name, title, role, Date.now()]);
  }
  async setMapStatus(name: string, status: string, players: number | null): Promise<void> {
    const now = Date.now();
    await this.db.run(`UPDATE mgr_maps SET status = ?, players = ?, updated = ?${status === 'online' ? ', last_online = ?' : ''} WHERE name = ?`,
      status === 'online' ? [status, players, now, now, name] : [status, players, now, name]);
  }
  maps(): Promise<Row[]> { return this.all('SELECT * FROM mgr_maps ORDER BY name'); }

  // --- players and sessions ------------------------------------------------------------------------------
  /** Records that a player is online; returns whether the player is new to the cluster and to this map. */
  async playerSeen(steamId: string, name: string, map: string, ts: number): Promise<{ firstEver: boolean; firstOnMap: boolean }> {
    const existing = await this.get<PlayerRow>('SELECT * FROM mgr_players WHERE steam_id = ?', [steamId]);
    if (!existing) {
      await this.db.run('INSERT INTO mgr_players (steam_id, name, first_seen, last_seen, last_map, sessions, play_seconds) VALUES (?, ?, ?, ?, ?, 0, 0)',
        [steamId, name, ts, ts, map]);
    } else {
      await this.db.run('UPDATE mgr_players SET name = ?, last_seen = ?, last_map = ? WHERE steam_id = ?', [name, ts, map, steamId]);
    }
    await this.db.run(upsertSql(this.db.dialect, 'mgr_player_names', ['steam_id', 'name', 'first_seen', 'last_seen'], ['steam_id', 'name'],
      { last_seen: 'new.last_seen' }), [steamId, name, ts, ts]);
    const onMap = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mgr_sessions WHERE steam_id = ? AND map = ?', [steamId, map]);
    return { firstEver: !existing, firstOnMap: num(onMap?.n) === 0 };
  }

  async setPlayerIds(steamId: string, fields: { playerId?: string; character?: string; name?: string }): Promise<void> {
    const ts = Date.now();
    const p = await this.get<PlayerRow>('SELECT steam_id FROM mgr_players WHERE steam_id = ?', [steamId]);
    if (!p) {
      await this.db.run('INSERT INTO mgr_players (steam_id, name, first_seen, last_seen, sessions, play_seconds) VALUES (?, ?, ?, ?, 0, 0)',
        [steamId, fields.name ?? null, ts, ts]);
    }
    if (fields.playerId) await this.db.run('UPDATE mgr_players SET player_id = ? WHERE steam_id = ?', [fields.playerId, steamId]);
    if (fields.character) await this.db.run('UPDATE mgr_players SET character_name = ? WHERE steam_id = ?', [fields.character, steamId]);
  }

  async openSession(steamId: string, name: string, map: string, ts: number): Promise<void> {
    await this.db.run('INSERT INTO mgr_sessions (steam_id, map, name, start_ts) VALUES (?, ?, ?, ?)', [steamId, map, name, ts]);
    await this.db.run('UPDATE mgr_players SET sessions = sessions + 1 WHERE steam_id = ?', [steamId]);
  }

  async closeSession(steamId: string, map: string, ts: number, reason: string): Promise<void> {
    const open = await this.all<SessionRow>('SELECT * FROM mgr_sessions WHERE steam_id = ? AND map = ? AND end_ts IS NULL', [steamId, map]);
    for (const s of open) {
      await this.db.run('UPDATE mgr_sessions SET end_ts = ?, end_reason = ? WHERE id = ?', [ts, reason, s.id]);
      await this.db.run('UPDATE mgr_players SET play_seconds = play_seconds + ?, last_seen = ? WHERE steam_id = ?',
        [Math.max(0, Math.round((ts - s.start_ts) / 1000)), ts, steamId]);
    }
  }

  openSessions(map?: string): Promise<SessionRow[]> {
    return map
      ? this.all<SessionRow>('SELECT * FROM mgr_sessions WHERE end_ts IS NULL AND map = ?', [map])
      : this.all<SessionRow>('SELECT * FROM mgr_sessions WHERE end_ts IS NULL');
  }

  player(steamId: string): Promise<PlayerRow | undefined> { return this.get<PlayerRow>('SELECT * FROM mgr_players WHERE steam_id = ?', [steamId]); }

  async findPlayerByName(name: string): Promise<PlayerRow | undefined> {
    return this.get<PlayerRow>('SELECT * FROM mgr_players WHERE name = ? ORDER BY last_seen DESC LIMIT 1', [name]);
  }

  searchPlayers(q: string, limit = 50): Promise<PlayerRow[]> {
    const like = `%${q.replace(/[%_\\]/g, '')}%`;
    return this.all<PlayerRow>(
      `SELECT DISTINCT p.* FROM mgr_players p LEFT JOIN mgr_player_names n ON n.steam_id = p.steam_id
       WHERE ? = '' OR p.steam_id = ? OR p.player_id = ? OR p.name LIKE ? OR p.character_name LIKE ? OR n.name LIKE ?
       ORDER BY p.last_seen DESC LIMIT ${Math.min(500, Math.max(1, limit))}`, [q, q, q, like, like, like]);
  }

  playerNames(steamId: string): Promise<Row[]> {
    return this.all('SELECT name, first_seen, last_seen FROM mgr_player_names WHERE steam_id = ? ORDER BY last_seen DESC', [steamId]);
  }
  playerSessions(steamId: string, limit = 100): Promise<SessionRow[]> {
    return this.all<SessionRow>(`SELECT * FROM mgr_sessions WHERE steam_id = ? ORDER BY start_ts DESC LIMIT ${limit}`, [steamId]);
  }

  // --- events (chat, game log, manager messages) ---------------------------------------------------------
  async addEvent(e: { ts: number; map: string | null; type: string; steamId?: string | null; name?: string | null; text?: string | null; data?: unknown; source: string }): Promise<number> {
    const r = await this.db.run('INSERT INTO mgr_events (ts, map, type, steam_id, name, text, data, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [e.ts, e.map, e.type, e.steamId ?? null, e.name ?? null, e.text ?? null, e.data === undefined ? null : JSON.stringify(e.data), e.source]);
    return r.id;
  }

  events(f: { map?: string; types?: string[]; steamId?: string; q?: string; beforeId?: number; afterId?: number; since?: number; limit?: number }): Promise<EventRow[]> {
    const where: string[] = [];
    const params: Param[] = [];
    if (f.map) { where.push('map = ?'); params.push(f.map); }
    if (f.types?.length) { where.push(`type IN (${f.types.map(() => '?').join(', ')})`); params.push(...f.types); }
    if (f.steamId) { where.push('steam_id = ?'); params.push(f.steamId); }
    if (f.q) { where.push('(text LIKE ? OR name LIKE ?)'); const like = `%${f.q}%`; params.push(like, like); }
    if (f.beforeId) { where.push('id < ?'); params.push(f.beforeId); }
    if (f.afterId) { where.push('id > ?'); params.push(f.afterId); }
    if (f.since) { where.push('ts >= ?'); params.push(f.since); }
    const limit = Math.min(1000, Math.max(1, f.limit ?? 200));
    return this.all<EventRow>(`SELECT * FROM mgr_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`, params);
  }

  // --- bans and notes ------------------------------------------------------------------------------------
  async addBan(b: { steamId: string; name?: string | null; reason: string; by: string; expiresTs: number | null }): Promise<number> {
    const r = await this.db.run('INSERT INTO mgr_bans (steam_id, name, reason, created_ts, created_by, expires_ts) VALUES (?, ?, ?, ?, ?, ?)',
      [b.steamId, b.name ?? null, b.reason, Date.now(), b.by, b.expiresTs]);
    return r.id;
  }
  async revokeBan(id: number, by: string, reason: string): Promise<BanRow | undefined> {
    await this.db.run('UPDATE mgr_bans SET revoked_ts = ?, revoked_by = ?, revoke_reason = ? WHERE id = ? AND revoked_ts IS NULL', [Date.now(), by, reason, id]);
    return this.get<BanRow>('SELECT * FROM mgr_bans WHERE id = ?', [id]);
  }
  /** Bans that are neither revoked nor expired. */
  activeBans(now = Date.now()): Promise<BanRow[]> {
    return this.all<BanRow>('SELECT * FROM mgr_bans WHERE revoked_ts IS NULL AND (expires_ts IS NULL OR expires_ts > ?) ORDER BY created_ts DESC', [now]);
  }
  bans(limit = 500): Promise<BanRow[]> { return this.all<BanRow>(`SELECT * FROM mgr_bans ORDER BY id DESC LIMIT ${limit}`); }
  playerBans(steamId: string): Promise<BanRow[]> { return this.all<BanRow>('SELECT * FROM mgr_bans WHERE steam_id = ? ORDER BY id DESC', [steamId]); }
  /** Expired but not yet lifted on the servers (marked by revoked_by = 'expired'). */
  expiredBans(now = Date.now()): Promise<BanRow[]> {
    return this.all<BanRow>('SELECT * FROM mgr_bans WHERE revoked_ts IS NULL AND expires_ts IS NOT NULL AND expires_ts <= ?', [now]);
  }

  async addNote(steamId: string, author: string, text: string, flag: string | null): Promise<number> {
    return (await this.db.run('INSERT INTO mgr_notes (steam_id, ts, author, text, flag) VALUES (?, ?, ?, ?, ?)', [steamId, Date.now(), author, text, flag])).id;
  }
  notes(steamId: string): Promise<Row[]> { return this.all('SELECT * FROM mgr_notes WHERE steam_id = ? ORDER BY ts DESC', [steamId]); }
  async deleteNote(id: number): Promise<void> { await this.db.run('DELETE FROM mgr_notes WHERE id = ?', [id]); }

  // --- audit ---------------------------------------------------------------------------------------------
  async audit(a: { actor: string; actorType: string; action: string; target?: string | null; detail?: unknown; result: string; message?: string | null }): Promise<number> {
    return (await this.db.run('INSERT INTO mgr_audit (ts, actor, actor_type, action, target, detail, result, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Date.now(), a.actor, a.actorType, a.action, a.target ?? null, a.detail === undefined ? null : JSON.stringify(a.detail), a.result, a.message ?? null])).id;
  }
  auditLog(f: { actor?: string; action?: string; beforeId?: number; limit?: number }): Promise<AuditRow[]> {
    const where: string[] = [];
    const params: Param[] = [];
    if (f.actor) { where.push('actor = ?'); params.push(f.actor); }
    if (f.action) { where.push('action = ?'); params.push(f.action); }
    if (f.beforeId) { where.push('id < ?'); params.push(f.beforeId); }
    return this.all<AuditRow>(`SELECT * FROM mgr_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${Math.min(1000, f.limit ?? 200)}`, params);
  }

  // --- generic CRUD for saved commands, schedules, triggers -----------------------------------------------
  list(table: 'mgr_commands' | 'mgr_schedules' | 'mgr_triggers'): Promise<Row[]> { return this.all(`SELECT * FROM ${table} ORDER BY name`); }
  item(table: 'mgr_commands' | 'mgr_schedules' | 'mgr_triggers', id: number): Promise<Row | undefined> { return this.get(`SELECT * FROM ${table} WHERE id = ?`, [id]); }
  async save(table: 'mgr_commands' | 'mgr_schedules' | 'mgr_triggers', id: number | null, values: Record<string, Param>): Promise<number> {
    const cols = Object.keys(values);
    if (id) {
      await this.db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => values[c]), id]);
      return id;
    }
    return (await this.db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => values[c]))).id;
  }
  async remove(table: 'mgr_commands' | 'mgr_schedules' | 'mgr_triggers', id: number): Promise<void> {
    await this.db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  }
  async markRun(table: 'mgr_schedules' | 'mgr_triggers', id: number, ts: number): Promise<void> {
    if (table === 'mgr_schedules') await this.db.run('UPDATE mgr_schedules SET last_run = ? WHERE id = ?', [ts, id]);
    else await this.db.run('UPDATE mgr_triggers SET last_fired = ?, fired = fired + 1 WHERE id = ?', [ts, id]);
  }

  // --- users ---------------------------------------------------------------------------------------------
  users(): Promise<UserRow[]> { return this.all<UserRow>('SELECT * FROM mgr_users ORDER BY name'); }
  user(name: string): Promise<UserRow | undefined> { return this.get<UserRow>('SELECT * FROM mgr_users WHERE name = ?', [name]); }
  userByToken(tokenHash: string): Promise<UserRow | undefined> {
    return this.get<UserRow>('SELECT * FROM mgr_users WHERE token_hash = ? AND disabled = 0', [tokenHash]);
  }
  async saveUser(u: { name: string; role: string; passwordHash?: string | null; tokenHash?: string | null; steamId?: string | null; disabled?: boolean }): Promise<void> {
    const existing = await this.user(u.name);
    if (!existing) {
      await this.db.run('INSERT INTO mgr_users (name, role, password_hash, token_hash, steam_id, disabled, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [u.name, u.role, u.passwordHash ?? null, u.tokenHash ?? null, u.steamId ?? null, u.disabled ? 1 : 0, Date.now()]);
      return;
    }
    await this.db.run('UPDATE mgr_users SET role = ?, password_hash = ?, token_hash = ?, steam_id = ?, disabled = ? WHERE name = ?', [
      u.role, u.passwordHash === undefined ? existing.password_hash : u.passwordHash, u.tokenHash === undefined ? existing.token_hash : u.tokenHash,
      u.steamId === undefined ? existing.steam_id : u.steamId, u.disabled === undefined ? existing.disabled : (u.disabled ? 1 : 0), u.name]);
  }
  async touchLogin(name: string): Promise<void> { await this.db.run('UPDATE mgr_users SET last_login = ? WHERE name = ?', [Date.now(), name]); }
  async deleteUser(name: string): Promise<void> { await this.db.run('DELETE FROM mgr_users WHERE name = ?', [name]); }
}
