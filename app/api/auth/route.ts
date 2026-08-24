import { env } from "cloudflare:workers";
import {
  clearSessionCookie,
  createSession,
  getSessionMember,
  hashPassword,
  isSameOrigin,
  revokeSession,
  sessionCookie,
  validatePassword,
  verifyPassword,
} from "../../auth";

export const dynamic = "force-dynamic";

function result(body: Record<string, unknown>, status = 200, cookie?: string) {
  const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function setupRequired(db: D1Database) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM members WHERE active = 1 AND password_hash IS NOT NULL").first<{ count: number }>();
  return Number(row?.count ?? 0) === 0;
}

export async function GET(request: Request) {
  if (!env.DB) return result({ error: "共享数据库暂不可用" }, 503);
  const needsSetup = await setupRequired(env.DB);
  const user = needsSetup ? null : await getSessionMember(request);
  return result({ needsSetup, authenticated: Boolean(user), user });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return result({ error: "请求来源无效" }, 403);
  if (!env.DB) return result({ error: "共享数据库暂不可用" }, 503);
  const db = env.DB;
  const payload = await request.json() as Record<string, unknown>;
  const action = String(payload.action ?? "");

  if (action === "setup") {
    if (!(await setupRequired(db))) return result({ error: "管理员已经完成初始化，请直接登录" }, 409);
    const expectedSetupCode = String((env as unknown as { INITIAL_SETUP_CODE?: string }).INITIAL_SETUP_CODE ?? "");
    const setupCode = String(payload.setupCode ?? "").trim().toUpperCase();
    if (!expectedSetupCode) return result({ error: "管理员初始化功能尚未启用，请联系维护人员" }, 503);
    if (setupCode !== expectedSetupCode.trim().toUpperCase()) return result({ error: "一次性初始化码不正确" }, 403);
    const email = String(payload.email ?? "").trim().toLowerCase();
    const displayName = String(payload.displayName ?? "").trim();
    const password = String(payload.password ?? "");
    if (!validEmail(email)) return result({ error: "请输入正确的管理员邮箱" }, 400);
    if (!displayName) return result({ error: "请填写管理员姓名" }, 400);
    const passwordError = validatePassword(password);
    if (passwordError) return result({ error: passwordError }, 400);
    const credential = await hashPassword(password);
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE members SET role = 'member', active = 0, updated_at = ? WHERE role = 'admin'").bind(now),
      db.prepare(
        `INSERT INTO members (email, display_name, role, active, password_hash, password_salt, must_change_password,
          failed_login_count, locked_until, invited_by, created_at, updated_at)
         VALUES (?, ?, 'admin', 1, ?, ?, 0, 0, NULL, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, role = 'admin', active = 1,
          password_hash = excluded.password_hash, password_salt = excluded.password_salt, must_change_password = 0,
          failed_login_count = 0, locked_until = NULL, updated_at = excluded.updated_at`,
      ).bind(email, displayName, credential.hash, credential.salt, email, now, now),
      db.prepare("DELETE FROM sessions"),
      db.prepare(
        `INSERT INTO activity_logs (id, actor_email, action, entity_type, entity_id, summary, created_at)
         VALUES (?, ?, 'setup_admin', 'member', ?, ?, ?)`,
      ).bind(`log_${crypto.randomUUID()}`, email, email, `已启用独立邮箱密码登录，管理员为 ${displayName}`, now),
    ]);
    const token = await createSession(db, email);
    return result({ ok: true }, 200, sessionCookie(token));
  }

  if (action === "login") {
    if (await setupRequired(db)) return result({ error: "请先完成管理员初始化", code: "SETUP_REQUIRED" }, 428);
    const email = String(payload.email ?? "").trim().toLowerCase();
    const password = String(payload.password ?? "");
    const row = await db.prepare(
      `SELECT email, active, password_hash AS passwordHash, password_salt AS passwordSalt,
        failed_login_count AS failedLoginCount, locked_until AS lockedUntil FROM members WHERE email = ?`,
    ).bind(email).first<Record<string, unknown>>();
    const now = new Date();
    if (row?.lockedUntil && new Date(String(row.lockedUntil)).getTime() > now.getTime()) {
      return result({ error: "连续输错次数过多，请15分钟后再试" }, 429);
    }
    const valid = Boolean(row?.active) && await verifyPassword(password, String(row?.passwordSalt ?? ""), String(row?.passwordHash ?? ""));
    if (!valid) {
      if (row) {
        const failed = Number(row.failedLoginCount ?? 0) + 1;
        const lockedUntil = failed >= 5 ? new Date(now.getTime() + 15 * 60 * 1000).toISOString() : null;
        await db.prepare("UPDATE members SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE email = ?")
          .bind(failed >= 5 ? 0 : failed, lockedUntil, now.toISOString(), email).run();
      }
      return result({ error: "邮箱或密码不正确" }, 401);
    }
    await db.prepare("UPDATE members SET failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE email = ?")
      .bind(now.toISOString(), email).run();
    const token = await createSession(db, email);
    return result({ ok: true }, 200, sessionCookie(token));
  }

  if (action === "logout") {
    await revokeSession(db, request);
    return result({ ok: true }, 200, clearSessionCookie());
  }

  if (action === "change_password") {
    const member = await getSessionMember(request);
    if (!member) return result({ error: "登录已失效，请重新登录" }, 401);
    const currentPassword = String(payload.currentPassword ?? "");
    const newPassword = String(payload.newPassword ?? "");
    const passwordError = validatePassword(newPassword);
    if (passwordError) return result({ error: passwordError }, 400);
    const row = await db.prepare("SELECT password_hash AS passwordHash, password_salt AS passwordSalt FROM members WHERE email = ?")
      .bind(member.email).first<Record<string, unknown>>();
    if (!await verifyPassword(currentPassword, String(row?.passwordSalt ?? ""), String(row?.passwordHash ?? ""))) {
      return result({ error: "当前密码不正确" }, 400);
    }
    const credential = await hashPassword(newPassword);
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE members SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = ? WHERE email = ?")
        .bind(credential.hash, credential.salt, now, member.email),
      db.prepare("DELETE FROM sessions WHERE member_email = ?").bind(member.email),
    ]);
    const token = await createSession(db, member.email);
    return result({ ok: true }, 200, sessionCookie(token));
  }

  return result({ error: "不支持的登录操作" }, 400);
}
