import { env } from "cloudflare:workers";

export type AuthMember = {
  email: string;
  displayName: string;
  role: "admin" | "member";
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
};

const COOKIE_NAME = "pla_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
// Cloudflare Web Crypto supports PBKDF2 up to 100,000 iterations.
const PBKDF2_ITERATIONS = 100_000;

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) return new Uint8Array();
  return new Uint8Array(value.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? []);
}

function randomHex(size: number) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function derivePasswordHash(password: string, saltHex: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return different === 0;
}

export function validatePassword(password: string) {
  if (password.length < 8) return "密码至少需要8位";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "密码需要同时包含字母和数字";
  if (password.length > 128) return "密码不能超过128位";
  return null;
}

export async function hashPassword(password: string) {
  const salt = randomHex(16);
  return { salt, hash: await derivePasswordHash(password, salt) };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string) {
  if (!salt || !expectedHash) return false;
  return timingSafeEqual(await derivePasswordHash(password, salt), expectedHash);
}

function readCookie(request: Request, name: string) {
  const header = request.headers.get("cookie") ?? "";
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    if (pair.slice(0, at).trim() === name) return decodeURIComponent(pair.slice(at + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function createSession(db: D1Database, email: string) {
  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now.toISOString()),
    db.prepare("INSERT INTO sessions (token_hash, member_email, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .bind(tokenHash, email, expiresAt, now.toISOString(), now.toISOString()),
  ]);
  return token;
}

export async function revokeSession(db: D1Database, request: Request) {
  const token = readCookie(request, COOKIE_NAME);
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

export async function getSessionMember(request: Request): Promise<AuthMember | null> {
  const token = readCookie(request, COOKIE_NAME);
  if (!token || !env.DB) return null;
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT m.email, m.display_name AS displayName, m.role, m.active,
      m.must_change_password AS mustChangePassword, m.created_at AS createdAt
     FROM sessions s JOIN members m ON m.email = s.member_email
     WHERE s.token_hash = ? AND s.expires_at > ? AND m.active = 1`,
  ).bind(await sha256(token), now).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    email: String(row.email),
    displayName: String(row.displayName),
    role: String(row.role) as AuthMember["role"],
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.mustChangePassword),
    createdAt: String(row.createdAt),
  };
}

export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
