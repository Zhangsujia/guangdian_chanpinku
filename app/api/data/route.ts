import { env } from "cloudflare:workers";
import { getSessionMember, hashPassword, isSameOrigin, validatePassword } from "../../auth";

type Role = "admin" | "member";
type LinkStatus = "有效" | "待复核" | "疑似失效" | "已失效";
type ProductStatus = "正常推广" | "暂停推广" | "已下架";

type Member = {
  email: string;
  displayName: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
};

type ProductLink = {
  id: string;
  platform: string;
  url: string;
  mechanism: string;
  commission: number;
  status: LinkStatus;
  lastCheckedAt?: string;
  checkNote?: string;
  updatedAt: string;
};

type ProductPackage = {
  id: string;
  name: string;
  price: number;
  description: string;
  updatedAt: string;
};

type Product = {
  id: string;
  name: string;
  manufacturer: string;
  price: number;
  status: ProductStatus;
  imageUrl: string;
  aliases: string[];
  notes: string;
  revision: number;
  createdBy: string;
  updatedBy: string;
  deletedAt?: string;
  deletedBy?: string;
  createdAt: string;
  updatedAt: string;
  links: ProductLink[];
  packages: ProductPackage[];
};

type TeamBrand = {
  name: string;
  subtitle: string;
  themeColor: string;
  avatarUrl: string;
  updatedAt: string;
};

