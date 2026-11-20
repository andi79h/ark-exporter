import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RconClient, RconError, parseListPlayers, toArkAscii, MAX_COMMAND_BYTES } from '../src/manager/rcon.ts';
import { checkCommand } from '../src/manager/policy.ts';
import { CommandLogSource, GameLogFollower, parseLogLine } from '../src/manager/gamelog.ts';
import { execFileSync } from 'node:child_process';
import { cronMatches, nextRun, parseCron } from '../src/manager/cron.ts';
import { buildConfig, readArkmanagerCfg } from '../src/manager/config.ts';
import { openDb } from '../src/manager/db.ts';
import { Store } from '../src/manager/store.ts';
import { Manager, rconNamePattern, renderTemplate, type Actor } from '../src/manager/manager.ts';
import { WebServer } from '../src/manager/web.ts';
import { hashPassword } from '../src/manager/auth.ts';
import { FakeArk } from './fake-ark.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await wait(20); }
  throw new Error('condition not reached');
}

test('RCON client: login, answers, keep-alive, wrong password, long commands', async () => {
  const ark = new FakeArk('pw');
  const port = await ark.start();
  try {
    const c = new RconClient({ host: '127.0.0.1', port, password: 'pw', timeoutMs: 1000 });
    await c.connect();
    assert.equal(await c.exec('ListPlayers'), 'No Players Connected');
    ark.sendKeepAlive();
    assert.equal(await c.exec('SaveWorld'), 'World Saved');
    assert.equal(await c.exec('ServerChat hallo'), '', 'no-response text becomes empty');
    const [a, b] = await Promise.all([c.exec('SaveWorld'), c.exec('ListPlayers')]);
    assert.equal(a, 'World Saved');
    assert.equal(b, 'No Players Connected');
    await assert.rejects(c.exec(`ServerChat ${'x'.repeat(MAX_COMMAND_BYTES)}`), (e: RconError) => e.kind === 'invalid');
    await assert.rejects(c.exec('ServerChat ä'), (e: RconError) => e.kind === 'invalid');
    c.close();
    const bad = new RconClient({ host: '127.0.0.1', port, password: 'wrong', timeoutMs: 1000 });
    await assert.rejects(bad.connect(), (e: RconError) => e.kind === 'auth');
  } finally {
    await ark.stop();
  }
});

test('ListPlayers parser and ASCII conversion', () => {
  assert.deepEqual(parseListPlayers('0. Anna, Banana, 76561198000000001\n1. Bj?rn, 76561198000000002\n '), [
    { name: 'Anna, Banana', steamId: '76561198000000001' }, { name: 'Bj?rn', steamId: '76561198000000002' }]);
  assert.equal(toArkAscii('Grüße an alle – 5 €'), 'Gruesse an alle - 5 EUR');
  assert.ok(rconNamePattern('Bj?rn').test('Björn'));
  assert.ok(!rconNamePattern('Bj?rn').test('Bjorn2'));
  assert.equal(renderTemplate('ServerChatTo "{{player.steamId}}" Hallo {{player.name}}', { 'player.steamId': '7656', 'player.name': 'Jörg "|x' }, true),
    'ServerChatTo "7656" Hallo Joerg x');
});

test('command policy', () => {
  assert.equal(checkCommand('ListPlayers').level, 'verified');
  assert.equal(checkCommand('admincheat SaveWorld').command, 'SaveWorld');
  assert.equal(checkCommand('GetTribeIdPlayerList 123').ok, false);
  assert.match(checkCommand('SetDay 1').reason!, /crashed/);
  assert.match(checkCommand('KillPlayer 1').reason!, /nothing over RCON/);
  assert.match(checkCommand('GiveItemToPlayer 1 2 3 4 0').reason!, /crash candidate/);
  assert.match(checkCommand('ListPlayers | SaveWorld').reason!, /chains/);
  assert.match(checkCommand('GetChat', { externalBufferReader: true }).reason!, /BattleMetrics/);
  assert.equal(checkCommand('GetChat').ok, true);
  assert.equal(checkCommand('DoExit').level, 'risky');
  assert.equal(checkCommand('ScriptCommand TCsAR AddArcTotal 76561198000000001 5').ok, true);
  assert.equal(checkCommand('ScriptCommand SomethingElse').ok, false);
  assert.equal(checkCommand('NoSuchCommand').ok, false);
});

