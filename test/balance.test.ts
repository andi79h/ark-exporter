// balance-decay: same decay times for every material by shifting LastInAllyRangeTime per class.
// All saves are synthetic; the class table is made up (base times like the vanilla tiers).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { balanceDecay, type BalanceParams, classShift, DAY, isMarked, MARK, MIN_STAMP, parseClassTable, realVisit } from '../src/balance.ts';
import { SaveEditor } from '../src/editor.ts';
import { findProperty } from '../src/tree.ts';
import { indexWorld } from '../src/world.ts';
import { buildSave, double, float, int, type Obj, str } from './build.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const TRIBE = 1_234_567;
// Header game time is a float32 in the save; 3e8 is exact there.
const NOW = 300_000_000;

const TABLE = [
  'class\tdays_base\tcore',
  '/Game/Test/Thatch/Wall_Thatch.Wall_Thatch_C\t4\t1',
  '/Game/Test/Wood/Wall_Wood.Wall_Wood_C\t8\t1',
  '/Game/Test/Stone/Wall_Stone.Wall_Stone_C\t12\t1',
  '/Game/Test/Metal/Wall_Metal.Wall_Metal_C\t16\t1',
  '/Game/Test/Tek/Wall_Tek.Wall_Tek_C\t20\t1',
  '/Game/Mods/Concrete/Concrete_Wall.Concrete_Wall_C\t256\t1',
  '/Game/Test/Campfire/Campfire.Campfire_C\t2\t0',
  '/Game/Test/Resource/Rock.Rock_C\t0\t0',
  '/Game/Test/Storage/Box.Dup_Box_C\t20\t0',
  '/Game/Mods/Other/Box.Dup_Box_C\t80\t0',
].join('\n');

const P: BalanceParams = { destroyableAfter: 45 * DAY, removedAfter: 90 * DAY, autoDestroyMult: 13, periodMult: 1, minTeam: 50_000 };
const TIERS: [string, number][] = [['Wall_Thatch_C', 4], ['Wall_Wood_C', 8], ['Wall_Stone_C', 12], ['Wall_Metal_C', 16], ['Wall_Tek_C', 20], ['Concrete_Wall_C', 256]];
const AGES = [0, 3, 10, 30, 44.9, 45.1, 60, 89.9, 90.1, 200];

function part(cls: string, name: string, visit: number | null, team = TRIBE): Obj {
  return {
    cls, names: [name], loc: [0, 0, 0],
    props: [int('TargetingTeam', team), str('OwnerName', 'Tribe of Test'), float('MaxHealth', 1000), ...(visit === null ? [] : [double('LastInAllyRangeTime', visit)])],
    extra: Buffer.alloc(4),
  };
}

/** One structure per tier and real age, plus the cases that must stay untouched. */
function save(now = NOW, visits?: Map<string, number>): Buffer {
  const objects: Obj[] = [];
  for (const [cls] of TIERS) {
    for (const a of AGES) {
      const name = `${cls}_${a}`;
      objects.push(part(cls, name, visits?.get(name) ?? now - a * DAY + 0.123));
    }
  }
  objects.push(part('Wall_Wood_C', 'foreign', now - 300 * DAY, 999));
  objects.push(part('Mystery_C', 'unknown', now - 50 * DAY));
  objects.push(part('Dup_Box_C', 'ambiguous', now - 50 * DAY));
  objects.push(part('Campfire_C', 'campfire', now - 50 * DAY));
  objects.push(part('Rock_C', 'rock', now - 50 * DAY));
  objects.push(part('Wall_Wood_C', 'no-stamp', null));
  return buildSave(objects, { map: 'TestMap', gameTime: now });
}

const table = parseClassTable(TABLE);

/** Stored LastInAllyRangeTime by object name. */
function stamps(buf: Buffer): Map<string, number> {
  const ed = SaveEditor.open(buf);
  const out = new Map<string, number>();
  for (const e of indexWorld(ed)) {
    const v = findProperty(ed.props(e.index), 'LastInAllyRangeTime')?.value;
    if (typeof v === 'number') out.set(e.name, v);
  }
  return out;
}

