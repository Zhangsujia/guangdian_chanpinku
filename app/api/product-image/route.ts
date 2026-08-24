import { env } from "cloudflare:workers";
import { canEditProducts, getSessionMember, isSameOrigin } from "../../auth";

const ACCEPTED_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function error(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

async function productImage(db: D1Database, productId: string) {
  return db.prepare(
    "SELECT id, name, image_key AS imageKey, deleted_at AS deletedAt FROM products WHERE id = ?",
  ).bind(productId).first<{ id: string; name: string; imageKey?: string; deletedAt?: string }>();
}

async function imageLog(db: D1Database, actor: string, productId: string, productName: string, summary: string) {
  return db.prepare(
    `INSERT INTO activity_logs (id, actor_email, action, entity_type, entity_id, product_name, summary, created_at)
     VALUES (?, ?, 'update_image', 'product', ?, ?, ?, ?)`,
  ).bind(`log_${crypto.randomUUID()}`, actor, productId, productName, summary, new Date().toISOString());
}

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    if (!env.DB || !env.BUCKET) return new Response(null, { status: 404 });
    const member = await getSessionMember(request);
    if (!member) return new Response(null, { status: 401 });
    const productId = new URL(request.url).searchParams.get("productId")?.trim() ?? "";
    const product = productId ? await productImage(env.DB, productId) : null;
    if (!product?.imageKey || product.deletedAt) return new Response(null, { status: 404 });
    const object = await env.BUCKET.get(product.imageKey);
    if (!object) return new Response(null, { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, max-age=3600");
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
    if (!env.DB || !env.BUCKET) return error("图片存储暂不可用", 503);
    const member = await getSessionMember(request);
    if (!member) return error("登录已失效，请重新登录", 401);
    if (member.mustChangePassword) return error("请先修改临时密码", 403);
    if (!canEditProducts(member)) return error("管理员未开放产品编辑权限", 403);
    const form = await request.formData();
    const productId = String(form.get("productId") ?? "").trim();
    const file = form.get("image");
    const product = productId ? await productImage(env.DB, productId) : null;
    if (!product || product.deletedAt) return error("产品不存在", 404);
    if (!(file instanceof File)) return error("请选择产品图片");
    const extension = ACCEPTED_TYPES.get(file.type);
    if (!extension) return error("产品图片仅支持 JPG、PNG 或 WebP");
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) return error("产品图片需要在3MB以内");

    uploadedKey = `products/${productId}-${crypto.randomUUID()}.${extension}`;
    await env.BUCKET.put(uploadedKey, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE products SET image_key = ?, updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").bind(uploadedKey, member.email, now, productId),
      await imageLog(env.DB, member.email, productId, product.name, "更新了产品图片"),
    ]);
    if (product.imageKey && product.imageKey !== uploadedKey) await env.BUCKET.delete(product.imageKey);
    return Response.json({ ok: true, imageUrl: `/api/product-image?productId=${encodeURIComponent(productId)}&v=${encodeURIComponent(now)}` });
  } catch (cause) {
    if (uploadedKey && env.BUCKET) await env.BUCKET.delete(uploadedKey).catch(() => undefined);
    return error(cause instanceof Error ? cause.message : "产品图片上传失败", 500);
  }
}

export async function DELETE(request: Request) {
  try {
    if (!isSameOrigin(request)) return error("请求来源无效", 403);
    if (!env.DB || !env.BUCKET) return error("图片存储暂不可用", 503);
    const member = await getSessionMember(request);
    if (!member) return error("登录已失效，请重新登录", 401);
    if (member.mustChangePassword) return error("请先修改临时密码", 403);
    if (!canEditProducts(member)) return error("管理员未开放产品编辑权限", 403);
    const productId = new URL(request.url).searchParams.get("productId")?.trim() ?? "";
    const product = productId ? await productImage(env.DB, productId) : null;
    if (!product || product.deletedAt) return error("产品不存在", 404);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE products SET image_key = NULL, updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").bind(member.email, now, productId),
      await imageLog(env.DB, member.email, productId, product.name, "移除了产品图片"),
    ]);
    if (product.imageKey) await env.BUCKET.delete(product.imageKey);
    return Response.json({ ok: true });
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : "移除产品图片失败", 500);
  }
}
