// JSON chat log (LogChatMessages=True) of ASE and ASA: parser, folder follower, duplicates with the ServerGame log,
// and the way through the service. The files are built like the ones the servers write (ASE 358.24 on Linux:
// LF, BOM, one-line SenderLocation, Timestamp; ASA: CRLF, multi-line SenderLocation, no Timestamp, EOS ID).
// IDs and names are made up.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ChatDeduplicator, ChatLogFollower, chatLineKey, chatLogFileKey, keepChatLogEntry, parseChatLogFile, splitJsonObjects,
  type ChatLogItem, type ChatLogState,
} from '../src/rcon/chatlog.ts';
import { parseLogLine } from '../src/rcon/gamelog.ts';
import { buildConfig } from '../src/rcon/config.ts';
import { openDb } from '../src/rcon/db.ts';
import { Store } from '../src/rcon/store.ts';
import { RconService } from '../src/rcon/service.ts';
import { FakeArk } from './fake-ark.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await wait(20); }
  throw new Error('condition not reached');
}

const STEAM_A = '76561198000000011';
const STEAM_B = '76561198000000012';
const EOS_A = '0002a1b2c3d4e5f60718293a4b5c6d7e';

interface Msg { mode: string; text: string; steamId?: string; name?: string; character?: string; tribe?: string; tribeId?: number; playerId?: number; ts?: string }

function obj(fields: Array<[string, unknown]>, asa: boolean): string {
  const body = fields.map(([k, v]) => {
    const value = Array.isArray(v) ? (asa ? JSON.stringify(v, null, '\t').replace(/\n/g, '\n\t') : `[ ${v.join(', ')} ]`) : JSON.stringify(v);
    return `\t"${k}": ${value}`;
  }).join(',\n');
  return `{\n${body}\n}`;
}

/** A chat log file as the server writes it; `open` = the current file, before the server closes it. */
function chatFile(opts: { asa?: boolean; fileTs: string; map?: string; open?: boolean; msgs: Msg[] }): string {
  const asa = Boolean(opts.asa);
  const meta = obj([['Metadata', true], ['ServerName', asa ? 'Demo x' : '[TEST] Demo - x'], ['MapName', opts.map ?? (asa ? 'TheIsland_WP' : 'TheIsland')],
    ['FileTimestamp', opts.fileTs], ['COMPUTERNAME', asa ? 'WIN-TEST' : ''], ['ARK_SERVERNAME', '']], asa);
  const entries = opts.msgs.map((m) => obj([
    ['SenderName', m.character ?? 'Annie'], ['SenderSteamName', m.name ?? 'Anna'], ['SenderSteamId', m.steamId ?? (asa ? EOS_A : STEAM_A)],
    ['SenderTribeName', m.tribe ?? (asa ? '' : 'Kieselstein')], ['SenderTribeID', m.tribeId ?? (asa ? -1 : 1234567890)],
    ['SenderTeamIndex', m.tribeId ?? 1234567890], ['SenderId', m.playerId ?? 40000001], ['SenderLocation', [-3163.65, 265982.06, -11135.18]],
    ['Message', m.text], ...(asa ? [] : [['Timestamp', m.ts ?? '2026-11-25T06:10:56.441Z'] as [string, unknown]]), ['SendMode', m.mode],
    ['SenderIcon', asa ? '' : 'Admin'],
  ], asa));
  let text = `[\n${[meta, ...entries].join(',\n')},\n${opts.open ? '' : '\n{}\n]'}`;
  if (asa) text = text.replace(/\n/g, '\r\n');
  return asa ? text : `﻿${text}`;
}