test('game log lines', () => {
  const ts = Date.UTC(2026, 10, 19, 5, 3, 29, 578);
  const j = parseLogLine('﻿[2026.11.19-05.03.29:578][745]2026.11.19_05.03.29: Björn joined this ARK!')!;
  assert.deepEqual([j.type, j.name, j.ts], ['join', 'Björn', ts]);
  assert.equal(parseLogLine('[2026.11.19-05.27.09:880][854]2026.11.19_05.27.09: Björn left this ARK!')!.type, 'leave');
  const a = parseLogLine('[2026.11.19-13.23.44:459][926]2026.11.19_13.23.44: AdminCmd: gcm (PlayerName: Anna, ARKID: 123456789, SteamID: 76561198000000001)')!;
  assert.deepEqual([a.type, a.detail, a.playerId, a.steamId], ['admin', 'gcm', '123456789', '76561198000000001']);
  const t = parseLogLine('[2026.11.19-13.55.59:988][400]2026.11.19_13.55.59: Tribe Kieselstein, ID 1234567890: Day 18708, 03:14:46: <RichColor Color="0, 1, 0, 1">Rika Tamed a Maewing!</>)')!;
  assert.deepEqual([t.type, t.tribe, t.tribeId], ['tribe', 'Kieselstein', '1234567890']);
  assert.equal(parseLogLine('[2026.11.19-13.55.59:988][400]2026.11.19_13.55.59: Rika of Tribe Kieselstein Tamed a Maewing - Lvl 184 (Maewing)!')!.type, 'tame');
  const c = parseLogLine('[2026.10.25-22.11.08:000][1]2026.10.25_22.11.08: Hans (Hansi): /help')!;
  assert.deepEqual([c.type, c.name, c.character, c.text], ['chat', 'Hans', 'Hansi', '/help']);
  assert.equal(parseLogLine('[2026.10.25-22.08.04:000][1]2026.10.25_22.08.04: SERVER: Willkommen')!.type, 'server-chat');
  const d = parseLogLine('[2026.10.02-20.29.49:463][1]2026.10.02_20.29.49: Tomas - Lvl 4 () was killed by a Sarco - Lvl 145 ()!')!;
  assert.deepEqual([d.type, d.name, d.detail], ['death', 'Tomas', 'a Sarco - Lvl 145 ()']);
  assert.equal(parseLogLine('[2026.10.02-20.29.49:463][1]2026.10.02_20.29.49: Bob - Lvl 77 (Die Wilden) was killed! [KillerSID: 11112222]')!.tribe, 'Die Wilden');
  assert.equal(parseLogLine('[2026.11.19-04.12.11:406][ 56]2026.11.19_04.12.11: Nov 19, 2026, 5:12:11 AM [TCsAR] Server || Loaded 788 Players')!.type, 'mod');
  // the same text over RCON GetGameLog has no bracket
  assert.equal(parseLogLine('2026.11.19_05.03.29: Björn joined this ARK!')!.ts, Date.UTC(2026, 10, 19, 5, 3, 29));
});

