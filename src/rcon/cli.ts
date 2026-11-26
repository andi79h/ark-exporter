// ark-rcon: RCON service for ARK servers (console, players, chat/game log, bans, schedules, triggers, web UI).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig, type RconConfig } from './config.ts';
import { openDb } from './db.ts';
import { Store } from './store.ts';
import { RconService, type Actor } from './service.ts';
import { WebServer } from './web.ts';
import { checkCommand } from './policy.ts';
import { hashPassword, isRole, newSecret, tokenHash } from './auth.ts';

const USAGE = `ark-rcon <command> [options]

  run                      start the service and its web interface
  maps                     list the configured maps (without passwords)
  check "<command>"        show whether a command may be sent over RCON and why
  exec <map|all> "<cmd>"   send one command through the safety check (--force for untested commands on live maps)
  user add <name> --role <viewer|moderator|admin|superadmin> [--password <pw>]
  user list | user token <name> | user disable <name> | user enable <name> | user delete <name>
  bans import <BanList.txt> --reason <text>   import SteamIDs (one per line) as permanent bans
  bans export              print the SteamIDs of all active bans (BanList.txt format)

options:
  --config <file>   configuration (default /etc/ark-rcon/config.json or $ARK_RCON_CONFIG)
`;

function log(text: string): void {
  process.stderr.write(`${new Date().toISOString()} ${text}\n`);
}

async function open(configPath: string): Promise<{ config: RconConfig; store: Store }> {
  const config = loadConfig(configPath);
  const store = new Store(await openDb(config.database));
  await store.init();
  return { config, store };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' }, role: { type: 'string' }, password: { type: 'string' }, reason: { type: 'string' },
      force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help) { process.stdout.write(USAGE); return cmd ? 0 : 1; }
  const configPath = values.config ?? process.env.ARK_RCON_CONFIG ?? '/etc/ark-rcon/config.json';

  if (cmd === 'check') {
    const r = checkCommand(args.join(' '));
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return r.ok ? 0 : 2;
  }

  const { config, store } = await open(configPath);
  try {
    switch (cmd) {
      case 'maps':
        for (const m of config.maps) {
          process.stdout.write(`${m.name}\t${m.host}:${m.rconPort}\t${m.role}\tlog=${m.logSource}${m.logDir ? `:${m.logDir}` : ''}\tchatlog=${m.chatLogSource}${m.chatLogSource === 'file' && m.chatLogDir ? `:${m.chatLogDir}` : ''}\texternalBufferReader=${m.externalBufferReader}\t${m.title}\n`);
        }
        return 0;

      case 'run': {
        const service = new RconService(config, store);
        service.on('warning', (w: string) => log(`warning: ${w}`));
        service.on('status', (s: { map: string; status: string; error: string | null }) => log(`${s.map}: ${s.status}${s.error ? ` (${s.error})` : ''}`));
        await service.start();
        const web = new WebServer(service);
        await web.listen(config.web.listen);
        log(`ark-rcon: ${config.maps.length} maps, web interface on http://${config.web.listen}`);
        const shutdown = async () => {
          log('stopping');
          web.close();
          await service.stop();
          await store.db.close();
          process.exit(0);
        };
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
        await new Promise(() => undefined);
        return 0;
      }

      case 'exec': {
        const [target, ...rest] = args;
        if (!target || !rest.length) { process.stderr.write(USAGE); return 1; }
        const service = new RconService(config, store);
        const actor: Actor = { name: `cli:${process.env.SUDO_USER ?? process.env.USER ?? '?'}`, type: 'cli', role: 'superadmin' };
        const results = await service.exec(actor, target === 'all' ? 'all' : target.split(','), rest.join(' '), { force: values.force });
        for (const r of results) process.stdout.write(`${r.map}: ${r.ok ? (r.response || '(no response)') : `ERROR ${r.error}`}\n`);
        await service.stop();
        return results.every((r) => r.ok) ? 0 : 2;
      }

      case 'user': {
        const [sub, name] = args;
        if (sub === 'list') {
          for (const u of await store.users()) {
            process.stdout.write(`${u.name}\t${u.role}${u.disabled ? '\tdisabled' : ''}${u.token_hash ? '\ttoken' : ''}\n`);
          }
          return 0;
        }
        if (!name) { process.stderr.write(USAGE); return 1; }
        const actor = `cli:${process.env.SUDO_USER ?? process.env.USER ?? '?'}`;
        if (sub === 'add') {
          const role = values.role ?? 'viewer';
          if (!isRole(role)) { process.stderr.write(`unknown role ${role}\n`); return 1; }
          const password = values.password ?? newSecret(12);
          await store.saveUser({ name, role, passwordHash: await hashPassword(password), disabled: false });
          await store.audit({ actor, actorType: 'cli', action: 'user-save', target: name, detail: { role }, result: 'ok' });
          process.stdout.write(values.password ? `user ${name} (${role}) saved\n` : `user ${name} (${role}) saved, password: ${password}\n`);
          return 0;
        }
        const u = await store.user(name);
        if (!u) { process.stderr.write(`no user ${name}\n`); return 1; }
        if (sub === 'token') {
          const token = `arkrcon_${newSecret(32)}`;
          await store.saveUser({ name, role: u.role, tokenHash: tokenHash(token) });
          await store.audit({ actor, actorType: 'cli', action: 'user-token', target: name, result: 'ok' });
          process.stdout.write(`${token}\n`);
          return 0;
        }
        if (sub === 'disable' || sub === 'enable') {
          await store.saveUser({ name, role: u.role, disabled: sub === 'disable' });
          await store.audit({ actor, actorType: 'cli', action: `user-${sub}`, target: name, result: 'ok' });
          return 0;
        }
        if (sub === 'delete') {
          await store.deleteUser(name);
          await store.audit({ actor, actorType: 'cli', action: 'user-delete', target: name, result: 'ok' });
          return 0;
        }
        process.stderr.write(USAGE);
        return 1;
      }

      case 'bans': {
        const [sub, file] = args;
        if (sub === 'export') {
          for (const b of await store.activeBans()) process.stdout.write(`${b.steam_id}\n`);
          return 0;
        }
        if (sub === 'import' && file) {
          const existing = new Set((await store.activeBans()).map((b) => b.steam_id));
          let added = 0;
          for (const id of readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim().split(/[\s,;]/)[0])) {
            if (!/^\d{17}$/.test(id) || existing.has(id)) continue;
            await store.addBan({ steamId: id, reason: values.reason ?? `import ${file}`, by: 'import', expiresTs: null });
            existing.add(id);
            added++;
          }
          await store.audit({ actor: `cli:${process.env.USER ?? '?'}`, actorType: 'cli', action: 'ban-import', target: file, detail: { added }, result: 'ok' });
          process.stdout.write(`${added} bans imported\n`);
          return 0;
        }
        process.stderr.write(USAGE);
        return 1;
      }

      default:
        process.stderr.write(USAGE);
        return 1;
    }
  } finally {
    if (cmd !== 'run') await store.db.close();
  }
}

main().then((code) => { if (code !== 0 || process.argv[2] !== 'run') process.exit(code); }, (err) => {
  log(`error: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
