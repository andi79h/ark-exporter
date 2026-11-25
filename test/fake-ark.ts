// A fake ASE RCON server that behaves like build 358.24 where it matters: one packet per answer,
// "Server received, But no response!!", id -1 on a wrong password, idle keep-alive packets,
// connection drop for over-long commands and for GetTribeIdPlayerList (crash), "?" for non-ASCII names,
// a draining chat buffer and a ban list.
import { createServer, type Server, type Socket } from 'node:net';
import { appendFileSync } from 'node:fs';
import { encodePacket, decodePackets, NO_RESPONSE } from '../src/rcon/rcon.ts';

export interface FakePlayer { name: string; steamId: string }

export class FakeArk {
  password: string;
  players: FakePlayer[] = [];
  chat: string[] = [];
  bans = new Set<string>();
  commands: string[] = [];
  crashed = false;
  /** If set, ServerChat lines are also written there like the server's game log. */
  logFile: string | null = null;
  private server: Server | null = null;
  private sockets = new Set<Socket>();

  constructor(password = 'secret') { this.password = password; }

  async start(): Promise<number> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()));
    return (this.server!.address() as { port: number }).port;
  }

  stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** Simulates a crash: all connections drop, new ones are refused until revive(). */
  crash(): void {
    this.crashed = true;
    for (const s of this.sockets) s.destroy();
  }

  revive(): void { this.crashed = false; }

  writeLog(message: string, ts = new Date()): void {
    if (!this.logFile) return;
    const d = ts.toISOString();
    const stamp = `${d.slice(0, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}-${d.slice(11, 13)}.${d.slice(14, 16)}.${d.slice(17, 19)}:${d.slice(20, 23)}`;
    const stamp2 = `${d.slice(0, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}_${d.slice(11, 13)}.${d.slice(14, 16)}.${d.slice(17, 19)}`;
    appendFileSync(this.logFile, `[${stamp}][123]${stamp2}: ${message}\n`);
  }

  sendKeepAlive(): void {
    for (const s of this.sockets) s.write(encodePacket(0, 0, 'Keep Alive'));
  }

  private accept(socket: Socket): void {
    if (this.crashed) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    let authed = false;
    let buf: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { packets, rest } = decodePackets(buf);
      buf = rest;
      for (const p of packets) {
        if (p.type === 3) {
          authed = p.body === this.password;
          socket.write(encodePacket(0, 0, ''));
          socket.write(encodePacket(authed ? p.id : -1, 2, ''));
          continue;
        }
        if (!authed) continue;
        if (Buffer.byteLength(p.body, 'latin1') > 490) { socket.destroy(); continue; }
        const answer = this.run(p.body, socket);
        if (answer === null) continue;
        socket.write(encodePacket(p.id, 0, answer || NO_RESPONSE));
      }
    });
  }

  private run(line: string, socket: Socket): string | null {
    this.commands.push(line);
    const [name, ...args] = line.split(' ');
    const rest = args.join(' ');
    switch (name.toLowerCase()) {
      case 'listplayers':
        if (!this.players.length) return 'No Players Connected ';
        return `${this.players.map((p, i) => `${i}. ${p.name.replace(/[^\x00-\x7f]/gu, '?')}, ${p.steamId}`).join('\n')}\n `;
      case 'getchat': {
        const lines = this.chat.splice(0);
        return lines.join('\n');
      }
      case 'serverchat':
        this.chat.push(`SERVER: ${rest}`);
        this.writeLog(`SERVER: ${rest}`);
        return '';
      case 'serverchatto':
        return '';
      case 'banplayer':
        this.bans.add(args[0]);
        this.players = this.players.filter((p) => p.steamId !== args[0]);
        return `${args[0]} Banned`;
      case 'unbanplayer':
        this.bans.delete(args[0]);
        return `${args[0]} Unbanned`;
      case 'kickplayer':
        this.players = this.players.filter((p) => p.steamId !== args[0]);
        return `${args[0]} Kicked`;
      case 'saveworld':
        return 'World Saved';
      case 'keepalivetest':
        return 'Keep Alive\nreal answer';
      case 'gettribeidplayerlist':
        this.crash();
        return null;
      default:
        return '';
    }
  }
}
