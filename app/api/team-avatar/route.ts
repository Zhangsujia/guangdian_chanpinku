import { env } from "cloudflare:workers";
import { getSessionMember, isSameOrigin } from "../../auth";

const ACCEPTED_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function error(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

async function currentAvatarKey(db: D1Database) {
  const row = await db.prepare("SELECT avatar_key AS avatarKey FROM team_settings WHERE id = 'default'").first<{ avatarKey?: string }>();
  return row?.avatarKey ?? "";
}

async function writeAvatarLog(db: D1Database, actor: string, summary: string) {
  return db.prepare(
    `INSERT INTO activity_logs (id, actor_email, action, entity_type, entity_id, summary, created_at)
     VALUES (?, ?, 'update_avatar', 'team', 'default', ?, ?)`,
  ).bind(`log_${crypto.randomUUID()}`, actor, summary, new Date().toISOString());
}

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (!env.DB || !env.BUCKET) return new Response(null, { status: 404 });
    const key = await currentAvatarKey(env.DB);
    if (!key) return new Response(null, { status: 404 });
    const object = await env.BUCKET.get(key);
    if (!object) return new Response(null, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=3600");
    headers.set("x-content-type-options", "nosniff");
    return new Response(object.body, { headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

export async function POST(request: Request) {
  let uploadedKey = "";
  try {
    if (!isSameOrigin(request)) return error("请求来源无效", 403);
    if (!env.DB || !env.BUCKET) return error("头像存储暂不可用", 503);
    const member = await getSessionMember(request);
    if (!member) return error("登录已失效，请重新登录", 401);
    if (member.role !== "admin") return error("只有管理员可以修改团队头像", 403);
    const form = await request.formData();
    const file = form.get("avatar");
    if (!(file instanceof File)) return error("请选择头像图片");
    const extension = ACCEPTED_TYPES.get(file.type);
    if (!extension) return error("头像仅支持 JPG、PNG 或 WebP 图片");
    if (file.size === 0 || file.size > MAX_AVATAR_BYTES) return error("头像大小需要在2MB以内");

    const previousKey = await currentAvatarKey(env.DB);
    uploadedKey = `team/avatar-${crypto.randomUUID()}.${extension}`;
    await env.BUCKET.put(uploadedKey, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO team_settings (id, avatar_key, updated_by, updated_at)
         VALUES ('default', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET avatar_key = excluded.avatar_key,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ).bind(uploadedKey, member.email, now),
      await writeAvatarLog(env.DB, member.email, "更新了团队头像"),
    ]);
    if (previousKey && previousKey !== uploadedKey) await env.BUCKET.delete(previousKey);
    return Response.json({ ok: true, avatarUrl: `/api/team-avatar?v=${encodeURIComponent(now)}` });
  } catch (cause) {
    if (uploadedKey && env.BUCKET) await env.BUCKET.delete(uploadedKey).catch(() => undefined);
    return error(cause instanceof Error ? cause.message : "头像上传失败", 500);
  }
}

export async function DELETE(request: Request) {
  try {
    if (!isSameOrigin(request)) return error("请求来源无效", 403);
    if (!env.DB || !env.BUCKET) return error("头像存储暂不可用", 503);
    const member = await getSessionMember(request);
    if (!member) return error("登录已失效，请重新登录", 401);
    if (member.role !== "admin") return error("只有管理员可以修改团队头像", 403);
    const previousKey = await currentAvatarKey(env.DB);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE team_settings SET avatar_key = NULL, updated_by = ?, updated_at = ? WHERE id = 'default'").bind(member.email, now),
      await writeAvatarLog(env.DB, member.email, "恢复了默认团队头像"),
    ]);
    if (previousKey) await env.BUCKET.delete(previousKey);
    return Response.json({ ok: true });
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "恢复默认头像失败", 500);
  }
}
