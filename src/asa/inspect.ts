// Coverage report for ARK: Survival Ascended saves: how much of each file is read structurally,
// what is kept raw, and what the reader ran into.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runtime } from '../sqlite.ts';
import { ReadContext } from '../types.ts';
import { enableAsaBytes, readAsaContainer } from './container.ts';
import { newCryoCoverage } from './cryopod.ts';
import { asaCoverage, readAsaSave } from './savegame.ts';

const SQLITE_MAGIC = 'SQLite format 3\0';

/** ASA world saves are SQLite databases; ASE saves start with an int16 version. */
export function isAsaWorld(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(16);
    readSync(fd, b, 0, 16, 0);
    return b.toString('latin1') === SQLITE_MAGIC;
  } finally {
    closeSync(fd);
  }
}

/** .arkprofile/.arktribe written by ASA: version 7 or the 0x1bedead marker, or a GUID at byte 8. */
export function isAsaContainer(buf: Buffer): boolean {
  if (buf.length < 24) return false;
  const v = buf.readInt32LE(0);
  if (v === 0x1bedead || v >= 7) return true;
  return v >= 5 && buf.subarray(8, 24).some((b) => b !== 0);
}

const sorted = (m: Map<string, number>, limit = Infinity): [string, number][] =>
  [...m].sort((x, y) => y[1] - x[1]).slice(0, limit);

const seconds = (t0: number): number => +((performance.now() - t0) / 1000).toFixed(2);

export interface ContainerSummary {
  files: number; empty: number; bytes: number; decoded: number; raw: number; failed: { file: string; error: string }[];
  decodedPercent: number; versions: Record<string, number>; issues: [string, number][]; rawBytes: [string, number][];
}

export function inspectContainers(files: string[]): ContainerSummary {
  const ctx = new ReadContext();
  const cryo = newCryoCoverage();
  enableAsaBytes(ctx, cryo);
  const sum: ContainerSummary = { files: 0, empty: 0, bytes: 0, decoded: 0, raw: 0, failed: [], decodedPercent: 0, versions: {}, issues: [], rawBytes: [] };
  for (const f of files) {
    const buf = readFileSync(f);
    sum.files++;
    sum.bytes += buf.length;
    if (buf.length === 0) {
      sum.empty++;
      continue;
    }
    try {
      const c = readAsaContainer(buf, ctx);
      sum.decoded += c.decoded;
      sum.raw += buf.length - c.decoded;
      const v = `${c.version}${c.marker ? ' (0x1bedead)' : ''}`;
      sum.versions[v] = (sum.versions[v] ?? 0) + 1;
    } catch (e) {
      sum.failed.push({ file: f.split('/').pop() ?? f, error: (e as Error).message });
      sum.raw += buf.length;
    }
  }
  const inner = [...ctx.rawBytes.values()].reduce((s, x) => s + x, 0);
  sum.decodedPercent = sum.bytes ? +(100 * (sum.decoded - inner) / sum.bytes).toFixed(3) : 0;
  sum.issues = sorted(ctx.issues);
  sum.rawBytes = sorted(ctx.rawBytes);
  return sum;
}

export async function inspectAsa(save: string, options: { limit?: number; containers?: boolean } = {}): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  const s = await readAsaSave(save, { limit: options.limit });
  const readSeconds = seconds(t0);
  const cov = asaCoverage(s);
  let containers: ContainerSummary | null = null;
  if (options.containers !== false) {
    const dir = dirname(save);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.arkprofile') || f.endsWith('.arktribe'))
      .map((f) => join(dir, f))
      .filter((f) => statSync(f).isFile());
    if (files.length) containers = inspectContainers(files);
  }
  const raw = sorted(s.ctx.rawBytes);
  return {
    file: save, format: 'ASA', runtime: `${runtime} ${process.versions.bun ?? process.versions.node}`,
    seconds: readSeconds, limitedTo: options.limit ?? null,
    version: s.version, gameTime: s.gameTime, headerUnknown: s.headerUnknown,
    map: s.parts[0] ?? null, parts: s.parts.length, names: s.nameCount, otherTable: s.otherTable.length,
    objects: s.objectCount, actorTransforms: s.transforms,
    fileBytes: s.fileBytes, payloadBytes: s.payloadBytes, sqliteOverheadBytes: s.fileBytes - s.payloadBytes,
    decodedPercent: cov.percent,
    tables: s.tables, customKeys: s.customKeys, sections: s.sections,
    issues: sorted(s.ctx.issues),
    rawBytes: raw,
    cryopods: s.cryo,
    store: s.store && {
      tribes: s.store.tribes.length, players: s.store.players.length, decoded: s.store.decoded, raw: s.store.raw,
      failed: [...s.store.tribes, ...s.store.players].filter((x) => x.error).slice(0, 10),
    },
    missions: s.missions.length ? { boards: s.missions.length, scores: s.missions.reduce((n, m) => n + m.scores.length, 0) } : null,
    seen: sorted(s.ctx.seen, 300),
    containers,
    topClasses: sorted(s.classes, 40),
  };
}
