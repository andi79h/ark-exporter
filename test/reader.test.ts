import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Archive, float32 } from '../src/archive.ts';
import { readContainer, readTributeTribe } from '../src/container.ts';
import { readEmbeddedArchive } from '../src/objects.ts';
import { readSave } from '../src/savegame.ts';
import { Blob, Embedded, ObjectRef, PathRef, ReadContext } from '../src/types.ts';
import { Writer } from './build.ts';
import { cryoPayload, profile, world } from './fixtures.ts';

test('float32 keeps the shortest exact decimal', () => {
  for (const v of [0.1, 1.5, -2, 123456.789, 3.4e38, 1e-30]) {
    const f = Math.fround(v);
    const out = float32(f) as number;
    assert.equal(Math.fround(out), f);
    assert.ok(String(out).length <= 13, `${out} too long`);
  }
  assert.equal(float32(Math.fround(0.1)), 0.1);
  assert.equal(float32(NaN), 'NaN');
});

test('strings: latin-1, UTF-16, null', () => {
  const b = new Writer(null).string('Bär').string('中文').string(null).toBuffer();
  const a = new Archive(b);
  assert.equal(a.string(), 'Bär');
  assert.equal(a.string(), '中文');
  assert.equal(a.string(), null);
  assert.equal(a.remaining, 0);
});

test('name table with instance numbers', () => {
  const b = new Writer(null).i32(2).i32(0).i32(1).i32(4).toBuffer();
  const a = new Archive(b, ['Foo', 'Bar']);
  assert.equal(a.name(), 'Bar');
  assert.equal(a.name(), 'Foo_3');
});

test('save: every byte accounted for, values decoded', () => {
  const buf = world();
  const ctx = new ReadContext();
  const s = readSave(buf, ctx);
  assert.equal(s.version, 9);
  assert.equal(s.dataFiles[0], 'TestMap');
  assert.equal(s.saveCount, 7);
  assert.equal(s.objects.length, 7);
  assert.equal(s.sections.reduce((a, x) => a + x.bytes, 0), buf.length);
  assert.ok(!s.sections.some((x) => x.name === 'unaccounted'));
  assert.deepEqual(s.hibernation.entries, 0);

  const dino = s.objects[0];
  assert.equal(dino.cls, 'Raptor_Character_BP_C');
  assert.deepEqual(dino.loc, { x: 1000, y: 2000, z: -50, pitch: 0, yaw: 90, roll: 0 });
  assert.equal(dino.props.TamedName, 'Rexy ä中');
  assert.equal(dino.props.bIsFemale, true);
  assert.deepEqual(dino.props.SomeVector, { x: 1.5, y: -2, z: 0.1 });
  assert.ok(dino.props.MyCharacterStatusComponent instanceof ObjectRef);
  assert.deepEqual(dino.props.TamingState, 'ETamingState::Tamed');
  assert.equal(dino.extra, undefined, '0,1 terminator needs no storage');

  const status = s.objects[1];
  assert.equal(status.props.CurrentStatusValues, 250.5);
  assert.equal(status.props['CurrentStatusValues[4]'], 42);
  assert.ok(status.props.FancyNewProperty instanceof Blob, 'unknown type kept raw');
  assert.equal(status.props.AfterUnknown, 5, 'reader resynchronises after unknown type');
  assert.equal(ctx.issues.get('unknown property type FancyProperty'), 1);

  const item = s.objects[5];
  assert.ok(item.isItem);
  assert.ok(item.props.ItemArchetype instanceof PathRef);
  const pod = (item.props.CustomItemDatas as any)[0].CustomDataBytes.ByteArrays;
  assert.ok(pod[0].Bytes instanceof Embedded, 'cryopod creature decoded');
  assert.equal(pod[0].Bytes.objects[0].props.TamedName, 'Frosty');
  assert.ok(pod[1].Bytes instanceof Blob, 'three loose bytes stay raw');

  const pawn = s.objects[6];
  assert.equal(pawn.props.LinkedPlayerDataID, '123456789012345678');
  assert.deepEqual((pawn.extra as any).head, [0, 0]);
  assert.equal((pawn.extra as any).vectors.length, 2);
});

test('embedded archive alone', () => {
  const e = readEmbeddedArchive(cryoPayload(), new ReadContext());
  assert.ok(e);
  assert.equal(e.objects.length, 2);
  assert.equal(e.objects[1].props['CurrentStatusValues[4]'], 80);
  assert.equal(readEmbeddedArchive(Buffer.alloc(64, 7), new ReadContext()), null, 'garbage is not an archive');
});

test('profile container', () => {
  const c = readContainer(profile());
  assert.equal(c.version, 1);
  assert.equal((c.objects[0].props.MyData as any).PlayerDataID, 4242);
});

test('tribute tribe words', () => {
  const b = new Writer(null).i32(1).i32(99).i32(0).i32(1).i32(1738805207).i32(0).toBuffer();
  assert.deepEqual(readTributeTribe(b), { version: 1, tribeId: 99, words: [0, 1, 1738805207, 0], trailing: 0 });
});
