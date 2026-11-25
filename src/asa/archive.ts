// Binary reader for ARK: Survival Ascended data. Same primitives as the ASE reader; what differs is
// how names are stored and which property tag layout is in use.
import { Archive } from '../archive.ts';
import type { ReadContext } from '../types.ts';

/**
 * How FNames are stored:
 * - `table`: world save, int32 id into the name table of the SaveHeader plus int32 instance number.
 * - `inline`: .arkprofile, .arktribe, saddle and costume archives: plain FString.
 * - `cryo`: cryopod payload, int32 id into its own table (ids | 0x10000000) or a fixed engine table.
 */
export type NameMode =
  | { kind: 'table'; names: Map<number, string> }
  | { kind: 'inline' }
  | { kind: 'cryo'; names: Map<number, string>; constants: Map<number, string> };

/**
 * How ObjectProperty values are stored:
 * - `save`: uint16 marker, then FName (marker 1) or 16-byte object GUID.
 * - `archive`: int32 kind, then int32 object index (0), FString path (1) or nothing (-1).
 */
export type RefMode = 'save' | 'archive';

export interface AsaFormat {
  names: NameMode;
  /** Property tags as written by Unreal Engine 5.5 (save version 14, archive version 7, cryopod 0x407). */
  ue55: boolean;
  refs: RefMode;
}

export class AsaArchive extends Archive {
  readonly format: AsaFormat;
  readonly ctx: ReadContext;

  constructor(buf: Buffer, format: AsaFormat, ctx: ReadContext, pos = 0) {
    super(buf, null, pos);
    this.format = format;
    this.ctx = ctx;
  }

  /** A reader over other bytes with the same format (embedded data). */
  with(buf: Buffer, format: AsaFormat = this.format): AsaArchive {
    return new AsaArchive(buf, format, this.ctx);
  }

  override name(): string | null {
    const mode = this.format.names;
    if (mode.kind === 'inline') return this.string();
    const id = this.i32();
    const inst = this.i32();
    let s = mode.names.get(id);
    if (s === undefined && mode.kind === 'cryo') {
      s = mode.constants.get(id);
      if (s === undefined) {
        s = `Unknown_${(id >>> 0).toString(16).padStart(8, '0')}`;
        this.ctx.note(`cryopod: unknown name id ${s}`);
      }
    }
    if (s === undefined) throw new RangeError(`name id ${id} not in name table at ${this.pos - 8}`);
    // Unreal stores the instance number plus one; 0 means "no number". Same convention as ASE.
    return inst ? `${s}_${inst - 1}` : s;
  }

  /** 16 raw bytes as lower-case hex, the way object GUIDs are keyed everywhere in the export. */
  uuid(): string {
    return this.bytes(16).toString('hex');
  }

  peekI32(): number {
    return this.dv.getInt32(this.pos, true);
  }
}

export const ZERO_UUID = '0'.repeat(32);
