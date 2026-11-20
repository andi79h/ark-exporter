// Source-RCON client with the quirks of ARK: Survival Evolved (measured on build 358.24):
// - every answer is ONE packet, also when it is larger than 4 KB (no split, no terminator packet)
// - the server sends "Keep Alive" packets on its own while idle
// - a wrong password is answered with id -1, after that the server stays silent
// - commands longer than ~490 bytes make the server drop the connection without executing anything
// - input is not read as UTF-8: non-ASCII characters arrive as "?" (chat, names)
// - an empty answer is the text "Server received, But no response!!"
import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXEC = 2;
const TYPE_RESPONSE = 0;

/** Longest command line we send. The server drops the connection somewhere between 487 and 495 bytes. */
export const MAX_COMMAND_BYTES = 480;
export const NO_RESPONSE = 'Server received, But no response!!';

export class RconError extends Error {
  readonly kind: 'offline' | 'auth' | 'timeout' | 'closed' | 'protocol' | 'invalid';
  constructor(kind: RconError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface RconOptions {
  host: string;
  port: number;
  password: string;
  /** Connect and answer timeout in ms (default 5000). */
  timeoutMs?: number;
}

interface Pending {
  id: number;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Encodes one RCON packet. */
export function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'latin1');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

export interface Packet { id: number; type: number; body: string }

/** Splits a byte stream into packets; returns the packets and the unconsumed rest. */
export function decodePackets(data: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let pos = 0;
  while (data.length - pos >= 4) {
    const size = data.readInt32LE(pos);
    if (size < 10 || size > 16 * 1024 * 1024) throw new RconError('protocol', `implausible packet size ${size}`);
    if (data.length - pos - 4 < size) break;
    const id = data.readInt32LE(pos + 4);
    const type = data.readInt32LE(pos + 8);
    let end = pos + 4 + size;
    while (end > pos + 12 && data[end - 1] === 0) end--;
    // ARK answers are 8-bit; the server replaces non-ASCII by '?', so latin1 is lossless here
    packets.push({ id, type, body: data.subarray(pos + 12, end).toString('latin1') });
    pos += 4 + size;
  }
  return { packets, rest: data.subarray(pos) };
}

/** Checks that a command can be sent at all: ASCII only, no line breaks, short enough. */
export function validateCommandLine(line: string): string | null {
  if (!line.trim()) return 'empty command';
  if (/[\r\n\0]/.test(line)) return 'line breaks are not allowed';
  if (/[^\x20-\x7e]/.test(line)) return 'only ASCII characters are allowed (ARK turns everything else into "?")';
  if (Buffer.byteLength(line, 'latin1') > MAX_COMMAND_BYTES) return `command longer than ${MAX_COMMAND_BYTES} bytes`;
  return null;
}

/**
 * One RCON connection. Commands are sent one after the other; each waits for the packet
 * carrying its id. Events: 'close' (error?: Error).
 */
export class RconClient extends EventEmitter {
  readonly options: Required<RconOptions>;
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 10;
  private pending: Pending | null = null;
  private queue: Array<() => void> = [];
  private authed = false;

  constructor(options: RconOptions) {
    super();
    this.options = { timeoutMs: 5000, ...options };
  }

  get connected(): boolean { return this.authed && this.socket !== null && !this.socket.destroyed; }

  async connect(): Promise<void> {
    if (this.connected) return;
    const { host, port, password, timeoutMs } = this.options;
    const socket = new Socket();
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new RconError('offline', `connect timeout ${host}:${port}`)); }, timeoutMs);
      socket.once('error', (err) => { clearTimeout(timer); reject(new RconError('offline', err.message)); });
      socket.connect(port, host, () => { clearTimeout(timer); resolve(); });
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.shutdown(new RconError('closed', err.message)));
    socket.on('close', () => this.shutdown(new RconError('closed', 'connection closed')));
    const authId = 1;
    const answer = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RconError('timeout', 'no answer to login')), timeoutMs);
      this.pending = {
        id: -2,
        timer,
        resolve: (idText) => { clearTimeout(timer); resolve(Number(idText)); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
    });
    socket.write(encodePacket(authId, TYPE_AUTH, password));
    let id: number;
    try {
      id = await answer;
    } catch (err) {
      this.pending = null;
      socket.destroy();
      throw err;
    }
    this.pending = null;
    if (id !== authId) {
      socket.destroy();
      throw new RconError('auth', 'RCON password rejected');
    }
    this.authed = true;
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let packets: Packet[];
    try {
      ({ packets, rest: this.buffer } = decodePackets(this.buffer));
    } catch (err) {
      this.socket?.destroy();
      this.shutdown(err as Error);
      return;
    }
    for (const p of packets) {
      const pending = this.pending;
      if (!pending) continue;                                     // keep-alive or late answer
      if (pending.id === -2) {                                    // login: wait for the auth response
        if (p.type === TYPE_AUTH_RESPONSE) { this.pending = null; pending.resolve(String(p.id)); }
        continue;
      }
      if (p.type !== TYPE_RESPONSE || p.id !== pending.id) continue;
      if (p.body.trim() === 'Keep Alive') continue;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(p.body);
      this.queue.shift()?.();
    }
  }

  private shutdown(err: Error): void {
    const wasOpen = this.socket !== null;
    this.authed = false;
    this.socket = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(err); }
    const queued = this.queue;
    this.queue = [];
    for (const next of queued) next();                            // they fail fast on the closed socket
    if (wasOpen) this.emit('close', err);
  }

  /**
   * Sends one command and returns the raw answer text (trailing whitespace removed;
   * "Server received, But no response!!" becomes the empty string).
   */
  exec(command: string): Promise<string> {
    const invalid = validateCommandLine(command);
    if (invalid) return Promise.reject(new RconError('invalid', invalid));
    return new Promise((resolve, reject) => {
      const run = () => {
        if (!this.connected || !this.socket) { reject(new RconError('closed', 'not connected')); return; }
        const id = this.nextId++;
        if (this.nextId > 0x7ffffff0) this.nextId = 10;
        const timer = setTimeout(() => {
          if (this.pending?.id !== id) return;
          // the answer may still arrive later and would then belong to the next command: start over
          this.pending = null;
          reject(new RconError('timeout', `no answer to "${command.split(' ')[0]}"`));
          this.socket?.destroy();
        }, this.options.timeoutMs);
        this.pending = {
          id, timer,
          resolve: (body) => {
            const text = body.replace(/\s+$/, '');
            resolve(text === NO_RESPONSE ? '' : text);
          },
          reject,
        };
        this.socket.write(encodePacket(id, TYPE_EXEC, command));
      };
      if (this.pending) this.queue.push(run); else run();
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}

export interface ListedPlayer { name: string; steamId: string }

/** Parses the answer of ListPlayers: "0. Name, 76561198000000000" per line; names may contain commas. */
export function parseListPlayers(text: string): ListedPlayer[] {
  const players: ListedPlayer[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\d+\.\s+(.*),\s*(\d{5,})\s*$/.exec(line);
    if (m && m[1].trim()) players.push({ name: m[1].trim(), steamId: m[2] });
  }
  return players;
}

/** ARK replaces each non-ASCII character by "?". German umlauts get a readable form instead. */
export function toArkAscii(text: string): string {
  const map: Record<string, string> = {
    ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', '€': 'EUR', '„': '"', '“': '"', '”': '"',
    '‚': "'", '‘': "'", '’': "'", '–': '-', '—': '-', '…': '...', ' ': ' ',
  };
  return text
    .replace(/[äöüÄÖÜß€„“”‚‘’–—… ]/g, (c) => map[c])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}
