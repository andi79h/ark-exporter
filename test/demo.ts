// Local demo: three fake ARK servers with simulated players, chat and game log, plus the service and its web UI.
//   node test/demo.ts [port]        → http://127.0.0.1:8790, login demo / demo-password
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildConfig } from '../src/rcon/config.ts';
import { openDb } from '../src/rcon/db.ts';
import { Store } from '../src/rcon/store.ts';
import { RconService } from '../src/rcon/service.ts';
import { WebServer } from '../src/rcon/web.ts';
import { hashPassword } from '../src/rcon/auth.ts';
import { FakeArk } from './fake-ark.ts';

const port = Number(process.argv[2] ?? 8790);
const root = mkdtempSync(join(tmpdir(), 'ark-rcon-demo-'));
const names = ['Jörg', 'Anna', 'Björn', 'Lys', 'Kalle', 'Mära', 'Tom', 'Zoë'];
const lines = ['hallo zusammen', 'wo finde ich Metall?', 'danke!', 'gn8', 'hat jemand Kibble übrig?', '!discord', 'Rex gezähmt :)'];
const maps = ['islandPVE', 'ragnarokPVE', 'claude-rcontest'];
const arks: FakeArk[] = [];
const mapConfigs = [];
for (const [i, name] of maps.entries()) {
  const dir = join(root, name);
  mkdirSync(dir);
  const logFile = join(dir, 'ServerGame.1.2026.11.20_04.00.00.log');
  writeFileSync(logFile, '﻿');
  const ark = new FakeArk('pw');
  ark.logFile = logFile;
  arks.push(ark);
  mapConfigs.push({ name, title: `[GER] Demo - ${name}`, rconPort: await ark.start(), password: 'pw', logDir: dir, role: i === 2 ? 'test' as const : 'live' as const });
}
const config = buildConfig({ database: `sqlite:${join(root, 'demo.sqlite')}`, maps: mapConfigs, pollSeconds: 3, web: { listen: `127.0.0.1:${port}` } }, root);
const store = new Store(await openDb(config.database));
await store.init();
await store.saveUser({ name: 'demo', role: 'superadmin', passwordHash: await hashPassword('demo-password') });
await store.save('mgr_triggers', null, { name: 'Discord-Hinweis', enabled: 1, event: 'chat', maps: null, cond: JSON.stringify({ match: '^!discord' }),
  actions: JSON.stringify([{ type: 'message', text: 'Unser Discord: siehe Webseite' }]), cooldown: 30, created_by: 'demo', updated: Date.now() });
await store.save('mgr_schedules', null, { name: 'Speichern', enabled: 1, cron: '*/30 * * * *', targets: null, actions: JSON.stringify([{ type: 'command', command: 'SaveWorld' }]),
  warnings: null, created_by: 'demo', updated: Date.now() });
await store.save('mgr_commands', null, { name: 'Treuepunkte', description: 'TCsAutoRewards-Punkte gutschreiben (je Karte)', template: 'ScriptCommand TCsAR AddArcTotal {{param.steamId}} {{param.points}}',
  params: JSON.stringify([{ name: 'steamId', type: 'steamId' }, { name: 'points', type: 'number' }]), permission: 'commands.run', targets: null, created_by: 'demo', updated: Date.now() });
const service = new RconService(config, store);
service.on('warning', (w: string) => console.error('warning', w));
await service.start();
const web = new WebServer(service);
await web.listen(config.web.listen);
console.log(`demo on http://${config.web.listen} (demo / demo-password), data in ${root}`);

let n = 0;
setInterval(() => {
  const ark = arks[n % arks.length];
  n++;
  const r = Math.random();
  if (r < 0.25 && ark.players.length < 4) {
    const free = names.filter((x) => !arks.some((a) => a.players.some((p) => p.name === x)));
    if (!free.length) return;
    const name = free[Math.floor(Math.random() * free.length)];
    ark.writeLog(`${name} joined this ARK!`);
    ark.players.push({ name, steamId: `7656119800000${String(1000 + names.indexOf(name)).padStart(4, '0')}` });
  } else if (r < 0.35 && ark.players.length) {
    const p = ark.players.shift()!;
    ark.writeLog(`${p.name} left this ARK!`);
  } else if (ark.players.length) {
    const p = ark.players[Math.floor(Math.random() * ark.players.length)];
    if (r < 0.85) ark.writeLog(`${p.name} (${p.name}chen): ${lines[Math.floor(Math.random() * lines.length)]}`);
    else ark.writeLog(`Tribe Demo, ID 123456: Day 12, 10:00:00: <RichColor Color="0, 1, 0, 1">${p.name} Tamed a Raptor - Lvl 150 (Raptor)!</>)`);
  }
}, 1500);