test('chat log files: ASE and ASA format, open and cut-off files', () => {
  const ase = parseChatLogFile(chatFile({ fileTs: '2026-11-25T06:11:02.963Z', msgs: [
    { mode: 'GlobalChat', text: '!chattest-global eins', ts: '2026-11-25T06:10:56.441Z' },
    { mode: 'LocalChat', text: 'servus', ts: '2026-11-25T06:11:21.599Z' },
    { mode: 'AllianceChat', text: '!online', ts: '2026-11-25T06:11:29.919Z' },
    { mode: 'GlobalTribeChat', text: 'wir treffen uns am Turm', ts: '2026-11-25T06:11:30.000Z' },
  ] }));
  assert.equal(ase.fileTs, '2026-11-25T06:11:02.963Z');
  assert.equal(ase.mapName, 'TheIsland');
  assert.equal(ase.complete, true);
  assert.deepEqual(ase.entries.map((e) => e.channel), ['global', 'local', 'alliance', 'tribe']);
  const [g] = ase.entries;
  assert.deepEqual([g.ts, g.senderId, g.name, g.character, g.tribe, g.tribeId, g.playerId, g.message],
    [Date.UTC(2026, 10, 25, 6, 10, 56, 441), STEAM_A, 'Anna', 'Annie', 'Kieselstein', '1234567890', '40000001', '!chattest-global eins']);

  // privacy filter: public chat always, of tribe and alliance chat only commands
  assert.deepEqual(ase.entries.map(keepChatLogEntry), [true, true, true, false]);
  assert.equal(keepChatLogEntry({ ...ase.entries[3], message: '  !online' }), true);
  assert.equal(keepChatLogEntry({ ...ase.entries[3], channel: null, sendMode: 'SomethingNew', message: 'hallo' }), false, 'unknown channel counts as private');

  // ASA: CRLF, no Timestamp, EOS ID, no tribe (-1), the current file is still open
  const asa = parseChatLogFile(chatFile({ asa: true, open: true, fileTs: '2026-11-25T23:44:02.275Z', msgs: [
    { mode: 'AllianceChat', text: '!chattest-ally drei' },
    { mode: 'LocalChat', text: '!chattest-local vier' },
  ] }));
  assert.equal(asa.complete, false);
  assert.equal(asa.fileTs, '2026-11-25T23:44:02.275Z');
  assert.deepEqual(asa.entries.map((e) => [e.channel, e.ts, e.senderId, e.tribeId, e.tribe]),
    [['alliance', null, EOS_A, null, null], ['local', null, EOS_A, null, null]]);

  // cut off in the middle of a write: only complete entries; braces and quotes inside strings do not confuse it
  const tricky = chatFile({ fileTs: '2026-11-25T06:12:00.000Z', msgs: [
    { mode: 'GlobalChat', text: 'a "}" {[ b \\ c' },
    { mode: 'GlobalChat', text: 'zweite Zeile' },
  ] });
  const full = parseChatLogFile(tricky);
  assert.equal(full.entries[0].message, 'a "}" {[ b \\ c');
  const cut = parseChatLogFile(tricky.slice(0, tricky.indexOf('zweite')));
  assert.deepEqual(cut.entries.map((e) => e.message), ['a "}" {[ b \\ c']);
  assert.equal(cut.complete, false);
  assert.deepEqual(parseChatLogFile('').entries, []);
  assert.deepEqual(parseChatLogFile('[\n{\n\t"Metad').entries, []);
  assert.equal(splitJsonObjects('[{"a":1},\n{}\n]').closed, true);
  // a malformed sender ID is not used
  assert.equal(parseChatLogFile(chatFile({ fileTs: 'x', msgs: [{ mode: 'GlobalChat', text: 'x', steamId: '123' }] })).entries[0].senderId, null);

  // file names: UTC, hour and minute without leading zero
  assert.equal(chatLogFileKey('ChatLog_2026-11-25_6-11_TheIsland.json'), '202611250611');
  assert.ok(chatLogFileKey('ChatLog_2026-11-25_9-59_TheIsland.json')! < chatLogFileKey('ChatLog_2026-11-25_10-0_TheIsland.json')!);
  assert.equal(chatLogFileKey('ChatLog_2026-11-25_23-43_BobsMissions_WP.json'), '202611252343');
  assert.equal(chatLogFileKey('ServerGame.1.2026.11.25_06.11.02.log'), null);

  // the same message in both logs gives the same key, also for "(" in a name and the ASA shadow-mute prefix
  const line = parseLogLine('[2026.11.25-06.10.56:441][721]2026.11.25_06.10.56: Anna (Annie): !chattest-global eins')!;
  assert.equal(chatLineKey(line.name!, line.character!, line.text), chatLineKey(g.name, g.character, g.message));
  const odd = parseLogLine('[2026.11.25-06.10.56:441][721]2026.11.25_06.10.56: Bo (x) (Bob): hi')!;
  assert.equal(chatLineKey(odd.name!, odd.character!, odd.text), chatLineKey('Bo (x)', 'Bob', 'hi'));
  const muted = parseLogLine('[2026.11.25-06.10.56:441][721]2026.11.25_06.10.56: [ShadowMuted] Anna (Annie): hi')!;
  assert.equal(chatLineKey(muted.name!, muted.character!, muted.text), chatLineKey('Anna', 'Annie', 'hi'));
});