function run(buf: Buffer, opts: { undo?: boolean; params?: BalanceParams } = {}) {
  const ed = SaveEditor.open(buf);
  const report = balanceDecay(ed, indexWorld(ed), table, opts.params ?? P, opts);
  return { report, out: ed.write() };
}

/**
 * What the game does with a stored value (ASE 358.24): demolishable once now > time stamp + B, removed on
 * load when the time stamp is above 0 and now − time stamp > k × B.
 */
function game(stored: number, now: number, baseDays: number, p = P): { destroyable: boolean; removed: boolean } {
  const age = now - stored;
  const b = baseDays * DAY * p.periodMult;
  return { destroyable: age >= b, removed: stored > 0 && age >= p.autoDestroyMult * b };
}

test('class table: day, second and product columns, short names, ambiguous names', () => {
  assert.equal(table.classes.get('Wall_Wood_C')!.base, 8 * DAY);
  assert.equal(table.classes.get('Wall_Wood_C')!.core, true);
  assert.equal(table.ambiguous.has('Dup_Box_C'), true);
  const t2 = parseClassTable('# comment\nclass\tperiod_s\tclass_mult\tsettings_mult\nA_C\t345600\t1\t3\nB.B_C\t345600\t4\t5\n');
  assert.equal(t2.classes.get('A_C')!.base, 12 * DAY);
  assert.equal(t2.classes.get('B_C')!.base, 80 * DAY);
  assert.equal(parseClassTable('class\tbase_s\nX_C\t7200\n').classes.get('X_C')!.base, 7200);
  assert.throws(() => parseClassTable('name\tdays_base\nX\t4\n'), /column "class"/);
  assert.throws(() => parseClassTable('class\tfoo\nX\t4\n'), /base_s, days_base/);
});

test('class shift: gap between the phases, classes too short for the targets', () => {
  const thatch = classShift(4 * DAY, P)!;
  assert.equal(thatch.d1, (4 - 45) * DAY);
  assert.equal(thatch.d2, (52 - 90) * DAY);
  assert.equal(thatch.phase2From, (45 - 38) * DAY); // 3 days above B = 4 days
  assert.equal(classShift(2 * DAY, P), null); // 12 × 2 = 24 < 45
  assert.equal(classShift(0, P), null);
});

test('first run: every material becomes demolishable at 45 and removed at 90 days', () => {
  const { report, out } = run(save());
  assert.equal(report.balanced, TIERS.length * AGES.length);
  assert.equal(report.changed, TIERS.length * AGES.length);
  assert.equal(report.gameValues, TIERS.length * AGES.length);
  assert.equal(report.markedBefore, 0);
  const st = stamps(out);
  for (const [cls, base] of TIERS) {
    for (const a of AGES) {
      const v = st.get(`${cls}_${a}`)!;
      assert.equal(isMarked(v), true, `${cls} ${a}`);
      const g = game(v, NOW, base);
      assert.equal(g.destroyable, a >= 45, `${cls} age ${a}: demolishable`);
      assert.equal(g.removed, a >= 90, `${cls} age ${a}: removed`);
    }
  }
  assert.equal(report.destroyable, TIERS.length * AGES.filter((a) => a >= 45).length);
  assert.equal(report.due, TIERS.length * AGES.filter((a) => a >= 90).length);
  assert.equal(report.skipped.otherTeams, 1);
  assert.deepEqual(report.skipped.unknown, { Mystery_C: 1 });
  assert.deepEqual(report.skipped.ambiguous, { Dup_Box_C: 1 });
  assert.deepEqual(report.skipped.gapTooSmall, { Campfire_C: 1 });
  assert.equal(report.skipped.noDecay, 1);
  assert.equal(report.skipped.noTimestamp, 1);
  // Untouched: other teams and all skipped classes.
  const before = stamps(save());
  for (const n of ['foreign', 'unknown', 'ambiguous', 'campfire', 'rock']) assert.equal(st.get(n), before.get(n), n);
  // The written save reads back byte-identically through the editor.
  assert.equal(SaveEditor.open(out).write().equals(out), true);
});