const VALID_STATUSES = new Set<LinkStatus>(["有效", "待复核", "疑似失效", "已失效"]);
const VALID_PRODUCT_STATUSES = new Set<ProductStatus>(["正常推广", "暂停推广", "已下架"]);

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeName(value: string) {
  return value.toLowerCase()
    .replace(/(?:官方旗舰店|旗舰店|专卖店)/g, "")
    .replace(/[\s，,。.!！?？:：；;“”'"《》【】（）()_\-/]/g, "");
}

function safeJsonArray(value: unknown) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function error(message: string, status = 400, code?: string) {
  return Response.json({ error: message, code }, { status });
}

async function loadProduct(db: D1Database, productId: string) {
  const row = await db.prepare(
    `SELECT id, name, manufacturer, price, promotion_status AS status, image_key AS imageKey, aliases_json AS aliasesJson, notes, revision,
      created_by AS createdBy, updated_by AS updatedBy, deleted_at AS deletedAt,
      deleted_by AS deletedBy, created_at AS createdAt, updated_at AS updatedAt
      FROM products WHERE id = ?`,
  ).bind(productId).first<Record<string, unknown>>();
  if (!row) return null;
  const links = await db.prepare(
    `SELECT id, platform, url, mechanism, commission, status, last_checked_at AS lastCheckedAt,
      check_note AS checkNote, updated_at AS updatedAt FROM product_links
      WHERE product_id = ? ORDER BY platform, created_at`,
  ).bind(productId).all<Record<string, unknown>>();
  const packages = await db.prepare(
    `SELECT id, name, price, description, updated_at AS updatedAt FROM product_packages
      WHERE product_id = ? ORDER BY created_at, name`,
  ).bind(productId).all<Record<string, unknown>>();
  return mapProduct(row, links.results ?? [], packages.results ?? []);
}

function mapProduct(row: Record<string, unknown>, links: Array<Record<string, unknown>>, packages: Array<Record<string, unknown>>): Product {
  return {
    id: String(row.id),
    name: String(row.name),
    manufacturer: String(row.manufacturer ?? "未填写"),
    price: Number(row.price ?? 0),
    status: VALID_PRODUCT_STATUSES.has(String(row.status) as ProductStatus) ? String(row.status) as ProductStatus : "正常推广",
    imageUrl: row.imageKey ? `/api/product-image?productId=${encodeURIComponent(String(row.id))}&v=${encodeURIComponent(String(row.updatedAt ?? ""))}` : "",
    aliases: safeJsonArray(row.aliasesJson),
    notes: String(row.notes ?? ""),
    revision: Number(row.revision ?? 1),
    createdBy: String(row.createdBy ?? ""),
    updatedBy: String(row.updatedBy ?? ""),
    deletedAt: row.deletedAt ? String(row.deletedAt) : undefined,
    deletedBy: row.deletedBy ? String(row.deletedBy) : undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    packages: packages.map((item) => ({
      id: String(item.id),
      name: String(item.name),
      price: Number(item.price),
      description: String(item.description ?? ""),
      updatedAt: String(item.updatedAt ?? row.updatedAt),
    })),
    links: links.map((link) => ({
      id: String(link.id),
      platform: String(link.platform),
      url: String(link.url),
      mechanism: String(link.mechanism),
      commission: Number(link.commission),
      status: String(link.status) as LinkStatus,
      lastCheckedAt: link.lastCheckedAt ? String(link.lastCheckedAt) : undefined,
      checkNote: link.checkNote ? String(link.checkNote) : undefined,
      updatedAt: String(link.updatedAt),
    })),
  };
}

async function readState(db: D1Database, member: Member) {
  const [productResult, linkResult, packageResult, memberResult, activityResult, trashResult, teamResult] = await db.batch([
    db.prepare(
      `SELECT id, name, manufacturer, price, promotion_status AS status, image_key AS imageKey, aliases_json AS aliasesJson, notes, revision,
        created_by AS createdBy, updated_by AS updatedBy, deleted_at AS deletedAt,
        deleted_by AS deletedBy, created_at AS createdAt, updated_at AS updatedAt
        FROM products WHERE deleted_at IS NULL ORDER BY updated_at DESC`,
    ),
    db.prepare(
      `SELECT id, product_id AS productId, platform, url, mechanism, commission, status,
        last_checked_at AS lastCheckedAt, check_note AS checkNote, updated_at AS updatedAt
        FROM product_links ORDER BY platform, created_at`,
    ),
    db.prepare(
      `SELECT id, product_id AS productId, name, price, description, updated_at AS updatedAt
        FROM product_packages ORDER BY created_at, name`,
    ),
    db.prepare(
      `SELECT email, display_name AS displayName, role, active,
       must_change_password AS mustChangePassword, created_at AS createdAt
       FROM members ORDER BY role, created_at`,
    ),
    db.prepare(
      `SELECT id, actor_email AS actorEmail, action, entity_type AS entityType,
       entity_id AS entityId, product_name AS productName, summary,
       before_json AS beforeJson, after_json AS afterJson, created_at AS createdAt
       FROM activity_logs ORDER BY created_at DESC LIMIT 300`,
    ),
    db.prepare(
      `SELECT id, name, manufacturer, price, promotion_status AS status, image_key AS imageKey, aliases_json AS aliasesJson, notes, revision,
        created_by AS createdBy, updated_by AS updatedBy, deleted_at AS deletedAt,
        deleted_by AS deletedBy, created_at AS createdAt, updated_at AS updatedAt
        FROM products WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 100`,
    ),
    db.prepare(
      `SELECT team_name AS name, subtitle, theme_color AS themeColor, avatar_key AS avatarKey,
       updated_at AS updatedAt FROM team_settings WHERE id = 'default'`,
    ),
  ]);

  const links = (linkResult.results ?? []) as Array<Record<string, unknown>>;
  const byProduct = new Map<string, Array<Record<string, unknown>>>();
  links.forEach((link) => {
    const productId = String(link.productId);
    byProduct.set(productId, [...(byProduct.get(productId) ?? []), link]);
  });
  const packages = (packageResult.results ?? []) as Array<Record<string, unknown>>;
  const packagesByProduct = new Map<string, Array<Record<string, unknown>>>();
  packages.forEach((item) => {
    const productId = String(item.productId);
    packagesByProduct.set(productId, [...(packagesByProduct.get(productId) ?? []), item]);
  });
  const products = ((productResult.results ?? []) as Array<Record<string, unknown>>)
    .map((row) => mapProduct(row, byProduct.get(String(row.id)) ?? [], packagesByProduct.get(String(row.id)) ?? []));
  const trash = member.role === "admin"
    ? ((trashResult.results ?? []) as Array<Record<string, unknown>>).map((row) => mapProduct(row, byProduct.get(String(row.id)) ?? [], packagesByProduct.get(String(row.id)) ?? []))
    : [];
  const teamRow = (teamResult.results?.[0] ?? {}) as Record<string, unknown>;
  const team: TeamBrand = {
    name: String(teamRow.name ?? "产品链接管家"),
    subtitle: String(teamRow.subtitle ?? "团队产品资料安全同步"),
    themeColor: String(teamRow.themeColor ?? "#187657"),
    avatarUrl: teamRow.avatarKey ? `/api/team-avatar?v=${encodeURIComponent(String(teamRow.updatedAt ?? ""))}` : "",
    updatedAt: String(teamRow.updatedAt ?? ""),
  };

  return {
    version: 2,
    team,
    products,
    trash,
    members: member.role === "admin" ? memberResult.results ?? [] : [member],
    activity: activityResult.results ?? [],
    user: member,
    syncedAt: new Date().toISOString(),
  };
}

function validateProduct(input: unknown): { product?: Product; message?: string } {
  if (!input || typeof input !== "object") return { message: "产品资料格式不正确" };
  const product = input as Product;
  if (!String(product.id ?? "").trim() || !String(product.name ?? "").trim()) return { message: "产品名称不能为空" };
  if (typeof product.price !== "number" || !Number.isFinite(product.price) || product.price <= 0 || product.price > 99999999) return { message: "单品价格格式不正确" };
  if (!VALID_PRODUCT_STATUSES.has(product.status)) product.status = "正常推广";
  if (!Array.isArray(product.packages)) product.packages = [];
  const packageNames = new Set<string>();
  for (const item of product.packages) {
    const name = String(item.name ?? "").trim();
    const normalized = normalizeName(name);
    if (!name) return { message: "套餐名称不能为空" };
    if (name.length > 60) return { message: "套餐名称不能超过60个字" };
    if (packageNames.has(normalized)) return { message: `套餐名称“${name}”重复` };
    packageNames.add(normalized);
    if (typeof item.price !== "number" || !Number.isFinite(item.price) || item.price <= 0 || item.price > 99999999) return { message: `${name}的套餐价格格式不正确` };
    if (String(item.description ?? "").length > 500) return { message: `${name}的套餐内容不能超过500个字` };
  }
  if (!Array.isArray(product.links) || product.links.length === 0) return { message: "至少需要一条平台链接" };
  const urls = new Set<string>();
  for (const link of product.links) {
    if (!String(link.url ?? "").trim()) return { message: `${link.platform || "平台"}链接不能为空` };
    const url = String(link.url).trim();
    if (urls.has(url)) return { message: "同一款产品中不能填写重复链接" };
    urls.add(url);
    if (!String(link.mechanism ?? "").trim()) return { message: `${link.platform || "平台"}的产品机制不能为空` };
    if (typeof link.commission !== "number" || !Number.isFinite(link.commission) || link.commission < 0 || link.commission > 100) {
      return { message: `${link.platform || "平台"}的佣金必须是0%到100%之间的百分比` };
    }
    if (!VALID_STATUSES.has(link.status)) link.status = "有效";
  }
  return { product };
}

async function writeLog(db: D1Database, values: { actor: string; action: string; entityType: string; entityId: string; productName?: string; summary: string; before?: unknown; after?: unknown }) {
  return db.prepare(
    `INSERT INTO activity_logs (id, actor_email, action, entity_type, entity_id, product_name, summary, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id("log"), values.actor, values.action, values.entityType, values.entityId,
    values.productName ?? null, values.summary,
    values.before === undefined ? null : JSON.stringify(values.before),
    values.after === undefined ? null : JSON.stringify(values.after),
    new Date().toISOString(),
  );
}

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const db = env.DB;
    if (!db) return error("共享数据库暂不可用", 503, "DATABASE_UNAVAILABLE");
    const configured = await db.prepare("SELECT COUNT(*) AS count FROM members WHERE active = 1 AND password_hash IS NOT NULL").first<{ count: number }>();
    if (Number(configured?.count ?? 0) === 0) return error("请先创建管理员账号", 428, "SETUP_REQUIRED");
    const member = await getSessionMember(request);
    if (!member) return error("请使用邮箱和密码登录", 401, "SIGN_IN_REQUIRED");
    return Response.json(await readState(db, member));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "读取产品库失败";
    return error(message, 500);
  }
}

export async function POST(request: Request) {
  try {
    if (!isSameOrigin(request)) return error("请求来源无效", 403);
    const db = env.DB;
    if (!db) return error("共享数据库暂不可用", 503, "DATABASE_UNAVAILABLE");
    const member = await getSessionMember(request);
    if (!member) return error("登录已失效，请重新登录", 401, "SIGN_IN_REQUIRED");
    if (member.mustChangePassword) return error("请先在“账户与密码”中修改临时密码", 403, "PASSWORD_CHANGE_REQUIRED");
    const payload = await request.json() as Record<string, unknown>;
    const action = String(payload.action ?? "");
    const now = new Date().toISOString();

    if (action === "update_team") {
      if (member.role !== "admin") return error("只有管理员可以修改团队外观", 403, "ADMIN_REQUIRED");
      const teamName = String(payload.teamName ?? "").trim();
      const subtitle = String(payload.subtitle ?? "").trim();
      const themeColor = String(payload.themeColor ?? "").trim().toUpperCase();
      if (teamName.length < 2 || teamName.length > 24) return error("团队名称需要2到24个字");
      if (subtitle.length > 40) return error("团队标语不能超过40个字");
      if (!/^#[0-9A-F]{6}$/.test(themeColor)) return error("主题颜色格式不正确");
      await db.batch([
        db.prepare(
          `INSERT INTO team_settings (id, team_name, subtitle, theme_color, updated_by, updated_at)
           VALUES ('default', ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET team_name = excluded.team_name, subtitle = excluded.subtitle,
             theme_color = excluded.theme_color, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        ).bind(teamName, subtitle, themeColor, member.email, now),
        await writeLog(db, { actor: member.email, action: "update_team", entityType: "team", entityId: "default", summary: `更新了团队外观：${teamName}` }),
      ]);
      return Response.json({ ok: true });
    }

    if (action === "save_product") {
      const validation = validateProduct(payload.product);
      if (!validation.product) return error(validation.message ?? "产品资料不完整");
      const product = validation.product;
      const before = await loadProduct(db, product.id);
      if (before?.deletedAt) return error("该产品已在回收站中，请先恢复", 409, "PRODUCT_DELETED");
      if (before && product.revision && product.revision !== before.revision) {
        return error("其他成员刚刚修改了这款产品，已为你刷新最新内容", 409, "REVISION_CONFLICT");
      }
      const otherProducts = await db.prepare(
        "SELECT id, name, deleted_at AS deletedAt FROM products WHERE id <> ?",
      ).bind(product.id).all<Record<string, unknown>>();
      const duplicateName = (otherProducts.results ?? []).find((row) => normalizeName(String(row.name ?? "")) === normalizeName(product.name));
      if (duplicateName) {
        return error(
          duplicateName.deletedAt
            ? `回收站中已有同名产品“${String(duplicateName.name)}”，请先恢复或彻底处理该产品`
            : `产品库中已有同名产品“${String(duplicateName.name)}”`,
          409,
          "DUPLICATE_PRODUCT",
        );
      }
      for (const link of product.links) {
        const duplicateLink = await db.prepare(
          `SELECT p.id AS productId, p.name, pl.platform FROM product_links pl
           JOIN products p ON p.id = pl.product_id
           WHERE trim(pl.url) = ? AND p.deleted_at IS NULL AND p.id <> ? LIMIT 1`,
        ).bind(link.url.trim(), product.id).first<Record<string, unknown>>();
        if (duplicateLink) {
          return error(`该链接已用于“${String(duplicateLink.name)}”的${String(duplicateLink.platform || "其他")}平台`, 409, "DUPLICATE_LINK");
        }
      }
      const nextRevision = before ? before.revision + 1 : 1;
      const statements: D1PreparedStatement[] = [];
      if (before) {
        statements.push(db.prepare(
          `UPDATE products SET name = ?, normalized_name = ?, manufacturer = ?, price = ?, promotion_status = ?, aliases_json = ?, notes = ?,
           revision = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
        ).bind(product.name.trim(), normalizeName(product.name), product.manufacturer?.trim() || "未填写", product.price, product.status, JSON.stringify(product.aliases ?? []), product.notes ?? "", nextRevision, member.email, now, product.id));
        statements.push(db.prepare("DELETE FROM product_links WHERE product_id = ?").bind(product.id));
        statements.push(db.prepare("DELETE FROM product_packages WHERE product_id = ?").bind(product.id));
      } else {
        statements.push(db.prepare(
          `INSERT INTO products (id, name, normalized_name, manufacturer, price, promotion_status, aliases_json, notes, revision, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        ).bind(product.id, product.name.trim(), normalizeName(product.name), product.manufacturer?.trim() || "未填写", product.price, product.status, JSON.stringify(product.aliases ?? []), product.notes ?? "", member.email, member.email, now, now));
      }
      for (const item of product.packages) {
        statements.push(db.prepare(
          `INSERT INTO product_packages (id, product_id, name, normalized_name, price, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(item.id || id("package"), product.id, item.name.trim(), normalizeName(item.name), item.price, String(item.description ?? "").trim(), now, now));
      }
      for (const link of product.links) {
        statements.push(db.prepare(
          `INSERT INTO product_links (id, product_id, platform, url, mechanism, commission, status, last_checked_at, check_note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(link.id || id("link"), product.id, link.platform || "其他", link.url.trim(), link.mechanism.trim(), link.commission, link.status, link.lastCheckedAt ?? null, link.checkNote ?? null, link.updatedAt || now, link.updatedAt || now));
      }
      const after = { ...product, revision: nextRevision, updatedBy: member.email, updatedAt: now };
      statements.push(await writeLog(db, {
        actor: member.email,
        action: before ? "update" : "create",
        entityType: "product",
        entityId: product.id,
        productName: product.name,
        summary: before?.status !== product.status
          ? `将产品状态从${before?.status ?? "正常推广"}改为${product.status}`
          : before ? "更新了产品、单品价、套餐、平台链接、机制或佣金" : "新增了产品、单品价、套餐及平台链接",
        before,
        after,
      }));
      await db.batch(statements);
      return Response.json({ ok: true, product: await loadProduct(db, product.id) });
    }

    if (action === "delete_product") {
      if (member.role !== "admin") return error("只有管理员可以删除产品", 403, "ADMIN_REQUIRED");
      const productId = String(payload.productId ?? "");
      const before = await loadProduct(db, productId);
      if (!before) return error("产品不存在", 404);
      await db.batch([
        db.prepare("UPDATE products SET deleted_at = ?, deleted_by = ?, updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").bind(now, member.email, member.email, now, productId),
        await writeLog(db, { actor: member.email, action: "delete", entityType: "product", entityId: productId, productName: before.name, summary: "将产品移入回收站", before }),
      ]);
      return Response.json({ ok: true });
    }

    if (action === "restore_product") {
      if (member.role !== "admin") return error("只有管理员可以恢复产品", 403, "ADMIN_REQUIRED");
      const productId = String(payload.productId ?? "");
      const before = await loadProduct(db, productId);
      if (!before) return error("产品不存在", 404);
      await db.batch([
        db.prepare("UPDATE products SET deleted_at = NULL, deleted_by = NULL, updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").bind(member.email, now, productId),
        await writeLog(db, { actor: member.email, action: "restore", entityType: "product", entityId: productId, productName: before.name, summary: "从回收站恢复产品", before }),
      ]);
      return Response.json({ ok: true });
    }

    if (action === "add_member") {
      if (member.role !== "admin") return error("只有管理员可以添加成员", 403, "ADMIN_REQUIRED");
      const email = String(payload.email ?? "").trim().toLowerCase();
      const displayName = String(payload.displayName ?? "").trim() || email.split("@")[0];
      const temporaryPassword = String(payload.temporaryPassword ?? "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error("请输入正确的成员邮箱");
      const passwordError = validatePassword(temporaryPassword);
      if (passwordError) return error(`临时${passwordError}`);
      const credential = await hashPassword(temporaryPassword);
      await db.batch([
        db.prepare(
          `INSERT INTO members (email, display_name, role, active, password_hash, password_salt, must_change_password,
            failed_login_count, locked_until, invited_by, created_at, updated_at)
           VALUES (?, ?, 'member', 1, ?, ?, 1, 0, NULL, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, role = 'member', active = 1,
            password_hash = excluded.password_hash, password_salt = excluded.password_salt, must_change_password = 1,
            failed_login_count = 0, locked_until = NULL, invited_by = excluded.invited_by, updated_at = excluded.updated_at`,
        ).bind(email, displayName, credential.hash, credential.salt, member.email, now, now),
        db.prepare("DELETE FROM sessions WHERE member_email = ?").bind(email),
        await writeLog(db, { actor: member.email, action: "add_member", entityType: "member", entityId: email, summary: `添加团队成员 ${displayName}` }),
      ]);
      return Response.json({ ok: true });
    }

    if (action === "remove_member") {
      if (member.role !== "admin") return error("只有管理员可以移除成员", 403, "ADMIN_REQUIRED");
      const email = String(payload.email ?? "").trim().toLowerCase();
      if (email === member.email) return error("管理员不能移除自己的账号");
      await db.batch([
        db.prepare("UPDATE members SET active = 0, updated_at = ? WHERE email = ? AND role = 'member'").bind(now, email),
        await writeLog(db, { actor: member.email, action: "remove_member", entityType: "member", entityId: email, summary: `停用了团队成员 ${email}` }),
      ]);
      return Response.json({ ok: true });
    }

    return error("不支持的操作");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "保存失败";
    if (/UNIQUE constraint failed/i.test(message)) return error("已存在同名产品或同平台链接", 409, "DUPLICATE");
    return error(message, 500);
  }
}