test('chat log follower: start at the end, rewrites, new files, privacy, resume, pruning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ark-rcon-chatlog-'));
  const dir = join(root, 'ChatLogs');
  const session = join(dir, 'TESTDemox');
  const file = (name: string) => join(session, name);
  const B = 'ChatLog_2026-11-25_9-59_TheIsland.json';
  const C = 'ChatLog_2026-11-25_10-0_TheIsland.json';
  try {
    // the folder does not exist yet (chat log just switched on): no error
    const items: ChatLogItem[] = [];
    let state: ChatLogState | null = null;
    const f = new ChatLogFollower(dir, null, 20);
    f.on('entry', (i: ChatLogItem) => items.push(i));
    f.on('state', (s: ChatLogState) => { state = s; });
    await f.poll();
    mkdirSync(session, { recursive: true });
    writeFileSync(file('ChatLog_2026-11-25_9-58_TheIsland.json'), chatFile({ fileTs: '2026-11-25T09:58:01.000Z', msgs: [{ mode: 'GlobalChat', text: 'erste' }] }));
    await f.poll();
    assert.deepEqual(items.map((i) => i.entry.message), ['erste'], 'files that appear after the start are read from their beginning');

    // a second follower that starts now skips what is there
    const g = new ChatLogFollower(dir, null, 20);
    const gItems: ChatLogItem[] = [];
    g.on('entry', (i: ChatLogItem) => gItems.push(i));
    writeFileSync(file(B), chatFile({ open: true, fileTs: '2026-11-25T09:59:02.000Z', msgs: [{ mode: 'GlobalChat', text: 'zwei' }] }));
    await g.poll();
    assert.equal(gItems.length, 0, 'starts at the end');

    // the server rewrites the open file with more entries: only new ones, tribe chat only as command
    writeFileSync(file(B), chatFile({ open: true, fileTs: '2026-11-25T09:59:02.000Z', msgs: [
      { mode: 'GlobalChat', text: 'zwei' }, { mode: 'GlobalTribeChat', text: 'geheimer Plan' }, { mode: 'GlobalTribeChat', text: '!online' },
    ] }));
    await g.poll();
    await g.poll();
    assert.deepEqual(gItems.map((i) => [i.entry.message, i.index, i.file]), [['!online', 2, `TESTDemox/${B}`]]);

    // read while the server is writing: fewer entries than before, nothing is lost or repeated
    const four = chatFile({ fileTs: '2026-11-25T09:59:02.000Z', msgs: [
      { mode: 'GlobalChat', text: 'zwei' }, { mode: 'GlobalTribeChat', text: 'geheimer Plan' }, { mode: 'GlobalTribeChat', text: '!online' }, { mode: 'LocalChat', text: 'vier' },
    ] });
    writeFileSync(file(B), four.slice(0, four.indexOf('geheimer')));
    await g.poll();
    writeFileSync(file(B), four);
    await g.poll();
    assert.deepEqual(gItems.map((i) => i.entry.message), ['!online', 'vier']);

    // the next file (10-0 sorts after 9-59), then a new file under the same name (another FileTimestamp)
    writeFileSync(file(C), chatFile({ open: true, fileTs: '2026-11-25T10:00:01.000Z', msgs: [{ mode: 'GlobalChat', text: 'fünf' }, { mode: 'AllianceChat', text: '!bauteile' }] }));
    await g.poll();
    writeFileSync(file(C), chatFile({ open: true, fileTs: '2026-11-25T10:00:50.000Z', msgs: [{ mode: 'GlobalChat', text: 'sechs' }] }));
    await g.poll();
    assert.deepEqual(gItems.map((i) => i.entry.message), ['!online', 'vier', 'fünf', '!bauteile', 'sechs']);

    // the state holds counts, no chat text
    const saved: ChatLogState = g.snapshot();
    assert.ok(!JSON.stringify(saved).includes('geheim'));
    assert.equal(saved.files[`TESTDemox/${C}`].n, 1);

    // resume after a restart of the service: only what came since
    writeFileSync(file(C), chatFile({ fileTs: '2026-11-25T10:00:50.000Z', msgs: [{ mode: 'GlobalChat', text: 'sechs' }, { mode: 'GlobalChat', text: 'sieben' }] }));
    const h = new ChatLogFollower(dir, saved, 20);
    const hItems: ChatLogItem[] = [];
    h.on('entry', (i: ChatLogItem) => hItems.push(i));
    await h.poll();
    assert.deepEqual(hItems.map((i) => i.entry.message), ['sieben']);

    // many files: the state keeps only the newest, older ones are not read again
    for (let m = 1; m <= 15; m++) writeFileSync(file(`ChatLog_2026-11-25_10-${m}_TheIsland.json`), chatFile({ fileTs: `2026-11-25T10:${String(m).padStart(2, '0')}:00.000Z`, msgs: [{ mode: 'GlobalChat', text: `m${m}` }] }));
    await h.poll();
    assert.equal(hItems.length, 16);
    const pruned = h.snapshot();
    assert.ok(Object.keys(pruned.files).length <= 12);
    assert.ok(pruned.horizon >= '202611251003');
    const again = new ChatLogFollower(dir, pruned, 20);
    const againItems: ChatLogItem[] = [];
    again.on('entry', (i: ChatLogItem) => againItems.push(i));
    await again.poll();
    assert.equal(againItems.length, 0);
    assert.ok(readdirSync(session).length > 12);
    void state;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicates: first copy wins, by time on ASE, by arrival on ASA, repeats are kept', () => {
  const d = new ChatDeduplicator(120_000, 2000);
  const k = chatLineKey('Anna', 'Annie', '!online');
  const t = Date.UTC(2026, 10, 25, 6, 10, 56, 441);
  // ASE: same millisecond in both logs; the same command again 20 s later is a new message
  assert.equal(d.isDuplicate('log', k, t, 1000), false);
  assert.equal(d.isDuplicate('log', k, t + 20_000, 21_000), false);
  assert.equal(d.isDuplicate('chatlog', k, t, 16_000), true);
  assert.equal(d.isDuplicate('chatlog', k, t + 20_000, 36_000), true);
  assert.equal(d.isDuplicate('chatlog', k, t + 40_000, 56_000), false, 'nothing left to match: a new line');
  // chat log first, log line later
  assert.equal(d.isDuplicate('log', k, t + 40_000, 57_000), true);
  // ASA: the chat log has no time, the arrival decides
  const a = chatLineKey('Bob', 'Bobby', 'hi');
  assert.equal(d.isDuplicate('log', a, t, 100_000), false);
  assert.equal(d.isDuplicate('chatlog', a, null, 117_000), true);
  assert.equal(d.isDuplicate('log', a, t + 1, 200_000), false);
  assert.equal(d.isDuplicate('chatlog', a, null, 400_000), false, 'too late: not the same line');
});