test('second run on the same save changes nothing', () => {
  const once = run(save()).out;
  const twice = run(once);
  assert.equal(twice.report.changed, 0);
  assert.equal(twice.report.markedBefore, TIERS.length * AGES.length);
  assert.equal(twice.out.equals(once), true);
});

test('later runs recover the real visit; visits written by the game count as real', () => {
  const first = stamps(run(save()).out);
  // A day later (one restart), nobody came except to the 89.9-day wood wall, which the game set to "now".
  const later = NOW + 1 * DAY;
  const visits = new Map(first);
  visits.set('Wall_Wood_C_89.9', later - 100.5);
  const { report, out } = run(save(later, visits));
  assert.equal(report.gameValues, 1);
  const st = stamps(out);
  for (const [cls, base] of TIERS) {
    for (const a of AGES) {
      const name = `${cls}_${a}`;
      const real = name === 'Wall_Wood_C_89.9' ? 0 : a + 1;
      const g = game(st.get(name)!, later, base);
      assert.equal(g.destroyable, real >= 45, `${name}: demolishable at real age ${real}`);
      assert.equal(g.removed, real >= 90, `${name}: removed at real age ${real}`);
      // The recovered visit is the original one within a second.
      if (name !== 'Wall_Wood_C_89.9') {
        const s = classShift(base * DAY, P)!;
        assert.ok(Math.abs(realVisit(st.get(name)!, later, s).visit - (NOW - a * DAY)) < 1.5, name);
      }
    }
  }
});

test('undo restores the real visit and leaves values the run would not recognise', () => {
  const orig = stamps(save());
  const shifted = run(save()).out;
  const { report, out } = run(shifted, { undo: true });
  assert.equal(report.changed, TIERS.length * AGES.length);
  const st = stamps(out);
  for (const [cls] of TIERS) {
    for (const a of AGES) {
      const n = `${cls}_${a}`;
      assert.ok(Math.abs(st.get(n)! - orig.get(n)!) < 1, n);
      assert.equal(isMarked(st.get(n)!), false, n);
    }
  }
  // Undo of an untouched save changes nothing.
  assert.equal(run(save(), { undo: true }).report.changed, 0);
  // After undo, a new run starts from the real values again.
  const again = stamps(run(out).out);
  for (const [cls, base] of TIERS) for (const a of AGES) assert.equal(game(again.get(`${cls}_${a}`)!, NOW, base).removed, a >= 90);
});

test('missed runs longer than the gap only protect longer', () => {
  // Thatch has the smallest gap (3 days). A phase-1 value read 6 days later comes out as phase 2.
  const first = stamps(run(save()).out);
  const later = NOW + 6 * DAY;
  const st = stamps(run(save(later, first)).out);
  for (const [cls, base] of TIERS) {
    for (const a of AGES) {
      const real = a + 6;
      const g = game(st.get(`${cls}_${a}`)!, later, base);
      // Never earlier than the targets; may be later by at most the gap of the class.
      if (g.destroyable) assert.ok(real >= 45, `${cls}_${a} demolishable too early`);
      if (g.removed) assert.ok(real >= 90, `${cls}_${a} removed too early`);
    }
  }
});