test('log follower: resume, new file after restart, partial lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arkm-log-'));
  try {
    const f1 = join(dir, 'ServerGame.111.2026.11.19_04.11.18.log');
    writeFileSync(f1, '﻿[2026.11.19-04.12.11:406][ 56]old line\n');
    const lines: string[] = [];
    let state = null as null | { file: string; offset: number };
    const f = new GameLogFollower(dir, null, 20);
    f.on('line', (l: string) => lines.push(l));
    f.on('state', (s) => { state = s; });
    await f.poll();
    assert.equal(lines.length, 0, 'starts at the end');
    appendFileSync(f1, 'line A\nline B part');
    await f.poll();
    assert.deepEqual(lines, ['line A']);
    appendFileSync(f1, ' 2\n');
    await f.poll();
    assert.deepEqual(lines, ['line A', 'line B part 2']);
    // restart: a newer file appears; the rest of the old one is read first
    appendFileSync(f1, 'last old\n');
    await wait(15);
    writeFileSync(join(dir, 'ServerGame.222.2026.11.20_04.11.18.log'), '﻿first new\n');
    await f.poll();
    assert.deepEqual(lines.slice(2), ['last old', 'first new']);
    // a new follower resumes from the saved state
    const f2 = new GameLogFollower(dir, state, 20);
    const more: string[] = [];
    f2.on('line', (l: string) => more.push(l));
    appendFileSync(join(dir, 'ServerGame.222.2026.11.20_04.11.18.log'), 'after restart of the manager\n');
    await f2.poll();
    assert.deepEqual(more, ['after restart of the manager']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('log command: lines arrive, stop() also ends grandchildren', async () => {
  const marker = `arkm-marker-${process.pid}`;
  const src = new CommandLogSource(['sh', '-c', `sh -c 'while :; do echo ${marker}; sleep 0.1; done'`]);
  const lines: string[] = [];
  src.on('line', (l: string) => lines.push(l));
  src.start();
  await until(() => lines.length > 0);
  src.stop();
  await wait(300);
  const left = (() => { try { return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
  assert.equal(left, '');
});

test('cron', () => {
  const s = parseCron('*/15 5 * * 1-5');
  const berlin = (iso: string) => new Date(iso).getTime();
  assert.ok(cronMatches(s, berlin('2026-11-20T04:30:00Z')));          // Friday 05:30 in Berlin (UTC+1)
  assert.ok(!cronMatches(s, berlin('2026-11-21T04:30:00Z')));         // Saturday
  assert.equal(nextRun(parseCron('0 6 * * *'), berlin('2026-11-20T04:30:00Z')), berlin('2026-11-20T05:00:00Z'));
  assert.throws(() => parseCron('61 * * * *'));
});

test('arkmanager cfg reader', () => {
  const cfg = readArkmanagerCfg('ark_RCONPort="32331"\nark_ServerAdminPassword=abc # comment\n#ark_Port=1\narkserverroot="/srv/x"\n');
  assert.deepEqual(cfg, { ark_RCONPort: '32331', ark_ServerAdminPassword: 'abc', arkserverroot: '/srv/x' });
});

async function setup(dbUrl?: string): Promise<{ ark: FakeArk; manager: Manager; store: Store; dir: string; logFile: string; done: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'arkm-'));
  const logFile = join(dir, 'ServerGame.1.2026.11.20_04.00.00.log');
  writeFileSync(logFile, '﻿[2026.11.20-04.00.00:000][ 1]Log file open\n');
  const ark = new FakeArk('pw');
  ark.logFile = logFile;
  const port = await ark.start();
  const config = buildConfig({
    database: dbUrl ?? `sqlite:${join(dir, 'm.sqlite')}`,
    maps: [{ name: 'testmap', title: 'Test', rconPort: port, password: 'pw', logDir: dir, role: 'test', externalBufferReader: false }],
    pollSeconds: 3600,
  }, dir);
  const store = new Store(await openDb(config.database));
  const manager = new Manager(config, store);
  const warnings: string[] = [];
  manager.on('warning', (w: string) => warnings.push(w));
  await manager.start();
  await manager.pollAll();
  return {
    ark, manager, store, dir, logFile,
    done: async () => { await manager.stop(); await ark.stop(); await store.db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const ADMIN: Actor = { name: 'tester', type: 'user', role: 'admin' };
const MOD: Actor = { name: 'mod', type: 'user', role: 'moderator' };

const mysqlServer = process.env.ARK_EXPORT_TEST_MYSQL;

for (const backend of ['sqlite', 'mysql'] as const) {
test(`manager (${backend}): sessions, names from the log, chat, bans, console policy, triggers`, { skip: backend === 'mysql' && !mysqlServer && 'set ARK_EXPORT_TEST_MYSQL to run' }, async () => {
  let dbUrl: string | undefined;
  let dropDb = async () => {};
  if (backend === 'mysql') {
    const mysql = (await import('mysql2/promise')).default;
    const dbName = `ark_manager_test_${process.pid}_${Date.now()}`;
    const admin = await mysql.createConnection({ uri: mysqlServer });
    await admin.query(`CREATE DATABASE ${dbName} CHARACTER SET utf8mb4`);
    dbUrl = `${mysqlServer!.replace(/\/[^/]*$/, '')}/${dbName}`;
    dropDb = async () => { await admin.query(`DROP DATABASE ${dbName}`); await admin.end(); };
  }
  const { ark, manager, store, logFile, done } = await setup(dbUrl);
  try {
    // a player with an umlaut joins: RCON shows "?", the log has the real name
    ark.writeLog('Jörg joined this ARK!');
    await wait(1100);
    ark.players.push({ name: 'Jörg', steamId: '76561198000000001' });
    await manager.pollAll();
    assert.equal(manager.online()[0]?.name, 'Jörg');
    const p = await store.player('76561198000000001');
    assert.equal(p?.name, 'Jörg');
    assert.equal((await store.openSessions('testmap')).length, 1);

    // chat line from the log gets the SteamID
    ark.writeLog('Jörg (Jo): hallo admin');
    await until(async () => (await store.events({ types: ['chat'] })).length === 1);
    const chat = (await store.events({ types: ['chat'] }))[0];
    assert.equal(chat.steam_id, '76561198000000001');
    assert.equal((await store.player('76561198000000001'))?.character_name, 'Jo');

    // console: verified ok, crash candidate refused, moderator has no console
    const [ok] = await manager.exec(ADMIN, ['testmap'], 'SaveWorld');
    assert.equal(ok.response, 'World Saved');
    const [refused] = await manager.exec(ADMIN, 'all', 'GetTribeIdPlayerList 1');
    assert.equal(refused.ok, false);
    assert.equal(ark.crashed, false);
    await assert.rejects(manager.exec(MOD, 'all', 'SaveWorld'), /lacks permission console/);

    // broadcast with umlauts
    await manager.broadcast(MOD, 'all', 'Neustart in 5 Minuten – bitte ausloggen, Grüße');
    assert.ok(ark.commands.includes('ServerChat Neustart in 5 Minuten - bitte ausloggen, Gruesse'));

    // trigger: chat keyword → private message
    await store.save('mgr_triggers', null, { name: 'help', enabled: 1, event: 'chat', maps: null, cond: JSON.stringify({ match: '^!hilfe' }),
      actions: JSON.stringify([{ type: 'message', text: 'Hallo {{player.name}}, siehe Discord' }]), cooldown: 0, created_by: 't', updated: 0 });
    await manager.reloadAutomation();
    ark.writeLog('Jörg (Jo): !hilfe bitte');
    await until(() => ark.commands.includes('ServerChatTo "76561198000000001" Hallo Joerg, siehe Discord'));

    // ban: stored, BanPlayer sent, player gone; enforcement kicks a banned player who shows up again
    const { id } = await manager.ban(MOD, { steamId: '76561198000000001', reason: 'Test', minutes: 60 });
    assert.ok(ark.bans.has('76561198000000001'));
    await manager.pollAll();
    assert.equal(manager.online().length, 0);
    const closed = (await store.playerSessions('76561198000000001'))[0];
    assert.ok(closed.end_ts);
    ark.players.push({ name: 'Jörg', steamId: '76561198000000001' });
    await manager.pollAll();
    assert.ok(ark.commands.filter((c) => c === 'KickPlayer 76561198000000001').length >= 1);
    assert.equal((await store.events({ types: ['ban-kick'] })).length, 1);
    await assert.rejects(manager.unban(MOD, id, 'x'), /lacks permission unban/);
    await manager.unban(ADMIN, id, 'versehen');
    assert.ok(!ark.bans.has('76561198000000001'));

    // in-game ban by an admin is imported
    ark.writeLog('AdminCmd: BanPlayer 76561198000000009 (PlayerName: Admin, ARKID: 1, SteamID: 76561198000000002)');
    await until(() => manager.isBanned('76561198000000009'));

    // map crash: sessions are closed, map-offline event, back online later
    ark.players = [{ name: 'Anna', steamId: '76561198000000003' }];
    await manager.pollAll();
    ark.crash();
    await manager.pollAll();
    assert.equal(manager.mapsStatus()[0].status, 'offline');
    assert.equal((await store.openSessions()).length, 0);
    ark.revive();
    (manager.maps.get('testmap') as unknown as { nextAttempt: number }).nextAttempt = 0;
    await manager.pollAll();
    assert.equal(manager.mapsStatus()[0].status, 'online');
    assert.ok(ark.commands.includes('BanPlayer 76561198000000009'), 'active bans are re-sent when a map comes online');

    // audit log has every action with its actor
    const audit = await store.auditLog({});
    for (const action of ['exec', 'broadcast', 'ban', 'unban', 'message']) assert.ok(audit.some((a) => a.action === action), action);
    assert.ok(audit.some((a) => a.actor === 'trigger:help'));
    // a restart of the manager keeps open sessions and the log position
    void logFile;
  } finally {
    await done();
    await dropDb();
  }
});
}

test('web API: login, roles, CSRF header, console and stream', async () => {
  const { ark, manager, store, done } = await setup();
  const web = new WebServer(manager);
  await web.listen('127.0.0.1:0');
  const base = `http://127.0.0.1:${web.address().port}`;
  try {
    await store.saveUser({ name: 'mod', role: 'moderator', passwordHash: await hashPassword('modpassword1') });
    await store.saveUser({ name: 'boss', role: 'admin', passwordHash: await hashPassword('bosspassword1') });
    assert.equal((await fetch(`${base}/api/maps`)).status, 401);
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'mod', password: 'nope' }) })).status, 401);
    const login = async (name: string, password: string) => {
      const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ name, password }) });
      assert.equal(r.status, 200);
      return /arkm_session=([^;]+)/.exec(r.headers.get('set-cookie')!)![1];
    };
    const mod = await login('mod', 'modpassword1');
    const boss = await login('boss', 'bosspassword1');
    const call = (cookie: string, method: string, path: string, body?: unknown, csrf = true) => fetch(`${base}${path}`, {
      method, headers: { cookie: `arkm_session=${cookie}`, ...(csrf ? { 'x-arkm': '1' } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal((await call(mod, 'GET', '/api/maps')).status, 200);
    assert.equal((await call(mod, 'POST', '/api/exec', { maps: 'all', command: 'SaveWorld' })).status, 403, 'moderator: no console');
    assert.equal((await call(boss, 'POST', '/api/exec', { maps: 'all', command: 'SaveWorld' }, false)).status, 403, 'missing CSRF header');
    const res = await (await call(boss, 'POST', '/api/exec', { maps: 'all', command: 'SaveWorld' })).json() as Array<{ response: string }>;
    assert.equal(res[0].response, 'World Saved');
    assert.equal((await call(mod, 'GET', '/api/audit')).status, 403);
    assert.equal((await call(boss, 'GET', '/api/audit')).status, 200);
    // moderator may not create a saved command for the console permission; admin may, moderator may run it
    assert.equal((await call(mod, 'POST', '/api/commands', { name: 'save', template: 'SaveWorld', permission: 'commands.run' })).status, 403);
    const created = await (await call(boss, 'POST', '/api/commands', { name: 'Punkte', template: 'ScriptCommand TCsAR AddArcTotal {{param.steamId}} {{param.points}}',
      params: [{ name: 'steamId', type: 'steamId' }, { name: 'points', type: 'number' }] })).json() as { id: number };
    const run = await call(mod, 'POST', `/api/commands/${created.id}/run`, { params: { steamId: '76561198000000005', points: '5' } });
    assert.equal(run.status, 200);
    assert.ok(ark.commands.includes('ScriptCommand TCsAR AddArcTotal 76561198000000005 5'));
    // a crash command cannot be saved
    assert.equal((await call(boss, 'POST', '/api/commands', { name: 'x', template: 'GetTribeIdPlayerList {{param.t}}' })).status, 400);
    // token for the portal, acting for one of its users
    const tok = await (await fetch(`${base}/api/users/portal/token`, { method: 'POST', headers: { cookie: `arkm_session=${boss}`, 'x-arkm': '1' } })).json() as { error?: string };
    assert.match(String(tok.error), /permission users/, 'admin may not create tokens');
    await store.saveUser({ name: 'portal', role: 'moderator', tokenHash: (await import('../src/manager/auth.ts')).tokenHash('arkm_testtoken') });
    const viaToken = await fetch(`${base}/api/broadcast`, { method: 'POST', headers: { authorization: 'Bearer arkm_testtoken', 'x-arkm-on-behalf-of': 'Jörg (Discord)', 'content-type': 'application/json' },
      body: JSON.stringify({ maps: 'all', text: 'vom Portal' }) });
    assert.equal(viaToken.status, 200, 'tokens need no CSRF header');
    assert.ok((await store.auditLog({})).some((a) => a.actor === 'portal:Jörg (Discord)' && a.action === 'broadcast'));
    // event stream delivers events
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/api/stream`, { headers: { cookie: `arkm_session=${mod}` }, signal: ctrl.signal });
    const reader = stream.body!.getReader();
    ark.writeLog('SERVER: stream test');
    let text = '';
    const deadline = Date.now() + 3000;
    while (!text.includes('stream test') && Date.now() < deadline) {
      const { value } = await reader.read();
      text += new TextDecoder().decode(value);
    }
    ctrl.abort();
    assert.match(text, /event: event[\s\S]*stream test/);
  } finally {
    web.close();
    await done();
  }
});

test('arkmanager discovery: excludes by prefix, password change is picked up from the instance file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arkm-cfg-'));
  const ark = new FakeArk('old-pw');
  const port = await ark.start();
  let store: Store | undefined;
  let manager: Manager | undefined;
  try {
    const write = (pw: string) => writeFileSync(join(dir, 'islandPVE.cfg'), `ark_RCONPort="${port}"\nark_ServerAdminPassword="${pw}"\nark_SessionName="Island"\n`);
    write('old-pw');
    writeFileSync(join(dir, 'claude-cmdtest.cfg'), 'ark_RCONPort="1"\nark_ServerAdminPassword="x"\n');
    writeFileSync(join(dir, 'bitch.cfg'), 'ark_RCONPort="2"\nark_ServerAdminPassword="x"\narkUpdateOnly="true"\n');
    const config = buildConfig({ database: `sqlite:${join(dir, 'm.sqlite')}`, arkmanager: { instances: dir, exclude: ['claude-*'], defaults: { role: 'live' } }, pollSeconds: 3600 }, dir);
    assert.deepEqual(config.maps.map((m) => m.name), ['islandPVE']);
    assert.equal(config.maps[0].externalBufferReader, true, 'live maps assume BattleMetrics until told otherwise');
    store = new Store(await openDb(config.database));
    manager = new Manager(config, store);
    await manager.start();
    await manager.pollAll();
    assert.equal(manager.mapsStatus()[0].status, 'online', manager.mapsStatus()[0].error ?? '');
    // password rotated: the map restarts with the new one, the file is updated
    ark.password = 'new-pw';
    ark.crash();
    ark.revive();
    write('new-pw');
    await manager.pollAll();                                  // auth fails, new password read from the file
    await manager.pollAll();                                  // retry with it
    assert.equal(manager.mapsStatus()[0].status, 'online', manager.mapsStatus()[0].error ?? '');
  } finally {
    await manager?.stop();
    await store?.db.close();
    await ark.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