test('service: chat log as second source (ASE and ASA entries, triggers, duplicates, privacy, Discord)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ark-rcon-chat-'));
  const logFile = join(dir, 'ServerGame.1.2026.11.20_04.00.00.log');
  writeFileSync(logFile, '﻿[2026.11.20-04.00.00:000][ 1]Log file open\n');
  const session = join(dir, 'ChatLogs', 'TESTDemotestmap');
  mkdirSync(session, { recursive: true });
  const ark = new FakeArk('pw');
  ark.logFile = logFile;
  const port = await ark.start();
  const posted: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => { posted.push(JSON.parse(init.body).content); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
  const config = buildConfig({
    database: `sqlite:${join(dir, 'm.sqlite')}`,
    maps: [{ name: 'testmap', title: 'Test', rconPort: port, password: 'pw', logDir: dir, chatLogSource: 'file', role: 'test', externalBufferReader: false }],
    pollSeconds: 3600,
    discord: { webhooks: { chat: 'https://discord.invalid/hook' }, routes: { chat: 'chat' } },
  }, dir);
  assert.equal(config.maps[0].chatLogDir, join(dir, 'ChatLogs'), 'default: ChatLogs next to the game log');
  const store = new Store(await openDb(config.database));
  const service = new RconService(config, store, { fetchImpl });
  const warnings: string[] = [];
  service.on('warning', (w: string) => warnings.push(w));
  try {
    await service.start();
    ark.players.push({ name: 'Anna', steamId: STEAM_A }, { name: 'Björn', steamId: STEAM_B });
    await service.pollAll();
    await store.save('mgr_triggers', null, { name: 'online', enabled: 1, event: 'chat', maps: null, cond: JSON.stringify({ match: '^!online' }),
      actions: JSON.stringify([{ type: 'message', text: 'Hallo {{player.name}}' }]), cooldown: 0, created_by: 't', updated: 0 });
    await service.reloadAutomation();
    const rt = service.maps.get('testmap')!;
    const chatLog = rt.chatLog!;
    const chats = () => store.events({ types: ['chat'] });

    // global chat in both logs (same millisecond): one event; the chat log copy repairs the "?" name from RCON
    const now = new Date();
    ark.writeLog('Björn (Bjö): hallo zusammen', now);
    await until(async () => (await chats()).length === 1);
    const f1 = 'ChatLog_2026-11-25_6-11_TheIsland.json';
    writeFileSync(join(session, f1), chatFile({ open: true, fileTs: now.toISOString(), msgs: [
      { mode: 'GlobalChat', text: 'hallo zusammen', name: 'Björn', character: 'Bjö', steamId: STEAM_B, playerId: 40000002, ts: now.toISOString() },
    ] }));
    await chatLog.poll();
    await wait(50);
    assert.equal((await chats()).length, 1, 'duplicate of the ServerGame line dropped');
    assert.equal(service.online().find((p) => p.steamId === STEAM_B)?.name, 'Björn');
    assert.equal((await store.player(STEAM_B))?.player_id, '40000002', 'ARK player ID from SenderId');

    // tribe chat: the command arrives with SteamID, tribe and channel and fires the trigger; the rest is not kept
    writeFileSync(join(session, f1), chatFile({ open: true, fileTs: now.toISOString(), msgs: [
      { mode: 'GlobalChat', text: 'hallo zusammen', name: 'Björn', character: 'Bjö', steamId: STEAM_B, playerId: 40000002, ts: now.toISOString() },
      { mode: 'GlobalTribeChat', text: 'unser geheimes Versteck', ts: new Date(now.getTime() + 1000).toISOString() },
      { mode: 'GlobalTribeChat', text: '!online', ts: new Date(now.getTime() + 2000).toISOString() },
    ] }));
    await chatLog.poll();
    await until(() => ark.commands.includes(`ServerChatTo "${STEAM_A}" Hallo Anna`));
    const tribe = (await chats()).find((e) => e.text === '!online')!;
    assert.equal(tribe.steam_id, STEAM_A);
    assert.equal(tribe.source, 'chatlog');
    assert.deepEqual(JSON.parse(tribe.data!), { channel: 'tribe', character: 'Annie', playerId: '40000001', tribe: 'Kieselstein', tribeId: '1234567890' });
    assert.equal(tribe.ts, now.getTime() + 2000);

    // ASA entry: no time, EOS ID as sender
    const f2 = 'ChatLog_2026-11-25_6-12_TheIsland.json';
    writeFileSync(join(session, f2), chatFile({ asa: true, fileTs: now.toISOString(), msgs: [{ mode: 'AllianceChat', text: '!bauteile', name: 'Cara', character: 'Ca' }] }));
    await chatLog.poll();
    await until(async () => (await chats()).some((e) => e.text === '!bauteile'));
    const asa = (await chats()).find((e) => e.text === '!bauteile')!;
    assert.equal(asa.steam_id, EOS_A);
    assert.equal(JSON.parse(asa.data!).tsEstimated, true);
    assert.ok(Math.abs(asa.ts - Date.now()) < 10_000);

    // nothing of the private line anywhere in the database
    const rows = await store.db.all<Record<string, unknown>>('SELECT * FROM mgr_events');
    const state = await store.db.all<Record<string, unknown>>('SELECT * FROM mgr_state');
    assert.ok(!JSON.stringify([rows, state]).includes('Versteck'));

    // Discord gets public chat, not the tribe and alliance commands
    await until(() => posted.length > 0);
    await wait(400);
    const relayed = posted.join('\n');
    assert.match(relayed, /hallo zusammen/);
    assert.doesNotMatch(relayed, /!online|!bauteile/);
    assert.equal(service.mapsStatus()[0].chatLogSource, 'file');
    assert.deepEqual(warnings, []);
  } finally {
    await service.stop();
    await ark.stop();
    await store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
