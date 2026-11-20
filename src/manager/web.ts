// Web interface and JSON API. Login by user name + password (session cookie) or by API token (Bearer).
// Binds to 127.0.0.1 by default: put a TLS reverse proxy (Apache/nginx) in front or use an SSH tunnel.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { can, hashPassword, isRole, newSecret, permissionsOf, PERMISSIONS, ROLES, tokenHash, verifyPassword, type Permission, type Role } from './auth.ts';
import { ManagerError, TRIGGER_EVENTS, type Actor, type Manager } from './manager.ts';
import { parseCron, nextRun } from './cron.ts';
import { VERIFIED_COMMANDS, RISKY_COMMANDS } from './policy.ts';
import type { Param } from './db.ts';

interface Session { user: string; role: Role; expires: number }

const SESSION_HOURS = 12;
const COOKIE = 'arkm_session';
const UI_FILE = fileURLToPath(new URL('./ui/index.html', import.meta.url));

type Handler = (ctx: Ctx) => Promise<unknown>;
interface Ctx {
  req: IncomingMessage; res: ServerResponse; actor: Actor; params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown>;
}

function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new ManagerError(413, 'request too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { throw new ManagerError(400, 'invalid JSON'); }
}

const str = (v: unknown, name: string, max = 2000): string => {
  if (typeof v !== 'string') throw new ManagerError(400, `${name} missing`);
  if (v.length > max) throw new ManagerError(400, `${name} too long`);
  return v;
};
const optStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const targetsOf = (v: unknown): string[] | 'all' => (Array.isArray(v) ? v.map(String) : v === undefined || v === 'all' ? 'all' : [String(v)]);

export class WebServer {
  private readonly manager: Manager;
  private readonly sessions = new Map<string, Session>();
  private readonly loginFailures = new Map<string, { count: number; until: number }>();
  private readonly routes: Array<{ method: string; re: RegExp; keys: string[]; perm: Permission | null; handler: Handler }> = [];
  private server: Server | null = null;
  private readonly streams = new Set<{ res: ServerResponse; role: Role }>();

  constructor(manager: Manager) {
    this.manager = manager;
    this.defineRoutes();
    const push = (kind: string, perm: Permission) => (data: unknown) => this.broadcast(kind, data, perm);
    manager.on('event', push('event', 'view'));
    manager.on('status', push('status', 'view'));
    manager.on('player', push('player', 'view'));
    manager.on('console', push('console', 'console'));
    manager.on('audit', push('audit', 'audit'));
    setInterval(() => {
      for (const s of this.streams) s.res.write(': ping\n\n');
      const now = Date.now();
      for (const [k, v] of this.sessions) if (v.expires < now) this.sessions.delete(k);
    }, 25_000).unref();
  }

