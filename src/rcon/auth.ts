// Roles, permissions and password/token hashing.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const ROLES = ['viewer', 'moderator', 'admin', 'superadmin'] as const;
export type Role = typeof ROLES[number];

export const PERMISSIONS = {
  view: 'Karten, Spieler, Chat und Log sehen',
  chat: 'Nachrichten an Karten und Spieler schicken',
  kick: 'Spieler kicken',
  ban: 'Spieler bannen',
  unban: 'Banns aufheben',
  notes: 'Notizen und Markierungen an Spielern',
  'commands.run': 'gespeicherte Befehle ausführen',
  console: 'geprüfte RCON-Befehle in der Konsole',
  'console.risky': 'Befehle mit großer Wirkung (DoExit, DestroyWildDinos …)',
  'console.unverified': 'Befehle, die laut Analyse über RCON laufen, aber ungetestet sind',
  'commands.manage': 'gespeicherte Befehle anlegen und ändern',
  'schedules.manage': 'Zeitpläne anlegen und ändern',
  'triggers.manage': 'Trigger anlegen und ändern',
  audit: 'Audit-Log lesen',
  users: 'Benutzer und Rollen verwalten',
} as const;
export type Permission = keyof typeof PERMISSIONS;

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  viewer: ['view'],
  moderator: ['view', 'chat', 'kick', 'ban', 'notes', 'commands.run'],
  admin: ['view', 'chat', 'kick', 'ban', 'unban', 'notes', 'commands.run', 'console', 'console.risky', 'commands.manage',
    'schedules.manage', 'triggers.manage', 'audit'],
  superadmin: Object.keys(PERMISSIONS) as Permission[],
};

export function isRole(value: unknown): value is Role { return (ROLES as readonly unknown[]).includes(value); }

export function can(role: Role, perm: Permission): boolean { return ROLE_PERMISSIONS[role].includes(perm); }

export function permissionsOf(role: Role): Permission[] { return [...ROLE_PERMISSIONS[role]]; }

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newSecret(bytes = 24): string { return randomBytes(bytes).toString('base64url'); }

export function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
