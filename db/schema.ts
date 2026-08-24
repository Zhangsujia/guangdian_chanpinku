import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const members = sqliteTable("members", {
  email: text("email").primaryKey(),
  displayName: text("display_name").notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  canEdit: integer("can_edit", { mode: "boolean" }).notNull().default(true),
  canDelete: integer("can_delete", { mode: "boolean" }).notNull().default(false),
  passwordHash: text("password_hash"),
  passwordSalt: text("password_salt"),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: text("locked_until"),
  invitedBy: text("invited_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  memberEmail: text("member_email").notNull().references(() => members.email, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("sessions_member_email_idx").on(table.memberEmail),
  index("sessions_expires_at_idx").on(table.expiresAt),
]);

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  manufacturer: text("manufacturer").notNull().default("未填写"),
  sku: text("sku").notNull().default(""),
  skuValuesJson: text("sku_values_json").notNull().default("[]"),
  price: real("price").notNull().default(0),
  mechanism: text("mechanism").notNull().default(""),
  commission: real("commission").notNull().default(0),
  status: text("promotion_status", { enum: ["正常推广", "暂停推广", "已下架"] }).notNull().default("正常推广"),
  imageKey: text("image_key"),
  aliasesJson: text("aliases_json").notNull().default("[]"),
  notes: text("notes").notNull().default(""),
  revision: integer("revision").notNull().default(1),
  createdBy: text("created_by").notNull(),
  updatedBy: text("updated_by").notNull(),
  deletedAt: text("deleted_at"),
  deletedBy: text("deleted_by"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("products_normalized_name_unique").on(table.normalizedName),
  index("products_deleted_at_idx").on(table.deletedAt),
]);

export const productLinks = sqliteTable("product_links", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  linkMode: text("link_mode", { enum: ["shared", "creator"] }).notNull().default("shared"),
  url: text("url").notNull(),
  creatorLinksJson: text("creator_links_json").notNull().default("[]"),
  mechanism: text("mechanism").notNull(),
  commission: real("commission").notNull(),
  status: text("status", { enum: ["有效", "待复核", "疑似失效", "已失效"] }).notNull().default("有效"),
  lastCheckedAt: text("last_checked_at"),
  checkNote: text("check_note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("product_links_product_platform_unique").on(table.productId, table.platform),
  index("product_links_product_id_idx").on(table.productId),
  index("product_links_status_idx").on(table.status),
]);

export const productPackages = sqliteTable("product_packages", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  price: real("price").notNull(),
  description: text("description").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("product_packages_product_name_unique").on(table.productId, table.normalizedName),
  index("product_packages_product_id_idx").on(table.productId),
]);

export const activityLogs = sqliteTable("activity_logs", {
  id: text("id").primaryKey(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  productName: text("product_name"),
  summary: text("summary").notNull(),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("activity_logs_created_at_idx").on(table.createdAt),
  index("activity_logs_actor_email_idx").on(table.actorEmail),
]);

export const teamSettings = sqliteTable("team_settings", {
  id: text("id").primaryKey().default("default"),
  teamName: text("team_name").notNull().default("产品链接管家"),
  subtitle: text("subtitle").notNull().default("团队产品资料安全同步"),
  themeColor: text("theme_color").notNull().default("#187657"),
  avatarKey: text("avatar_key"),
  updatedBy: text("updated_by").notNull().default("system"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