  private broadcast(kind: string, data: unknown, perm: Permission): void {
    const line = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of this.streams) if (can(s.role, perm)) s.res.write(line);
  }

  private route(method: string, path: string, perm: Permission | null, handler: Handler): void {
    const keys: string[] = [];
    const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return '([^/]+)'; })}$`);
    this.routes.push({ method, re, keys, perm, handler });
  }

  listen(listen: string): Promise<void> {
    const i = listen.lastIndexOf(':');
    const host = listen.slice(0, i) || '127.0.0.1';
    const port = Number(listen.slice(i + 1));
    this.server = createServer((req, res) => { void this.handle(req, res); });
    return new Promise((resolve) => this.server!.listen(port, host, () => resolve()));
  }

  address(): { port: number } { return this.server!.address() as { port: number }; }

  close(): void {
    for (const s of this.streams) s.res.end();
    this.server?.close();
  }

  private clientIp(req: IncomingMessage): string {
    if (this.manager.config.web.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string') return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress ?? '?';
  }

  private async authenticate(req: IncomingMessage): Promise<Actor | null> {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const user = await this.manager.store.userByToken(tokenHash(auth.slice(7).trim()));
      if (user && isRole(user.role)) return { name: user.name, type: 'api', role: user.role };
      return null;
    }
    const cookie = /(?:^|;\s*)arkm_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
    const s = cookie ? this.sessions.get(cookie) : undefined;
    if (!s || s.expires < Date.now()) return null;
    return { name: s.user, type: 'user', role: s.role };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        });
        res.end(readFileSync(UI_FILE));
        return;
      }
      if (!url.pathname.startsWith('/api/')) { json(res, 404, { error: 'not found' }); return; }
      if (req.method === 'POST' && url.pathname === '/api/login') { await this.login(req, res); return; }
      const actor = await this.authenticate(req);
      if (!actor) { json(res, 401, { error: 'login required' }); return; }
      // cookie sessions: state-changing requests need a custom header (blocks cross-site form posts)
      if (req.method !== 'GET' && actor.type === 'user' && req.headers['x-arkm'] !== '1') { json(res, 403, { error: 'missing X-ARKM header' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/stream') { this.stream(req, res, actor); return; }
      for (const r of this.routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        if (r.perm) this.manager.require(actor, r.perm);
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const body = req.method === 'GET' ? {} : await readBody(req);
        const result = await r.handler({ req, res, actor, params, query: url.searchParams, body });
        if (!res.headersSent) json(res, 200, result ?? { ok: true });
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err instanceof ManagerError ? err.status : 500;
      if (status === 500) this.manager.emit('warning', (err as Error).stack ?? String(err));
      if (!res.headersSent) json(res, status, { error: (err as Error).message });
    }
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = this.clientIp(req);
    const fail = this.loginFailures.get(ip);
    if (fail && fail.until > Date.now()) { json(res, 429, { error: 'too many failed logins, wait a few minutes' }); return; }
    const body = await readBody(req);
    const name = String(body.name ?? '');
    const user = await this.manager.store.user(name);
    const ok = Boolean(user && !user.disabled && isRole(user.role) && await verifyPassword(String(body.password ?? ''), user.password_hash));
    if (!ok || !user) {
      const f = fail && fail.until > Date.now() - 900_000 ? fail : { count: 0, until: 0 };
      f.count++;
      if (f.count >= 5) f.until = Date.now() + 5 * 60_000;
      this.loginFailures.set(ip, f);
      await this.manager.store.audit({ actor: name || '?', actorType: 'user', action: 'login', target: ip, result: 'denied' });
      json(res, 401, { error: 'wrong name or password' });
      return;
    }
    this.loginFailures.delete(ip);
    const id = newSecret(32);
    this.sessions.set(id, { user: user.name, role: user.role as Role, expires: Date.now() + SESSION_HOURS * 3600_000 });
    await this.manager.store.touchLogin(user.name);
    await this.manager.store.audit({ actor: user.name, actorType: 'user', action: 'login', target: ip, result: 'ok' });
    const secure = this.manager.config.web.secureCookies ? '; Secure' : '';
    json(res, 200, { name: user.name, role: user.role }, { 'set-cookie': `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}` });
  }

  private stream(req: IncomingMessage, res: ServerResponse, actor: Actor): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify({ name: actor.name, role: actor.role })}\n\n`);
    const entry = { res, role: actor.role };
    this.streams.add(entry);
    req.on('close', () => this.streams.delete(entry));
  }

  private defineRoutes(): void {
    const m = this.manager;
    const store = m.store;

    this.route('POST', '/api/logout', null, async ({ req, res }) => {
      const cookie = /(?:^|;\s*)arkm_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (cookie) this.sessions.delete(cookie);
      json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    });
    this.route('GET', '/api/me', null, async ({ actor }) => ({ name: actor.name, role: actor.role, permissions: permissionsOf(actor.role) }));
    this.route('GET', '/api/meta', 'view', async () => ({
      roles: ROLES, permissions: PERMISSIONS, triggerEvents: TRIGGER_EVENTS, verified: VERIFIED_COMMANDS, risky: RISKY_COMMANDS,
      webhooks: Object.keys(m.config.discord.webhooks), timeZone: m.timeZone,
    }));

    // maps, players, events
    this.route('GET', '/api/maps', 'view', async () => m.mapsStatus());
    this.route('GET', '/api/events', 'view', async ({ query }) => store.events({
      map: query.get('map') ?? undefined,
      types: query.get('types')?.split(',').filter(Boolean),
      steamId: query.get('steamId') ?? undefined,
      q: query.get('q') ?? undefined,
      beforeId: Number(query.get('beforeId')) || undefined,
      afterId: Number(query.get('afterId')) || undefined,
      limit: Number(query.get('limit')) || 200,
    }));
    this.route('GET', '/api/players', 'view', async ({ query }) => {
      const rows = await store.searchPlayers(query.get('q')?.trim() ?? '', Number(query.get('limit')) || 100);
      return rows.map((p) => ({ ...p, online: m.whereOnline(p.steam_id), banned: m.isBanned(p.steam_id) }));
    });
    this.route('GET', '/api/players/:steamId', 'view', async ({ params, actor }) => {
      const p = await store.player(params.steamId);
      if (!p) throw new ManagerError(404, 'player not found');
      return {
        player: p, online: m.whereOnline(p.steam_id), banned: m.isBanned(p.steam_id), names: await store.playerNames(p.steam_id),
        sessions: await store.playerSessions(p.steam_id, 100), bans: await store.playerBans(p.steam_id),
        notes: can(actor.role, 'notes') ? await store.notes(p.steam_id) : [],
        events: await store.events({ steamId: p.steam_id, limit: 200 }),
      };
    });
    this.route('POST', '/api/players/:steamId/message', 'chat', async ({ actor, params, body }) => m.messagePlayer(actor, params.steamId, str(body.text, 'text', 400)));
    this.route('POST', '/api/players/:steamId/kick', 'kick', async ({ actor, params, body }) => m.kick(actor, params.steamId, optStr(body.reason) ?? ''));
    this.route('POST', '/api/players/:steamId/notes', 'notes', async ({ actor, params, body }) => ({ id: await m.addNote(actor, params.steamId, str(body.text, 'text'), optStr(body.flag)) }));
    this.route('DELETE', '/api/notes/:id', 'notes', async ({ actor, params }) => {
      await store.deleteNote(Number(params.id));
      await m.audit(actor, 'note-delete', params.id, null, 'ok');
    });

    // console and chat
    this.route('POST', '/api/check', 'view', async ({ body }) => m.check(str(body.command, 'command', 1000), optStr(body.map) ?? undefined));
    this.route('POST', '/api/exec', 'console', async ({ actor, body }) => m.exec(actor, targetsOf(body.maps), str(body.command, 'command', 1000), { force: body.force === true }));
    this.route('POST', '/api/broadcast', 'chat', async ({ actor, body }) => m.broadcast(actor, targetsOf(body.maps), str(body.text, 'text', 450)));

    // bans
    this.route('GET', '/api/bans', 'view', async ({ query }) => (query.get('active') === '1' ? store.activeBans() : store.bans(1000)));
    this.route('POST', '/api/bans', 'ban', async ({ actor, body }) => m.ban(actor, {
      steamId: str(body.steamId, 'steamId', 32).trim(), reason: str(body.reason, 'reason', 1000),
      minutes: body.minutes === null || body.minutes === undefined || body.minutes === '' ? null : Number(body.minutes), name: optStr(body.name),
    }));
    this.route('POST', '/api/bans/:id/revoke', 'unban', async ({ actor, params, body }) => m.unban(actor, Number(params.id), optStr(body.reason) ?? ''));

    // saved commands
    this.route('GET', '/api/commands', 'view', async () => store.list('mgr_commands'));
    const saveCommand: Handler = async ({ actor, params, body }) => {
      const template = str(body.template, 'template', 1000);
      const perm = (optStr(body.permission) ?? 'commands.run') as Permission;
      if (!(perm in PERMISSIONS)) throw new ManagerError(400, 'unknown permission');
      // a saved command may not grant more than its author may do
      if (!can(actor.role, perm)) throw new ManagerError(403, 'you cannot create commands for a permission you do not have');
      const check = m.check(template.replace(/\{\{[^}]*\}\}/g, 'x'));
      if (!check.ok) throw new ManagerError(400, `command refused: ${check.reason}`);
      if (check.level === 'risky' && !can(actor.role, 'console.risky')) throw new ManagerError(403, 'risky command needs console.risky');
      if (check.level === 'unverified' && !can(actor.role, 'console.unverified')) throw new ManagerError(403, 'untested command needs console.unverified');
      const values: Record<string, Param> = {
        name: str(body.name, 'name', 100), description: optStr(body.description), template, permission: perm,
        params: body.params ? JSON.stringify(body.params) : null, targets: body.targets ? JSON.stringify(body.targets) : null,
        created_by: actor.name, updated: Date.now(),
      };
      const id = await store.save('mgr_commands', params.id ? Number(params.id) : null, values);
      await m.audit(actor, params.id ? 'command-update' : 'command-create', String(values.name), { template, permission: perm }, 'ok');
      return { id };
    };
    this.route('POST', '/api/commands', 'commands.manage', saveCommand);
    this.route('PUT', '/api/commands/:id', 'commands.manage', saveCommand);
    this.route('DELETE', '/api/commands/:id', 'commands.manage', async ({ actor, params }) => {
      await store.remove('mgr_commands', Number(params.id));
      await m.audit(actor, 'command-delete', params.id, null, 'ok');
    });
    this.route('POST', '/api/commands/:id/run', 'commands.run', async ({ actor, params, body }) =>
      m.runSaved(actor, Number(params.id), body.maps === undefined ? null : targetsOf(body.maps), (body.params ?? {}) as Record<string, string>));

    // schedules
    this.route('GET', '/api/schedules', 'view', async () => (await store.list('mgr_schedules')).map((s) => {
      let next: number | null = null;
      try { next = nextRun(parseCron(String(s.cron)), Date.now(), m.timeZone); } catch { /* invalid */ }
      return { ...s, next_run: next };
    }));
    const saveSchedule: Handler = async ({ actor, params, body }) => {
      const cron = str(body.cron, 'cron', 100);
      parseCron(cron);
      const actions = this.validateActions(body.actions, actor);
      const values: Record<string, Param> = {
        name: str(body.name, 'name', 100), enabled: body.enabled === false ? 0 : 1, cron,
        targets: body.targets && body.targets !== 'all' ? JSON.stringify(body.targets) : null, actions: JSON.stringify(actions),
        warnings: body.warnings ? JSON.stringify(body.warnings) : null, created_by: actor.name, updated: Date.now(),
      };
      const id = await store.save('mgr_schedules', params.id ? Number(params.id) : null, values);
      await m.reloadAutomation();
      await m.audit(actor, params.id ? 'schedule-update' : 'schedule-create', String(values.name), { cron, actions, warnings: body.warnings ?? null }, 'ok');
      return { id };
    };
    this.route('POST', '/api/schedules', 'schedules.manage', saveSchedule);
    this.route('PUT', '/api/schedules/:id', 'schedules.manage', saveSchedule);
    this.route('DELETE', '/api/schedules/:id', 'schedules.manage', async ({ actor, params }) => {
      await store.remove('mgr_schedules', Number(params.id));
      await m.reloadAutomation();
      await m.audit(actor, 'schedule-delete', params.id, null, 'ok');
    });
    this.route('POST', '/api/schedules/:id/run', 'schedules.manage', async ({ actor, params }) => { await m.runSchedule(actor, Number(params.id)); });

    // triggers
    this.route('GET', '/api/triggers', 'view', async () => store.list('mgr_triggers'));
    const saveTrigger: Handler = async ({ actor, params, body }) => {
      const event = str(body.event, 'event', 32);
      if (!(TRIGGER_EVENTS as readonly string[]).includes(event)) throw new ManagerError(400, 'unknown event');
      const cond = (body.cond ?? null) as { match?: string } | null;
      if (cond?.match) { try { new RegExp(cond.match, 'i'); } catch { throw new ManagerError(400, 'invalid regular expression'); } }
      const actions = this.validateActions(body.actions, actor);
      const values: Record<string, Param> = {
        name: str(body.name, 'name', 100), enabled: body.enabled === false ? 0 : 1, event,
        maps: Array.isArray(body.maps) && body.maps.length ? JSON.stringify(body.maps) : null, cond: cond ? JSON.stringify(cond) : null,
        actions: JSON.stringify(actions), cooldown: Number(body.cooldown ?? 0) || 0, created_by: actor.name, updated: Date.now(),
      };
      const id = await store.save('mgr_triggers', params.id ? Number(params.id) : null, values);
      await m.reloadAutomation();
      await m.audit(actor, params.id ? 'trigger-update' : 'trigger-create', String(values.name), { event, cond, actions }, 'ok');
      return { id };
    };
    this.route('POST', '/api/triggers', 'triggers.manage', saveTrigger);
    this.route('PUT', '/api/triggers/:id', 'triggers.manage', saveTrigger);
    this.route('DELETE', '/api/triggers/:id', 'triggers.manage', async ({ actor, params }) => {
      await store.remove('mgr_triggers', Number(params.id));
      await m.reloadAutomation();
      await m.audit(actor, 'trigger-delete', params.id, null, 'ok');
    });

    // audit and users
    this.route('GET', '/api/audit', 'audit', async ({ query }) => store.auditLog({
      actor: query.get('actor') ?? undefined, action: query.get('action') ?? undefined, beforeId: Number(query.get('beforeId')) || undefined, limit: 300,
    }));
    this.route('GET', '/api/users', 'users', async () => (await store.users()).map(({ password_hash, token_hash, ...u }) => ({ ...u, hasPassword: Boolean(password_hash), hasToken: Boolean(token_hash) })));
    this.route('POST', '/api/users', 'users', async ({ actor, body }) => {
      const name = str(body.name, 'name', 64).trim();
      const role = String(body.role ?? 'viewer');
      if (!isRole(role)) throw new ManagerError(400, 'unknown role');
      if (!/^[\w.-]{2,64}$/.test(name)) throw new ManagerError(400, 'name: 2–64 letters, digits, . _ -');
      const password = optStr(body.password) ?? newSecret(12);
      await store.saveUser({ name, role, passwordHash: await hashPassword(password), steamId: optStr(body.steamId) });
      await m.audit(actor, 'user-save', name, { role }, 'ok');
      return { name, role, password: body.password ? undefined : password };
    });
    this.route('PUT', '/api/users/:name', 'users', async ({ actor, params, body }) => {
      const u = await store.user(params.name);
      if (!u) throw new ManagerError(404, 'user not found');
      const role = body.role === undefined ? u.role : String(body.role);
      if (!isRole(role)) throw new ManagerError(400, 'unknown role');
      if (u.name === actor.name && role !== u.role) throw new ManagerError(400, 'you cannot change your own role');
      await store.saveUser({ name: u.name, role, disabled: body.disabled === undefined ? undefined : Boolean(body.disabled),
        passwordHash: optStr(body.password) ? await hashPassword(String(body.password)) : undefined });
      if (body.disabled) for (const [k, s] of this.sessions) if (s.user === u.name) this.sessions.delete(k);
      await m.audit(actor, 'user-update', u.name, { role, disabled: body.disabled ?? null, password: Boolean(body.password) }, 'ok');
    });
    this.route('POST', '/api/users/:name/token', 'users', async ({ actor, params }) => {
      const u = await store.user(params.name);
      if (!u) throw new ManagerError(404, 'user not found');
      const token = `arkm_${newSecret(32)}`;
      await store.saveUser({ name: u.name, role: u.role, tokenHash: tokenHash(token) });
      await m.audit(actor, 'user-token', params.name, null, 'ok');
      return { token };
    });
    this.route('DELETE', '/api/users/:name', 'users', async ({ actor, params }) => {
      if (params.name === actor.name) throw new ManagerError(400, 'you cannot delete yourself');
      await store.deleteUser(params.name);
      for (const [k, s] of this.sessions) if (s.user === params.name) this.sessions.delete(k);
      await m.audit(actor, 'user-delete', params.name, null, 'ok');
    });
    this.route('POST', '/api/password', null, async ({ actor, body }) => {
      const u = await store.user(actor.name);
      if (!u || !await verifyPassword(str(body.old, 'old'), u.password_hash)) throw new ManagerError(403, 'old password wrong');
      const pw = str(body.password, 'password', 200);
      if (pw.length < 10) throw new ManagerError(400, 'at least 10 characters');
      await store.saveUser({ name: u.name, role: u.role, passwordHash: await hashPassword(pw) });
      await m.audit(actor, 'password', u.name, null, 'ok');
    });
  }

  /** Actions of triggers/schedules: known types, commands pass the policy, the author must hold the matching permissions. */
  private validateActions(raw: unknown, actor: Actor): unknown[] {
    if (!Array.isArray(raw) || !raw.length) throw new ManagerError(400, 'at least one action');
    const types = ['command', 'broadcast', 'message', 'kick', 'ban', 'discord', 'delay', 'note', 'saved'];
    for (const a of raw as Array<Record<string, unknown>>) {
      if (!types.includes(String(a.type))) throw new ManagerError(400, `unknown action ${String(a.type)}`);
      if (a.type === 'command') {
        const check = this.manager.check(String(a.command ?? '').replace(/\{\{[^}]*\}\}/g, 'x'));
        if (!check.ok) throw new ManagerError(400, `command refused: ${check.reason}`);
        if (check.level === 'unverified') throw new ManagerError(400, 'untested commands are not allowed in automation');
        if (check.level === 'risky' && !can(actor.role, 'console.risky')) throw new ManagerError(403, 'risky command needs console.risky');
      }
      if (a.type === 'kick' && !can(actor.role, 'kick')) throw new ManagerError(403, 'kick action needs permission kick');
      if (a.type === 'ban' && !can(actor.role, 'ban')) throw new ManagerError(403, 'ban action needs permission ban');
      if (a.type === 'discord' && !this.manager.discord.has(String(a.webhook ?? ''))) throw new ManagerError(400, `unknown webhook ${String(a.webhook)}`);
      if (a.type === 'delay' && !(Number(a.seconds) >= 0 && Number(a.seconds) <= 3600)) throw new ManagerError(400, 'delay: 0–3600 seconds');
    }
    return raw;
  }
}
