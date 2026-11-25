// Minimal cron: "minute hour day-of-month month day-of-week" with *, lists, ranges and steps,
// evaluated in a given IANA time zone (default Europe/Berlin, since server crons there run on local time).

const RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

export interface CronSpec { fields: Array<Set<number>>; domStar: boolean; dowStar: boolean; source: string }

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields: "${expr}"`);
  const fields = parts.map((part, i) => {
    const [lo, hi] = RANGES[i];
    const set = new Set<number>();
    for (const item of part.split(',')) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`invalid cron field "${item}"`);
      const step = m[4] ? Number(m[4]) : 1;
      const from = m[1] === '*' ? lo : Number(m[2]);
      const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : (m[4] ? hi : from);
      if (from < lo || to > hi || from > to || step < 1) throw new Error(`cron field out of range "${item}"`);
      for (let v = from; v <= to; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    return set;
  });
  return { fields, domStar: parts[2] === '*', dowStar: parts[4] === '*', source: expr };
}

/** Wall-clock parts of an instant in a time zone. */
function zoned(ts: number, timeZone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short' });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ts))) p[part.type] = part.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month), weekday };
}

export function cronMatches(spec: CronSpec, ts: number, timeZone = 'Europe/Berlin'): boolean {
  const z = zoned(ts, timeZone);
  const [min, hour, dom, mon, dow] = spec.fields;
  if (!min.has(z.minute) || !hour.has(z.hour) || !mon.has(z.month)) return false;
  // classic cron: if both day fields are restricted, either may match
  const domOk = dom.has(z.day);
  const dowOk = dow.has(z.weekday);
  if (spec.domStar || spec.dowStar) return domOk && dowOk;
  return domOk || dowOk;
}

/** Next matching minute after `from` (searches up to ~2 years). */
export function nextRun(spec: CronSpec, from: number, timeZone = 'Europe/Berlin'): number | null {
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 60 * 24 * 750; i++, t += 60_000) if (cronMatches(spec, t, timeZone)) return t;
  return null;
}