test('transition period: overdue structures stay until not-before, then go', () => {
  const nb = NOW + 10 * DAY;
  const first = run(save(), { params: { ...P, notBefore: nb } });
  assert.equal(first.report.graced, TIERS.length * AGES.filter((a) => a >= 90).length);
  let st = stamps(first.out);
  for (const [cls, base] of TIERS) {
    for (const a of AGES) {
      const g = game(st.get(`${cls}_${a}`)!, NOW, base);
      assert.equal(g.removed, false, `${cls}_${a} removed during the transition`);
      assert.equal(g.destroyable, a >= 45, `${cls}_${a} demolishable`);
    }
  }
  // Daily runs during the period keep it; at not-before everything past T2 is due.
  const mid = run(save(NOW + 5 * DAY, st), { params: { ...P, notBefore: nb } });
  st = stamps(mid.out);
  for (const [cls, base] of TIERS) for (const a of AGES) assert.equal(game(st.get(`${cls}_${a}`)!, NOW + 5 * DAY, base).removed, false);
  const end = run(save(nb + 60, st), { params: { ...P, notBefore: nb } });
  st = stamps(end.out);
  for (const [cls, base] of TIERS) {
    for (const a of AGES) assert.equal(game(st.get(`${cls}_${a}`)!, nb + 60, base).removed, a + 10 >= 90, `${cls}_${a} at not-before`);
  }
  assert.throws(() => run(save(), { params: { ...P, notBefore: NOW + 46 * DAY } }), /at most/);
});

test('young maps: phase-2 values stay above 0, long classes wait for the game time', () => {
  // Game time 1,000 days: concrete (256 days × 13 = 3,328 days) cannot be removed by shifting yet.
  const young = 1000 * DAY;
  const { report, out } = run(save(young));
  const st = stamps(out);
  for (const a of AGES.filter((x) => x >= 45)) {
    const v = st.get(`Concrete_Wall_C_${a}`)!;
    assert.equal(v, MIN_STAMP, `concrete ${a}`);
    assert.equal(game(v, young, 256).removed, false);
    assert.equal(game(v, young, 256).destroyable, true);
  }
  assert.equal(report.clamped, AGES.filter((x) => x >= 45).length);
  assert.deepEqual(report.notRemovable, { Concrete_Wall_C: AGES.filter((x) => x >= 45).length });
  // Every other class behaves as on an old map.
  for (const [cls, base] of TIERS.filter(([c]) => c !== 'Concrete_Wall_C')) {
    for (const a of AGES) assert.equal(game(st.get(`${cls}_${a}`)!, young, base).removed, a >= 90, `${cls}_${a}`);
  }
  // Once the game time passes k × B, the clamped values are due (removed on the next load).
  const later = 3400 * DAY;
  const again = stamps(run(save(later, st)).out);
  for (const a of AGES.filter((x) => x >= 45)) assert.equal(game(again.get(`Concrete_Wall_C_${a}`)!, later, 256).removed, true);
});

test('the marker is exact and ignores game values', () => {
  assert.equal(MARK, 0.40625);
  assert.equal(isMarked(123456789.40625), true);
  assert.equal(isMarked(123456789.40624), false);
  assert.equal(isMarked(NOW + 0.123), false);
});

test('CLI: dry run, write with read-back, required options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ark-balance-'));
  try {
    const input = join(dir, 'TestMap.ark');
    const classes = join(dir, 'classes.tsv');
    writeFileSync(input, save());
    writeFileSync(classes, TABLE);
    const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, 'edit', 'balance-decay', input, ...args], { encoding: 'utf8' });
    const base = ['--classes', classes, '--destroyable-after', '45', '--removed-after', '90', '--autodestroy-mult', '13'];
    let r = cli('--destroyable-after', '45');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--classes/);
    r = cli(...base, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    const dry = JSON.parse(r.stdout);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.changed, TIERS.length * AGES.length);
    const out = join(dir, 'out.ark');
    r = cli(...base, '--out', out);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.readBack.objects, TIERS.length * AGES.length + 6);
    assert.equal(rep.consistency.after.ok ?? true, true);
    assert.equal(readFileSync(input).equals(save()), true); // input untouched
    // Nothing to change: no file.
    r = spawnSync(process.execPath, [CLI, 'edit', 'balance-decay', out, ...base, '--out', join(dir, 'again.ark')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).out, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
