"use client";

/* eslint-disable @next/next/no-img-element -- team and product images are runtime R2 objects served by authenticated app routes */

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  detectProductDuplicates,
  extractLinkEntries,
  extractCommission,
  extractEditQuery,
  extractPackages,
  extractPrice,
  extractQueryName,
  fuzzyFind,
  fuzzyScore,
  inferPlatform,
  normalizeSearchText,
  parseBatchProductInputs,
  parseConversationalProductEdit,
  parseQuickProductInput,
  SUPPORTED_PLATFORMS,
} from "./chat-parser";
import { buildProductReport, PRODUCT_STATUSES, ProductStatus, ReportPeriod, staleLinkDays } from "./reporting";

type LinkStatus = "有效" | "待复核" | "疑似失效" | "已失效";
type LinkMode = "shared" | "creator";

type CreatorLink = {
  id: string;
  creatorName: string;
  url: string;
  status: LinkStatus;
  updatedAt: string;
  lastCheckedAt?: string;
  checkNote?: string;
};

type ProductLink = {
  id: string;
  platform: string;
  linkMode: LinkMode;
  url: string;
  creatorLinks: CreatorLink[];
  mechanism: string;
  commission: number;
  status: LinkStatus;
  updatedAt: string;
  lastCheckedAt?: string;
  checkNote?: string;
};

type ProductPackage = {
  id: string;
  name: string;
  price: number;
  description: string;
  updatedAt: string;
};

type ProductSku = { value: string; price: number | null };

type Product = {
  id: string;
  name: string;
  manufacturer: string;
  sku: string;
  skus: ProductSku[];
  price: number;
  mechanism: string;
  commission: number;
  status: ProductStatus;
  imageUrl: string;
  aliases: string[];
  notes: string;
  revision: number;
  createdBy: string;
  updatedBy: string;
  packages: ProductPackage[];
  links: ProductLink[];
  createdAt: string;
  updatedAt: string;
};

type Member = { email: string; displayName: string; role: "admin" | "member"; active: boolean; canEdit: boolean; canDelete: boolean; mustChangePassword?: boolean; createdAt: string };
type Activity = { id: string; actorEmail: string; action: string; entityType: string; entityId: string; productName?: string; summary: string; beforeJson?: string; afterJson?: string; createdAt: string };
type TeamBrand = { name: string; subtitle: string; themeColor: string; avatarUrl: string; updatedAt: string };
type Database = {
  version: 2;
  team: TeamBrand;
  products: Product[];
  trash: Product[];
  members: Member[];
  activity: Activity[];
  user: Member | null;
  syncedAt?: string;
};

type View = "chat" | "products" | "review" | "reports" | "team" | "activity" | "trash" | "account" | "branding";

type Draft = {
  name?: string;
  manufacturer?: string;
  sku?: string;
  skus?: ProductSku[];
  price?: number;
  mechanism?: string;
  commission?: number;
  status?: ProductStatus;
  packages?: Array<{ id?: string; name: string; price: number; description: string }>;
  links: Array<{ platform: string; linkMode?: LinkMode; url: string; creatorLinks?: Array<{ id?: string; creatorName: string; url: string }> }>;
  awaiting: "name" | "price" | "link" | "mechanism" | "commission";
};

type QuickCreatorLinkRow = { id: string; creatorName: string; url: string };
type QuickLinkRow = { id: string; platform: string; linkMode: LinkMode; url: string; creatorLinks: QuickCreatorLinkRow[] };
type QuickPackageRow = { id: string; name: string; price: string; description: string };
type QuickSkuRow = { id: string; value: string; price: string };
type QuickEntry = { name: string; manufacturer: string; skus: QuickSkuRow[]; price: string; mechanism: string; commission: string; status: ProductStatus; packages: QuickPackageRow[]; links: QuickLinkRow[] };
type BatchEntry = QuickEntry & { id: string; imageFile: File | null; imagePreview: string };

type ProductChatAction = "links" | "edit" | "price" | "mechanism" | "commission" | "status" | "preflight";

type Message = {
  id: string;
  role: "assistant" | "user";
  text: string;
  imageUrl?: string;
  products?: Product[];
  productActions?: boolean;
};

type PendingProductChange = {
  kind: "edit" | "undo";
  productId: string;
  before: Product;
  after: Product;
  changes: string[];
};

const UI_ACCENT = "#6558E8";
const LEGACY_GREEN = "#187657";
const DEFAULT_TEAM: TeamBrand = { name: "产品链接管家", subtitle: "团队产品资料安全同步", themeColor: UI_ACCENT, avatarUrl: "", updatedAt: "" };
const EMPTY_DB: Database = { version: 2, team: DEFAULT_TEAM, products: [], trash: [], members: [], activity: [], user: null };
const PLATFORMS = [...SUPPORTED_PLATFORMS];
const BRAND_COLORS = ["#187657", "#2563EB", "#7C3AED", "#C2415D", "#C56A12", "#334155"];

const welcomeMessage: Message = {
  id: "welcome",
  role: "assistant",
  text: "你好，我是你的产品链接管家。你可以整段录入产品资料，也可以查询链接、按条件筛选、检查能否上品，或一句话修改多个字段；重要修改会先让你确认。",
};

function uid(prefix = "id") {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function displayBrandColor(color: string) {
  return color.toUpperCase() === LEGACY_GREEN ? UI_ACCENT : color;
}

function productLinkMode(link: Pick<ProductLink, "linkMode" | "creatorLinks">): LinkMode {
  return link.linkMode === "creator" || link.creatorLinks?.length ? "creator" : "shared";
}

function productLinkTargets(link: ProductLink) {
  if (productLinkMode(link) === "creator") return (link.creatorLinks ?? []).map((item) => ({ ...item, creatorName: item.creatorName || "未标注达人" }));
  return [{ id: link.id, creatorName: "统一链接", url: link.url, status: link.status, updatedAt: link.updatedAt, lastCheckedAt: link.lastCheckedAt, checkNote: link.checkNote }];
}

function filterLinkTargets(link: ProductLink, predicate: (target: ReturnType<typeof productLinkTargets>[number]) => boolean): ProductLink | null {
  if (productLinkMode(link) === "shared") return predicate(productLinkTargets(link)[0]) ? link : null;
  const creatorLinks = link.creatorLinks.filter((item) => predicate({ ...item, creatorName: item.creatorName || "未标注达人" }));
  return creatorLinks.length ? { ...link, creatorLinks } : null;
}

function quickLinkUrls(link: QuickLinkRow) {
  return link.linkMode === "creator" ? link.creatorLinks.map((item) => item.url.trim()).filter(Boolean) : [link.url.trim()].filter(Boolean);
}

function flattenQuickLinks(links: QuickLinkRow[]) {
  return links.flatMap((link) => quickLinkUrls(link).map((url) => ({ url })));
}

function makeQuickLinkRows(entries: ReturnType<typeof parseQuickProductInput>["links"], prefix: string): QuickLinkRow[] {
  const grouped = new Map<string, typeof entries>();
  entries.forEach((entry) => grouped.set(entry.platform, [...(grouped.get(entry.platform) ?? []), entry]));
  return [...grouped.entries()].map(([platform, platformEntries]) => {
    const creatorMode = platformEntries.some((entry) => Boolean(entry.creatorName)) || platformEntries.length > 1;
    return {
      id: uid(`${prefix}-link`),
      platform,
      linkMode: creatorMode ? "creator" : "shared",
      url: creatorMode ? "" : platformEntries[0]?.value ?? "",
      creatorLinks: creatorMode ? platformEntries.map((entry) => ({ id: uid(`${prefix}-creator`), creatorName: entry.creatorName ?? "", url: entry.value })) : [],
    };
  });
}

function friendlyDate(value?: string) {
  if (!value) return "尚未检测";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "尚未检测"
    : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatProductPrice(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "价格待补充";
  return `¥${Number.isInteger(value) ? value : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function formatPackages(packages: ProductPackage[]) {
  return packages.map((item) => `${item.name}${formatProductPrice(item.price)}${item.description ? ` ${item.description}` : ""}`).join("；");
}

function normalizedSkuEntries(values: unknown, legacy = ""): ProductSku[] {
  const source = Array.isArray(values) ? values : legacy ? [legacy] : [];
  const seen = new Set<string>();
  return source.map((item) => {
    const object = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const value = String(object?.value ?? object?.sku ?? object?.name ?? item ?? "").trim();
    const rawPrice = object?.price;
    const price = rawPrice === null || rawPrice === undefined || rawPrice === "" ? null : Number(rawPrice);
    return { value, price: price !== null && Number.isFinite(price) && price > 0 ? price : null };
  }).filter((entry) => {
    const key = normalizeSearchText(entry.value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function skuValues(values: unknown, legacy = "") {
  return normalizedSkuEntries(values, legacy).map((entry) => entry.value);
}

function splitSkuEntries(value: string) {
  return normalizedSkuEntries(value.split(/[，,；;、\n]+/).map((part) => {
    const priceMatch = part.match(/(?:价格|售价|价)?\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(?:元|块)\s*$/i);
    return { value: part.replace(/(?:价格|售价|价)?\s*[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元|块)\s*$/i, "").trim(), price: priceMatch ? Number(priceMatch[1]) : null };
  }));
}

async function optimizeProductImage(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("产品图片仅支持 JPG、PNG 或 WebP");
  if (file.size > 10 * 1024 * 1024) throw new Error("原图大小不能超过10MB");
  try {
    const bitmap = await createImageBitmap(file);
    const maxSide = 1400;
    const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", .84));
    if (blob && blob.size <= 3 * 1024 * 1024) return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "product"}.webp`, { type: "image/webp" });
  } catch {
    // Older browsers can still upload the original image when it is small enough.
  }
  if (file.size > 3 * 1024 * 1024) throw new Error("图片压缩失败，请选择较小的图片");
  return file;
}

function extractField(text: string, labels: string[], stops: string[]) {
  const label = labels.join("|");
  const stop = stops.join("|");
  const expression = new RegExp(`(?:${label})\\s*(?:是|为|叫|[:：])?\\s*(.+?)(?=\\s*[，,；;]\\s*(?:${stop})|https?://|$)`, "i");
  return text.match(expression)?.[1]?.trim();
}

function extractName(text: string) {
  const explicit = extractField(
    text,
    ["产品名称", "商品名称", "产品", "商品"],
    ["厂家", "品牌", ...PLATFORMS, "链接", "机制", "单品价", "价格", "套餐"]
  );
  if (explicit) return explicit.replace(/^(?:是|叫)/, "").trim();
  const afterAdd = text.match(/(?:添加|新增|录入|记录|保存)\s*(?:一个|这款|这个)?\s*(?:产品|商品)?\s*[：:]?\s*([^，,；;\s]+?)(?=的?(?:抖音|视频号|小红书|淘宝|天猫|京东|快手|拼多多|链接|厂家|品牌)|[，,；;]|https?:\/\/|$)/)?.[1];
  return afterAdd?.trim();
}

function extractManufacturer(text: string) {
  return extractField(text, ["厂家", "品牌", "供应商"], [...PLATFORMS, "链接", "机制", "单品价", "价格", "套餐"]);
}

function extractMechanism(text: string) {
  const match = text.match(/(?:产品机制|销售机制|带货机制|机制)\s*(?:是|为|[:：])?\s*(.+?)(?=(?:[，,；;]\s*)?(?:佣金|套餐|组合|规格)\s*(?:是|为|[:：])|$)/i);
  if (match?.[1]) return match[1].trim();
  const priceLed = text.match(/(?:价格|到手价)\s*(?:是|为|[:：])?\s*(.+?)(?=(?:[，,；;]\s*)?佣金\s*(?:是|为|[:：])|$)/i);
  return priceLed?.[0]?.trim();
}

function findProducts(products: Product[], query: string) {
  return fuzzyFind(products, query).map((item) => item.product);
}

function statusClass(status: LinkStatus) {
  return `status status-${status}`;
}

function productStatusClass(status: ProductStatus) {
  return `product-status product-status-${status}`;
}

function productStatusWarning(status: ProductStatus) {
  if (status === "暂停推广") return "该产品目前暂停推广，请确认后再使用链接";
  if (status === "已下架") return "该产品已下架，链接和资料仅供历史查看";
  return "";
}

function openableHref(value: string) {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^(?:[\w-]+\.)+[a-z]{2,}(?:\/|$)/i.test(trimmed)) return `https://${trimmed}`;
  return null;
}

function escapeCsv(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function parseSpreadsheetText(text: string) {
  const cleaned = text.replace(/^\uFEFF/, "");
  const firstLine = cleaned.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.includes("\t")) return parseCsv(cleaned);
  return cleaned.split(/\r?\n/).map((line) => line.split("\t")).filter((row) => row.some((cell) => cell.trim()));
}

function Icon({ name }: { name: "chat" | "bot" | "box" | "image" | "alert" | "download" | "send" | "copy" | "open" | "search" | "link" | "check" | "users" | "history" | "trash" | "palette" | "report" }) {
  const paths: Record<string, React.ReactNode> = {
    chat: <><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /><path d="M8 9h8M8 13h5" /></>,
    bot: <><path d="M12 3v3" /><path d="M9 3h6" /><rect x="3.5" y="6" width="17" height="14" rx="4" /><path d="M3.5 12H2M22 12h-1.5" /><circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" /><path d="M9 16h6" /></>,
    box: <><path d="m21 8-9 5-9-5 9-5 9 5Z" /><path d="m3 8 9 5 9-5v8l-9 5-9-5V8Z" /><path d="M12 13v8" /></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9" r="1.5" /><path d="m21 15-5-5L5 20" /></>,
    alert: <><path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
    open: <><path d="M15 3h6v6M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1" /></>,
    check: <path d="m20 6-11 11-5-5" />,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><path d="M20 8v6M23 11h-6" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    trash: <><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6" /><path d="M10 11v5M14 11v5" /></>,
    palette: <><path d="M12 3a9 9 0 0 0 0 18h1.5a2 2 0 0 0 0-4H12a2 2 0 0 1 0-4h4.5A4.5 4.5 0 0 0 21 8.5C21 5.5 17 3 12 3Z" /><circle cx="7.5" cy="10" r=".8" fill="currentColor" /><circle cx="10" cy="6.8" r=".8" fill="currentColor" /><circle cx="14" cy="6.5" r=".8" fill="currentColor" /><circle cx="17" cy="9" r=".8" fill="currentColor" /></>,
    report: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /><path d="m4 7 6-4 6 6 5-4" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function TeamMark({ brand, className = "brand-mark" }: { brand: TeamBrand; className?: string }) {
  return <div className={className} style={{ backgroundColor: displayBrandColor(brand.themeColor) }}>{brand.avatarUrl ? <img src={brand.avatarUrl} alt="团队头像" /> : <Icon name="bot" />}</div>;
}

function AuthGate({ mode, initialError, onAuthenticated }: { mode: "setup" | "login" | "error"; initialError?: string; onAuthenticated: () => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(initialError ?? "");
  const [submitting, setSubmitting] = useState(false);

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (mode === "error") return;
    if (mode === "setup" && password !== confirmPassword) { setError("两次输入的密码不一致"); return; }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, email, displayName, password, setupCode }),
      });
      const payload = await response.json().catch(() => ({ error: "服务器暂时没有返回有效结果，请稍后重试" }));
      if (!response.ok) { setError(payload.error || "操作失败，请稍后重试"); return; }
      await onAuthenticated();
    } catch {
      setError("网络连接失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="auth-shell">
    <section className="auth-card">
      <div className="auth-brand"><div className="brand-mark"><Icon name="bot" /></div><div><strong>产品链接管家</strong><span>团队产品资料安全同步</span></div></div>
      {mode === "setup" ? <><span className="auth-kicker">首次设置</span><h1>创建管理员账号</h1><p>请设置独立的管理员邮箱和密码。设置完成后，登录不再依赖 ChatGPT。</p></> : mode === "login" ? <><span className="auth-kicker">团队登录</span><h1>欢迎回来</h1><p>使用管理员为你创建的邮箱和密码进入共享产品库。</p></> : <><span className="auth-kicker">暂时不可用</span><h1>无法连接产品库</h1><p>{initialError || "请稍后刷新页面重试。"}</p></>}
      {mode !== "error" && <form onSubmit={submitAuth}>
        {mode === "setup" && <label>一次性初始化码<input required autoComplete="one-time-code" value={setupCode} onChange={(event) => setSetupCode(event.target.value.toUpperCase())} placeholder="请输入维护人员提供的初始化码" /></label>}
        {mode === "setup" && <label>管理员姓名<input required autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：小李" /></label>}
        <label>登录邮箱<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
        <label>密码<input required minLength={8} type="password" autoComplete={mode === "setup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={mode === "setup" ? "至少8位，包含字母和数字" : "请输入密码"} /></label>
        {mode === "setup" && <label>确认密码<input required minLength={8} type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入密码" /></label>}
        {error && <div className="auth-error">{error}</div>}
        <button disabled={submitting}>{submitting ? "处理中…" : mode === "setup" ? "创建管理员并进入" : "登录产品库"}</button>
      </form>}
      {mode === "error" && <button className="auth-retry" onClick={() => window.location.reload()}>刷新页面</button>}
      <small>密码会经过加密保存，管理员和系统都无法查看原密码。</small>
    </section>
  </main>;
}

export default function ProductLinkAssistant() {
  const [database, setDatabase] = useState<Database>(EMPTY_DB);
  const [messages, setMessages] = useState<Message[]>([welcomeMessage]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [input, setInput] = useState("");
  const [composerImageFile, setComposerImageFile] = useState<File | null>(null);
  const [composerImagePreview, setComposerImagePreview] = useState("");
  const [view, setView] = useState<View>("chat");
  const [search, setSearch] = useState("");
  const [authMode, setAuthMode] = useState<"loading" | "setup" | "login" | "app" | "error">("loading");
  const [accessError, setAccessError] = useState("");
  const [toast, setToast] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const [changingStatusId, setChangingStatusId] = useState<string | null>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [libraryStatusFilter, setLibraryStatusFilter] = useState<"全部" | ProductStatus>("全部");
  const [pendingChange, setPendingChange] = useState<PendingProductChange | null>(null);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberPassword, setMemberPassword] = useState("");
  const [updatingPermissionEmail, setUpdatingPermissionEmail] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickRaw, setQuickRaw] = useState("");
  const [quickEntry, setQuickEntry] = useState<QuickEntry>({ name: "", manufacturer: "", skus: [], price: "", mechanism: "", commission: "", status: "正常推广", packages: [], links: [] });
  const [quickImageFile, setQuickImageFile] = useState<File | null>(null);
  const [quickImagePreview, setQuickImagePreview] = useState("");
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [removeQuickImage, setRemoveQuickImage] = useState(false);
  const [activeQuickLinkId, setActiveQuickLinkId] = useState<string | null>(null);
  const [savingQuickEntry, setSavingQuickEntry] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchSource, setBatchSource] = useState<"text" | "table">("text");
  const [batchRaw, setBatchRaw] = useState("");
  const [batchFileName, setBatchFileName] = useState("");
  const [batchEntries, setBatchEntries] = useState<BatchEntry[]>([]);
  const [activeBatchEntryId, setActiveBatchEntryId] = useState<string | null>(null);
  const [savingBatch, setSavingBatch] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [brandName, setBrandName] = useState(DEFAULT_TEAM.name);
  const [brandSubtitle, setBrandSubtitle] = useState(DEFAULT_TEAM.subtitle);
  const [brandColor, setBrandColor] = useState(DEFAULT_TEAM.themeColor);
  const [brandAvatarPreview, setBrandAvatarPreview] = useState("");
  const [brandAvatarFile, setBrandAvatarFile] = useState<File | null>(null);
  const [removeBrandAvatar, setRemoveBrandAvatar] = useState(false);
  const [savingBrand, setSavingBrand] = useState(false);
  const [reportPeriod, setReportPeriod] = useState<ReportPeriod>("daily");
  const chatEnd = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerImageInput = useRef<HTMLInputElement>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const batchTableInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refresh(false);
  }, []);

  useEffect(() => {
    if (authMode !== "app" || accessError) return;
    const timer = window.setInterval(() => void refresh(true), 15000);
    return () => window.clearInterval(timer);
  }, [authMode, accessError]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function refresh(silent = true) {
    try {
      const response = await fetch("/api/data", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.code === "SETUP_REQUIRED") setAuthMode("setup");
        else if (response.status === 401) setAuthMode("login");
        else if (!silent) { setAccessError(payload.error || "暂时无法连接共享产品库"); setAuthMode("error"); }
        return false;
      }
      setDatabase(payload);
      setAccessError("");
      setAuthMode("app");
      if (payload.user?.mustChangePassword) setView("account");
      return true;
    } catch {
      if (!silent) { setAccessError("暂时无法连接共享产品库，请检查网络后刷新页面"); setAuthMode("error"); }
      return false;
    }
  }

  async function postAction(body: Record<string, unknown>) {
    try {
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        setToast(payload.error || "保存失败");
        if (response.status === 401) setAuthMode("login");
        if (response.status === 409) void refresh(true);
        return false;
      }
      return true;
    } catch {
      setToast("网络连接中断，本次修改未保存，请重试");
      return false;
    }
  }

  async function commit(next: Database) {
    const changedCount = next.products.filter((product) => JSON.stringify(product) !== JSON.stringify(database.products.find((item) => item.id === product.id))).length;
    const removedCount = database.products.filter((product) => !next.products.some((item) => item.id === product.id)).length;
    if (changedCount && !(database.user?.role === "admin" || database.user?.canEdit)) {
      setToast("管理员未开放产品新增和编辑权限");
      return false;
    }
    if (removedCount && !(database.user?.role === "admin" || database.user?.canDelete)) {
      setToast("管理员未开放产品删除权限");
      return false;
    }
    const previous = database;
    setDatabase(next);
    const previousById = new Map(previous.products.map((product) => [product.id, product]));
    const changed = next.products.filter((product) => JSON.stringify(product) !== JSON.stringify(previousById.get(product.id)));
    const nextIds = new Set(next.products.map((product) => product.id));
    const removed = previous.products.filter((product) => !nextIds.has(product.id));
    let ok = true;
    for (const product of changed) ok = (await postAction({ action: "save_product", product })) && ok;
    for (const product of removed) ok = (await postAction({ action: "delete_product", productId: product.id })) && ok;
    await refresh(true);
    if (ok && (changed.length || removed.length)) setToast("已同步到团队产品库");
    return ok;
  }

  function reply(text: string, products?: Product[], options?: { productActions?: boolean }) {
    setMessages((current) => [...current, { id: uid("msg"), role: "assistant", text, products, productActions: options?.productActions }]);
  }

  function addUserMessage(text: string, imageUrl?: string) {
    setMessages((current) => [...current, { id: uid("msg"), role: "user", text, imageUrl }]);
  }

  function parseIntoQuickEntry(text: string) {
    const parsed = parseQuickProductInput(text);
    const links = parsed.links.length
      ? makeQuickLinkRows(parsed.links, "quick")
      : [{ id: uid("quick-link"), platform: "抖音", linkMode: "shared" as LinkMode, url: "", creatorLinks: [] }];
    const packages = parsed.packages.map((item) => ({ id: uid("quick-package"), name: item.name, price: String(item.price), description: item.description }));
    setQuickEntry({ name: parsed.name, manufacturer: parsed.manufacturer, skus: parsed.skuEntries.map((entry) => ({ id: uid("quick-sku"), value: entry.value, price: entry.price === null ? "" : String(entry.price) })), price: parsed.price === null ? "" : String(parsed.price), mechanism: parsed.mechanism, commission: parsed.commission === null ? "" : String(parsed.commission), status: parsed.productStatus, packages, links });
    setActiveQuickLinkId(links[0]?.id ?? null);
  }

  function openQuickEntry(text = "", imageFile: File | null = null, imagePreview = "") {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setToast("你当前只有查看权限"); return; }
    setEditingProductId(null);
    setRemoveQuickImage(false);
    setActiveQuickLinkId(null);
    setQuickRaw(text);
    parseIntoQuickEntry(text);
    setQuickImageFile(imageFile);
    setQuickImagePreview(imagePreview);
    setQuickOpen(true);
  }

  function closeQuickEntry() {
    setQuickOpen(false);
    setQuickRaw("");
    setQuickImageFile(null);
    setQuickImagePreview("");
    setEditingProductId(null);
    setRemoveQuickImage(false);
    setActiveQuickLinkId(null);
  }

  function openProductEditor(product: Product) {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setToast("管理员未开放产品编辑权限"); return; }
    // Query cards can contain only the platform the user asked for. Always
    // reopen the complete current record so saving never drops hidden links.
    const currentProduct = database.products.find((item) => item.id === product.id) ?? product;
    setQuickRaw("");
    setQuickEntry({
      name: currentProduct.name,
      manufacturer: currentProduct.manufacturer === "未填写" ? "" : currentProduct.manufacturer,
      skus: normalizedSkuEntries(currentProduct.skus, currentProduct.sku).map((entry) => ({ id: uid("quick-sku"), value: entry.value, price: entry.price === null ? "" : String(entry.price) })),
      price: currentProduct.price > 0 ? String(currentProduct.price) : "",
      mechanism: currentProduct.mechanism,
      commission: String(currentProduct.commission),
      status: currentProduct.status ?? "正常推广",
      packages: (currentProduct.packages ?? []).map((item) => ({ id: item.id, name: item.name, price: String(item.price), description: item.description })),
      links: currentProduct.links.map((link) => ({
        id: link.id,
        platform: link.platform,
        linkMode: productLinkMode(link),
        url: link.url,
        creatorLinks: (link.creatorLinks ?? []).map((item) => ({ id: item.id, creatorName: item.creatorName, url: item.url })),
      })),
    });
    setQuickImageFile(null);
    setQuickImagePreview(currentProduct.imageUrl);
    setEditingProductId(currentProduct.id);
    setRemoveQuickImage(false);
    setActiveQuickLinkId(null);
    setQuickOpen(true);
  }

  function handleProductChatAction(product: Product, action: ProductChatAction) {
    const current = database.products.find((item) => item.id === product.id) ?? product;
    setActiveProductId(current.id);
    if (action === "links") {
      handleText(`${current.name}的链接是什么`);
      return;
    }
    if (action === "preflight") {
      handleText(`${current.name}能不能上品`);
      return;
    }
    if (action === "edit") {
      openProductEditor(current);
      return;
    }
    if (!(database.user?.role === "admin" || database.user?.canEdit)) {
      reply("你当前只有查看权限，请联系管理员开启“新增 / 编辑”权限。");
      return;
    }
    const prompts: Record<Exclude<ProductChatAction, "links" | "edit" | "preflight">, string> = {
      price: `把${current.name}的单品价格改为 `,
      mechanism: `把${current.name}的产品机制改为 `,
      commission: `把${current.name}的佣金改为 `,
      status: `把${current.name}的产品状态改为 `,
    };
    setInput(prompts[action]);
    window.requestAnimationFrame(() => composerInput.current?.focus());
  }

  async function applyComposerImage(file: File) {
    try {
      const optimized = await optimizeProductImage(file);
      setComposerImageFile(optimized);
      const reader = new FileReader();
      reader.onload = () => setComposerImagePreview(String(reader.result ?? ""));
      reader.readAsDataURL(optimized);
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "图片处理失败");
    }
  }

  function chooseComposerImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void applyComposerImage(file);
    event.target.value = "";
  }

  function pasteComposerImage(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = [...event.clipboardData.items].find((entry) => entry.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void applyComposerImage(new File([file], `粘贴的产品图片.${file.type.split("/")[1] || "png"}`, { type: file.type }));
  }

  function clearComposerImage() {
    setComposerImageFile(null);
    setComposerImagePreview("");
    if (composerImageInput.current) composerImageInput.current.value = "";
  }

  async function applyQuickImage(file: File) {
    try {
      const optimized = await optimizeProductImage(file);
      setQuickImageFile(optimized);
      setRemoveQuickImage(false);
      const reader = new FileReader();
      reader.onload = () => setQuickImagePreview(String(reader.result ?? ""));
      reader.readAsDataURL(optimized);
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "图片处理失败");
    }
  }

  function chooseQuickImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void applyQuickImage(file);
    event.target.value = "";
  }

  function pasteQuickImage(event: React.ClipboardEvent<HTMLElement>) {
    const item = [...event.clipboardData.items].find((entry) => entry.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void applyQuickImage(new File([file], `粘贴的产品图片.${file.type.split("/")[1] || "png"}`, { type: file.type }));
  }

  async function uploadProductImage(productId: string, file: File) {
    const form = new FormData();
    form.append("productId", productId);
    form.append("image", file);
    const response = await fetch("/api/product-image", { method: "POST", body: form });
    const payload = await response.json().catch(() => ({ error: "产品图片上传失败" }));
    if (!response.ok) { setToast(payload.error || "产品图片上传失败"); return false; }
    return true;
  }

  async function replaceProductImage(product: Product, file: File) {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setToast("管理员未开放产品编辑权限"); return; }
    try {
      const optimized = await optimizeProductImage(file);
      if (await uploadProductImage(product.id, optimized)) {
        await refresh(true);
        setToast(`已更新“${product.name}”的产品图片`);
      }
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "图片处理失败");
    }
  }

  async function deleteProductImage(productId: string) {
    const response = await fetch(`/api/product-image?productId=${encodeURIComponent(productId)}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({ error: "移除产品图片失败" }));
    if (!response.ok) { setToast(payload.error || "移除产品图片失败"); return false; }
    return true;
  }

  async function removeProductImage(product: Product) {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setToast("管理员未开放产品编辑权限"); return; }
    if (!await deleteProductImage(product.id)) return;
    await refresh(true);
    setToast(`已移除“${product.name}”的产品图片`);
  }

  function updateQuickLink(id: string, patch: Partial<QuickLinkRow>) {
    setQuickEntry((current) => ({ ...current, links: current.links.map((link) => link.id === id ? { ...link, ...patch } : link) }));
  }

  function setQuickLinkMode(id: string, linkMode: LinkMode) {
    setQuickEntry((current) => ({ ...current, links: current.links.map((link) => {
      if (link.id !== id || link.linkMode === linkMode) return link;
      if (linkMode === "creator") return { ...link, linkMode, creatorLinks: link.creatorLinks.length ? link.creatorLinks : [{ id: uid("quick-creator"), creatorName: "", url: link.url }], url: "" };
      return { ...link, linkMode, url: link.url || link.creatorLinks[0]?.url || "", creatorLinks: [] };
    }) }));
  }

  function addQuickCreatorLink(linkId: string) {
    setQuickEntry((current) => ({ ...current, links: current.links.map((link) => link.id === linkId ? { ...link, creatorLinks: [...link.creatorLinks, { id: uid("quick-creator"), creatorName: "", url: "" }] } : link) }));
  }

  function updateQuickCreatorLink(linkId: string, creatorId: string, patch: Partial<Pick<QuickCreatorLinkRow, "creatorName" | "url">>) {
    setQuickEntry((current) => ({ ...current, links: current.links.map((link) => link.id === linkId ? { ...link, creatorLinks: link.creatorLinks.map((item) => item.id === creatorId ? { ...item, ...patch } : item) } : link) }));
  }

  function removeQuickCreatorLink(linkId: string, creatorId: string) {
    setQuickEntry((current) => ({ ...current, links: current.links.map((link) => link.id === linkId ? { ...link, creatorLinks: link.creatorLinks.filter((item) => item.id !== creatorId) } : link) }));
  }

  function updateQuickPackage(id: string, patch: Partial<QuickPackageRow>) {
    setQuickEntry((current) => ({ ...current, packages: current.packages.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  }

  function addQuickSku() {
    setQuickEntry((current) => ({ ...current, skus: [...current.skus, { id: uid("quick-sku"), value: "", price: "" }] }));
  }

  function updateQuickSku(id: string, patch: Partial<Pick<QuickSkuRow, "value" | "price">>) {
    setQuickEntry((current) => ({ ...current, skus: current.skus.map((item) => item.id === id ? { ...item, ...patch } : item) }));
  }

  function addQuickPackage() {
    setQuickEntry((current) => ({
      ...current,
      packages: [...current.packages, { id: uid("quick-package"), name: "", price: "", description: "" }],
    }));
  }

  function addQuickPlatform() {
    const nextPlatform = PLATFORMS.find((platform) => !quickEntry.links.some((link) => link.platform === platform)) ?? "其他";
    const id = uid("quick");
    setQuickEntry((current) => ({
      ...current,
      links: [...current.links, {
        id,
        platform: nextPlatform,
        linkMode: "shared",
        url: "",
        creatorLinks: [],
      }],
    }));
    setActiveQuickLinkId(id);
  }

  function validQuickCommission(value: string) {
    if (!value.trim()) return false;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 100;
  }

  function validQuickPrice(value: string) {
    if (!value.trim()) return false;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 && number <= 99_999_999;
  }

  function makeBatchEntry(input: ReturnType<typeof parseQuickProductInput>): BatchEntry {
    const links = input.links.length
      ? makeQuickLinkRows(input.links, "batch")
      : [{ id: uid("batch-link"), platform: "抖音", linkMode: "shared" as LinkMode, url: "", creatorLinks: [] }];
    const packages = input.packages.map((item) => ({ id: uid("batch-package"), name: item.name, price: String(item.price), description: item.description }));
    return { id: uid("batch"), name: input.name, manufacturer: input.manufacturer, skus: input.skuEntries.map((entry) => ({ id: uid("batch-sku"), value: entry.value, price: entry.price === null ? "" : String(entry.price) })), price: input.price === null ? "" : String(input.price), mechanism: input.mechanism, commission: input.commission === null ? "" : String(input.commission), status: input.productStatus, packages, links, imageFile: null, imagePreview: "" };
  }

  function openBatchImport() {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setToast("管理员未开放产品新增权限"); return; }
    setBatchOpen(true);
    setBatchSource("text");
    setBatchRaw("");
    setBatchFileName("");
    setBatchEntries([]);
    setActiveBatchEntryId(null);
    setBatchProgress(0);
  }

  function closeBatchImport() {
    setBatchOpen(false);
    setBatchRaw("");
    setBatchFileName("");
    setBatchEntries([]);
    setActiveBatchEntryId(null);
    setBatchProgress(0);
    if (batchTableInput.current) batchTableInput.current.value = "";
  }

  function getBatchEntryIssues(entry: BatchEntry, entries = batchEntries) {
    const issues: string[] = [];
    if (!entry.name.trim()) issues.push("缺少产品名称");
    if (!validQuickPrice(entry.price)) issues.push("价格未填写或格式错误");
    if (entry.skus.some((item) => (!item.value.trim() && item.price.trim()) || (item.price.trim() && !validQuickPrice(item.price)))) issues.push("存在未填写规格或价格错误的SKU");
    const skuNames = entry.skus.map((item) => normalizeSearchText(item.value)).filter(Boolean);
    if (new Set(skuNames).size !== skuNames.length) issues.push("同一产品存在重复SKU / 规格");
    if (entry.packages.some((item) => !item.name.trim() || !validQuickPrice(item.price))) issues.push("存在未填写名称或价格的套餐");
    const packageNames = entry.packages.map((item) => normalizeSearchText(item.name)).filter(Boolean);
    if (new Set(packageNames).size !== packageNames.length) issues.push("同一产品存在重复套餐名称");
    if (!entry.links.length) issues.push("至少需要一个平台");
    if (entry.links.some((link) => link.linkMode === "shared" ? !link.url.trim() : !link.creatorLinks.length || link.creatorLinks.some((item) => !item.creatorName.trim() || !item.url.trim()))) issues.push("存在未填写完整的统一链接或达人专属链接");
    if (!entry.mechanism.trim()) issues.push("缺少产品机制");
    if (!validQuickCommission(entry.commission)) issues.push("佣金未填写或格式错误");
    if (new Set(entry.links.map((link) => link.platform)).size !== entry.links.length) issues.push("同一产品存在重复平台");

    const normalizedName = normalizeSearchText(entry.name);
    if (normalizedName && database.products.some((product) => normalizeSearchText(product.name) === normalizedName)) issues.push("产品库中已有同名产品");
    if (normalizedName && entries.filter((item) => normalizeSearchText(item.name) === normalizedName).length > 1) issues.push("本批次存在同名产品");

    const urls = entry.links.flatMap(quickLinkUrls);
    const existingUrls = new Set(database.products.flatMap((product) => product.links.flatMap((link) => productLinkTargets(link).map((item) => item.url.trim()))).filter(Boolean));
    if (urls.some((url) => existingUrls.has(url))) issues.push("产品库中已有相同链接");
    const batchUrlCount = new Map<string, number>();
    entries.forEach((item) => item.links.flatMap(quickLinkUrls).forEach((url) => batchUrlCount.set(url, (batchUrlCount.get(url) ?? 0) + 1)));
    if (urls.some((url) => (batchUrlCount.get(url) ?? 0) > 1)) issues.push("本批次存在重复链接");
    return [...new Set(issues)];
  }

  function setParsedBatchEntries(entries: BatchEntry[], fileName = "") {
    if (!entries.length) { setToast("没有识别到产品资料"); return; }
    const limited = entries.slice(0, 50);
    if (entries.length > 50) setToast("单次最多导入50款产品，已保留前50款");
    setBatchEntries(limited);
    setBatchFileName(fileName);
    setActiveBatchEntryId(limited.find((entry) => getBatchEntryIssues(entry, limited).length)?.id ?? null);
  }

  function parseBatchText() {
    const parsed = parseBatchProductInputs(batchRaw).map(makeBatchEntry);
    setParsedBatchEntries(parsed);
  }

  async function chooseBatchTable(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const rows = parseSpreadsheetText(await file.text());
      if (rows.length < 2) throw new Error("empty");
      const headers = rows[0].map((value) => value.trim().replace(/^\uFEFF/, ""));
      const findColumn = (...names: string[]) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
      const columns = {
        name: findColumn("产品名称", "商品名称", "品名"),
        manufacturer: findColumn("厂家", "品牌", "供应商"),
        sku: findColumn("SKU / 产品规格（选填，多个用；分隔）", "SKU（选填）", "SKU", "sku", "产品规格", "商品规格", "货号", "型号"),
        status: findColumn("产品状态", "推广状态"),
        price: findColumn("单品价格", "单品价", "产品价格", "价格", "售价"),
        platform: findColumn("平台"),
        creator: findColumn("达人（选填）", "达人", "达人姓名", "主播"),
        url: findColumn("链接", "地址", "口令"),
        mechanism: findColumn("产品机制", "机制", "活动机制"),
        commission: findColumn("佣金", "佣金比例"),
        packages: findColumn("套餐（选填）", "套餐", "套餐价格"),
      };
      if ([columns.name, columns.price, columns.url, columns.mechanism, columns.commission].some((index) => index < 0)) throw new Error("headers");

      const grouped = new Map<string, BatchEntry>();
      rows.slice(1).forEach((row) => {
        const name = row[columns.name]?.trim() ?? "";
        if (!name && !row.some((cell) => cell.trim())) return;
        const key = normalizeSearchText(name) || uid("blank-row");
        let entry = grouped.get(key);
        if (!entry) {
          entry = {
            id: uid("batch"),
            name,
            manufacturer: columns.manufacturer >= 0 ? row[columns.manufacturer]?.trim() ?? "" : "",
            skus: (columns.sku >= 0 ? splitSkuEntries(row[columns.sku]?.trim() ?? "") : []).map((entry) => ({ id: uid("batch-sku"), value: entry.value, price: entry.price === null ? "" : String(entry.price) })),
            price: row[columns.price]?.trim().replace(/[¥￥元块]/g, "") ?? "",
            mechanism: row[columns.mechanism]?.trim() ?? "",
            commission: row[columns.commission]?.trim().replace(/[％%]/g, "") ?? "",
            status: columns.status >= 0 && PRODUCT_STATUSES.includes(row[columns.status]?.trim() as ProductStatus) ? row[columns.status].trim() as ProductStatus : "正常推广",
            packages: columns.packages >= 0
              ? extractPackages(`套餐：${row[columns.packages]?.trim() ?? ""}`).map((item) => ({ id: uid("batch-package"), name: item.name, price: String(item.price), description: item.description }))
              : [],
            links: [],
            imageFile: null,
            imagePreview: "",
          };
          grouped.set(key, entry);
        } else {
          if (!entry.mechanism.trim()) entry.mechanism = row[columns.mechanism]?.trim() ?? "";
          if (!entry.commission.trim()) entry.commission = row[columns.commission]?.trim().replace(/[％%]/g, "") ?? "";
          if (!entry.packages.length && columns.packages >= 0) {
            entry.packages = extractPackages(`套餐：${row[columns.packages]?.trim() ?? ""}`).map((item) => ({ id: uid("batch-package"), name: item.name, price: String(item.price), description: item.description }));
          }
          if (columns.sku >= 0) {
            const combined = normalizedSkuEntries([...entry.skus.map((item) => ({ value: item.value, price: item.price })), ...splitSkuEntries(row[columns.sku]?.trim() ?? "")]);
            entry.skus = combined.map((item, index) => ({ id: entry.skus[index]?.id ?? uid("batch-sku"), value: item.value, price: item.price === null ? "" : String(item.price) }));
          }
        }
        const url = row[columns.url]?.trim() ?? "";
        const platform = columns.platform >= 0 ? row[columns.platform]?.trim() || inferPlatform(url) : inferPlatform(url);
        const creatorName = columns.creator >= 0 ? row[columns.creator]?.trim() ?? "" : "";
        const existingLink = entry.links.find((link) => link.platform === platform);
        if (creatorName) {
          if (existingLink) {
            existingLink.linkMode = "creator";
            existingLink.url = "";
            existingLink.creatorLinks.push({ id: uid("batch-creator"), creatorName, url });
          } else entry.links.push({ id: uid("batch-link"), platform, linkMode: "creator", url: "", creatorLinks: [{ id: uid("batch-creator"), creatorName, url }] });
        } else if (!existingLink) entry.links.push({ id: uid("batch-link"), platform, linkMode: "shared", url, creatorLinks: [] });
      });
      setParsedBatchEntries([...grouped.values()], file.name);
    } catch (cause) {
      setToast(cause instanceof Error && cause.message === "headers" ? "表格表头不正确，请先下载模板" : "没有识别到有效的表格资料");
      event.target.value = "";
    }
  }

  function downloadBatchTemplate() {
    const rows = [
      ["产品名称", "厂家", "SKU / 产品规格（选填，多个用；分隔）", "单品价格", "产品状态", "套餐（选填）", "平台", "达人（选填）", "链接", "产品机制", "佣金"],
      ["示例胶原蛋白", "示例厂家", "SKU-A102 39.9元；SKU-A103 49.9元", "39.9", "正常推广", "2盒69.9元；3盒99元", "抖音", "", "统一链接", "拍一发一", "35%"],
      ["示例胶原蛋白", "示例厂家", "SKU-A102 39.9元；SKU-A103 49.9元", "39.9", "正常推广", "2盒69.9元；3盒99元", "视频号", "小王", "小王专属链接", "", ""],
      ["示例胶原蛋白", "示例厂家", "SKU-A102 39.9元；SKU-A103 49.9元", "39.9", "正常推广", "2盒69.9元；3盒99元", "视频号", "小李", "小李专属链接", "", ""],
    ];
    const csv = "\uFEFF" + rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "产品批量导入模板.csv");
  }

  function updateBatchEntry(id: string, patch: Partial<Pick<BatchEntry, "name" | "manufacturer" | "price" | "mechanism" | "commission" | "status">>) {
    setBatchEntries((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry));
  }

  function addBatchSku(entryId: string) {
    setBatchEntries((current) => current.map((entry) => entry.id === entryId
      ? { ...entry, skus: [...entry.skus, { id: uid("batch-sku"), value: "", price: "" }] }
      : entry));
  }

  function updateBatchSku(entryId: string, skuId: string, patch: Partial<Pick<QuickSkuRow, "value" | "price">>) {
    setBatchEntries((current) => current.map((entry) => entry.id !== entryId
      ? entry
      : { ...entry, skus: entry.skus.map((item) => item.id === skuId ? { ...item, ...patch } : item) }));
  }

  function updateBatchPackage(entryId: string, packageId: string, patch: Partial<QuickPackageRow>) {
    setBatchEntries((current) => current.map((entry) => entry.id !== entryId ? entry : { ...entry, packages: entry.packages.map((item) => item.id === packageId ? { ...item, ...patch } : item) }));
  }

  function addBatchPackage(entryId: string) {
    setBatchEntries((current) => current.map((entry) => entry.id === entryId
      ? { ...entry, packages: [...entry.packages, { id: uid("batch-package"), name: "", price: "", description: "" }] }
      : entry));
  }

  function updateBatchLink(entryId: string, linkId: string, patch: Partial<QuickLinkRow>) {
    setBatchEntries((current) => current.map((entry) => entry.id !== entryId ? entry : { ...entry, links: entry.links.map((link) => link.id === linkId ? { ...link, ...patch } : link) }));
  }

  function setBatchLinkMode(entryId: string, linkId: string, linkMode: LinkMode) {
    setBatchEntries((current) => current.map((entry) => entry.id !== entryId ? entry : { ...entry, links: entry.links.map((link) => {
      if (link.id !== linkId || link.linkMode === linkMode) return link;
      if (linkMode === "creator") return { ...link, linkMode, creatorLinks: link.creatorLinks.length ? link.creatorLinks : [{ id: uid("batch-creator"), creatorName: "", url: link.url }], url: "" };
      return { ...link, linkMode, url: link.url || link.creatorLinks[0]?.url || "", creatorLinks: [] };
    }) }));
  }

  function addBatchCreatorLink(entryId: string, linkId: string) {
    setBatchEntries((current) => current.map((entry) => entry.id !== entryId ? entry : { ...entry, links: entry.links.map((link) => link.id === linkId ? { ...link, creatorLinks: [...link.creatorLinks, { id: uid("batch-creator"), creatorName: "", url: "" }] } : link) }));
  }

  function updateBatchCreatorLink(entryId: string, linkId: string, creatorId: string, patch: Partial<Pick<QuickCreatorLinkRow, "creatorName" | "url">>) {
    setBatchEntries((current) => current.map((entry) => entry.id !== entryId ? entry : { ...entry, links: entry.links.map((link) => link.id === linkId ? { ...link, creatorLinks: link.creatorLinks.map((item) => item.id === creatorId ? { ...item, ...patch } : item) } : link) }));
  }

  function removeBatchCreatorLink(entryId: string, linkId: string, creatorId: string) {
    setBatchEntries((current) => current.map((entry) => entry.id !== entryId ? entry : { ...entry, links: entry.links.map((link) => link.id === linkId ? { ...link, creatorLinks: link.creatorLinks.filter((item) => item.id !== creatorId) } : link) }));
  }

  function addBatchPlatform(entryId: string) {
    setBatchEntries((current) => current.map((entry) => {
      if (entry.id !== entryId) return entry;
      const platform = PLATFORMS.find((item) => !entry.links.some((link) => link.platform === item)) ?? "其他";
      return { ...entry, links: [...entry.links, { id: uid("batch-link"), platform, linkMode: "shared", url: "", creatorLinks: [] }] };
    }));
  }

  async function applyBatchImage(entryId: string, file: File) {
    try {
      const optimized = await optimizeProductImage(file);
      const reader = new FileReader();
      reader.onload = () => setBatchEntries((current) => current.map((entry) => entry.id === entryId ? { ...entry, imageFile: optimized, imagePreview: String(reader.result ?? "") } : entry));
      reader.readAsDataURL(optimized);
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : "图片处理失败");
    }
  }

  async function saveBatchEntries() {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setToast("管理员未开放产品新增权限"); return; }
    const invalid = batchEntries.find((entry) => getBatchEntryIssues(entry).length);
    if (invalid) {
      setActiveBatchEntryId(invalid.id);
      setToast("请先处理缺项或重复资料");
      return;
    }
    setSavingBatch(true);
    setBatchProgress(0);
    const importedIds = new Set<string>();
    let imageFailures = 0;
    try {
      for (let index = 0; index < batchEntries.length; index += 1) {
        const entry = batchEntries[index];
        const timestamp = nowIso();
        const product: Product = {
          id: uid("product"),
          name: entry.name.trim(),
          manufacturer: entry.manufacturer.trim() || "未填写",
          sku: normalizedSkuEntries(entry.skus)[0]?.value ?? "",
          skus: normalizedSkuEntries(entry.skus),
          price: Number(entry.price),
          mechanism: entry.mechanism.trim(),
          commission: Number(entry.commission),
          status: entry.status,
          packages: entry.packages.map((item) => ({ id: uid("package"), name: item.name.trim(), price: Number(item.price), description: item.description.trim(), updatedAt: timestamp })),
          imageUrl: "",
          aliases: [],
          notes: "",
          revision: 0,
          createdBy: database.user?.email ?? "",
          updatedBy: database.user?.email ?? "",
          createdAt: timestamp,
          updatedAt: timestamp,
          links: entry.links.map((link) => ({ id: uid("link"), platform: link.platform, linkMode: link.linkMode, url: link.linkMode === "shared" ? link.url.trim() : "", creatorLinks: link.linkMode === "creator" ? link.creatorLinks.map((item) => ({ id: uid("creator"), creatorName: item.creatorName.trim(), url: item.url.trim(), status: "有效" as LinkStatus, updatedAt: timestamp })) : [], mechanism: entry.mechanism.trim(), commission: Number(entry.commission), status: "有效", updatedAt: timestamp })),
        };
        const saved = await postAction({ action: "save_product", product });
        if (!saved) break;
        importedIds.add(entry.id);
        if (entry.imageFile && !await uploadProductImage(product.id, entry.imageFile)) imageFailures += 1;
        setBatchProgress(index + 1);
      }
      await refresh(true);
      const remaining = batchEntries.filter((entry) => !importedIds.has(entry.id));
      if (importedIds.size) reply(`已批量导入 ${importedIds.size} 款产品。${remaining.length ? `还有 ${remaining.length} 款未导入，请检查后重试。` : "所有资料已同步到团队产品库。"}${imageFailures ? ` 其中 ${imageFailures} 张图片上传失败，可稍后在产品编辑中补传。` : ""}`);
      if (!remaining.length) closeBatchImport();
      else {
        setBatchEntries(remaining);
        setActiveBatchEntryId(remaining[0]?.id ?? null);
        setToast(`已导入${importedIds.size}款，还有${remaining.length}款未完成`);
      }
    } finally {
      setSavingBatch(false);
    }
  }

  async function saveQuickEntry(event: FormEvent) {
    event.preventDefault();
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setToast("管理员未开放产品新增和编辑权限"); return; }
    const incomplete = !quickEntry.name.trim() || !validQuickPrice(quickEntry.price)
      || quickEntry.skus.some((item) => (!item.value.trim() && item.price.trim()) || (item.price.trim() && !validQuickPrice(item.price)))
      || quickEntry.packages.some((item) => !item.name.trim() || !validQuickPrice(item.price))
      || !quickEntry.mechanism.trim() || !validQuickCommission(quickEntry.commission)
      || !quickEntry.links.length || quickEntry.links.some((link) => link.linkMode === "shared" ? !link.url.trim() : !link.creatorLinks.length || link.creatorLinks.some((item) => !item.creatorName.trim() || !item.url.trim()));
    if (incomplete) { setToast("请先补齐所有标红的必填项"); return; }
    const skuNames = quickEntry.skus.map((item) => normalizeSearchText(item.value)).filter(Boolean);
    if (new Set(skuNames).size !== skuNames.length) {
      setToast("同一款产品不能重复添加相同SKU / 规格");
      return;
    }
    const packageNames = quickEntry.packages.map((item) => normalizeSearchText(item.name));
    if (new Set(packageNames).size !== packageNames.length) {
      setToast("同一款产品不能重复添加同名套餐");
      return;
    }
    if (new Set(quickEntry.links.map((link) => link.platform)).size !== quickEntry.links.length) {
      setToast("同一款产品不能重复添加相同平台");
      return;
    }
    const duplicates = detectProductDuplicates(database.products, {
      name: quickEntry.name,
      links: flattenQuickLinks(quickEntry.links),
    }, editingProductId);
    if (duplicates.exactNameProduct || duplicates.urlMatches.length || duplicates.duplicateUrls.length) {
      setToast(duplicates.exactNameProduct
        ? `已有同名产品“${duplicates.exactNameProduct.name}”`
        : duplicates.duplicateUrls.length
          ? "同一款产品中不能填写重复链接"
          : `链接已用于“${duplicates.urlMatches[0].product.name}”`);
      return;
    }
    setSavingQuickEntry(true);
    try {
      const saved = await saveCompletedDraft({
        name: quickEntry.name.trim(),
        manufacturer: quickEntry.manufacturer.trim(),
        skus: normalizedSkuEntries(quickEntry.skus),
        price: Number(quickEntry.price),
        mechanism: quickEntry.mechanism.trim(),
        commission: Number(quickEntry.commission),
        status: quickEntry.status,
        packages: quickEntry.packages.map((item) => ({ id: item.id, name: item.name.trim(), price: Number(item.price), description: item.description.trim() })),
        awaiting: "mechanism",
        links: quickEntry.links.map((link) => ({ platform: link.platform, linkMode: link.linkMode, url: link.linkMode === "shared" ? link.url.trim() : "", creatorLinks: link.linkMode === "creator" ? link.creatorLinks.map((item) => ({ id: item.id, creatorName: item.creatorName.trim(), url: item.url.trim() })) : [] })),
      }, quickImageFile, editingProductId, removeQuickImage);
      if (saved) {
        closeQuickEntry();
      }
    } finally {
      setSavingQuickEntry(false);
    }
  }

  async function saveCompletedDraft(completed: Draft, imageFile?: File | null, targetProductId?: string | null, removeImage = false) {
    const completedPackages = completed.packages ?? [];
    if (completed.price === undefined || !Number.isFinite(completed.price) || completed.price <= 0) {
      setDraft({ ...completed, awaiting: "price" });
      reply("还缺少单品价格。请输入数字金额，例如“单品价59.9元”。");
      return null;
    }
    if (completedPackages.some((item) => !item.name.trim() || !Number.isFinite(item.price) || item.price <= 0)) {
      setToast("套餐名称和套餐价格需要填写完整");
      reply("套餐资料不完整。请填写套餐名称和价格，套餐内容可以不填。 ");
      return null;
    }
    const completedPackageNames = completedPackages.map((item) => normalizeSearchText(item.name));
    if (new Set(completedPackageNames).size !== completedPackageNames.length) {
      setToast("存在重复套餐名称");
      reply("同一款产品中不能保存两个同名套餐，请合并或修改套餐名称。 ");
      return null;
    }
    if (completed.links.some((link) => link.linkMode === "creator"
      ? !(link.creatorLinks?.length) || link.creatorLinks.some((item) => !item.creatorName.trim() || !item.url.trim())
      : !link.url.trim())) {
      setToast("请补齐统一链接，或每位达人的姓名和专属链接");
      reply("链接资料不完整。统一链接只填一条；选择达人专属后，需要填写每位达人的姓名和链接。 ");
      return null;
    }
    if (!completed.name || completed.links.length === 0 || !completed.mechanism?.trim()) {
      setDraft({ ...completed, awaiting: "mechanism" });
      reply("还缺少产品机制。请告诉我规格数量、买赠活动等内容；没有机制时链接不会保存。 ");
      return null;
    }
    if (completed.commission === undefined) {
      setDraft({ ...completed, awaiting: "commission" });
      reply("还缺少佣金。请用百分比填写，例如“佣金35%”。佣金为必填项，但低于30%仍可保存。 ");
      return null;
    }
    const duplicates = detectProductDuplicates(database.products, {
      name: completed.name,
      links: completed.links.flatMap((link) => link.linkMode === "creator" ? (link.creatorLinks ?? []).map((item) => ({ url: item.url })) : [{ url: link.url }]),
    }, targetProductId);
    if (duplicates.exactNameProduct || duplicates.urlMatches.length || duplicates.duplicateUrls.length) {
      const duplicateProducts = [
        duplicates.exactNameProduct,
        ...duplicates.urlMatches.map((match) => match.product),
      ].filter((product): product is Product => Boolean(product))
        .filter((product, index, products) => products.findIndex((item) => item.id === product.id) === index);
      const detail = duplicates.exactNameProduct
        ? `已有同名产品“${duplicates.exactNameProduct.name}”`
        : duplicates.duplicateUrls.length
          ? "同一款产品中填写了重复链接"
          : `链接已用于“${duplicates.urlMatches[0].product.name}”`;
      setToast(`${detail}，本次未保存`);
      reply(`检测到重复资料：${detail}，本次没有保存。请编辑已有产品，或更换产品名称/链接。`, duplicateProducts);
      return null;
    }
    const timestamp = nowIso();
    const existing = targetProductId
      ? database.products.find((product) => product.id === targetProductId)
      : undefined;
    if (targetProductId && !existing) {
      setToast("这款产品已被其他成员删除，请刷新后重试");
      return null;
    }
    let saved: Product;
    let products: Product[];
    if (existing) {
      const links = completed.links.map((entry) => {
        const previous = existing.links.find((link) => link.platform === entry.platform);
        const linkMode: LinkMode = entry.linkMode === "creator" ? "creator" : "shared";
        const creatorLinks = linkMode === "creator" ? (entry.creatorLinks ?? []).map((item) => {
          const old = previous?.creatorLinks?.find((current) => current.id === item.id || normalizeSearchText(current.creatorName) === normalizeSearchText(item.creatorName));
          const changed = !old || old.url !== item.url;
          return { id: old?.id ?? item.id ?? uid("creator"), creatorName: item.creatorName.trim(), url: item.url.trim(), status: old?.status ?? "有效" as LinkStatus, updatedAt: changed ? timestamp : old.updatedAt, lastCheckedAt: old?.lastCheckedAt, checkNote: old?.checkNote };
        }) : [];
        const linkChanged = !previous || productLinkMode(previous) !== linkMode || previous.url !== entry.url || JSON.stringify(previous.creatorLinks ?? []) !== JSON.stringify(creatorLinks);
        return {
          id: previous?.id ?? uid("link"),
          platform: entry.platform,
          linkMode,
          url: linkMode === "shared" ? entry.url : "",
          creatorLinks,
          mechanism: completed.mechanism!.trim(),
          commission: completed.commission!,
          status: previous?.status ?? "有效" as LinkStatus,
          updatedAt: linkChanged ? timestamp : previous.updatedAt,
          lastCheckedAt: previous?.lastCheckedAt,
          checkNote: previous?.checkNote,
        };
      });
      saved = {
        ...existing,
        name: completed.name,
        manufacturer: completed.manufacturer || "未填写",
        sku: normalizedSkuEntries(completed.skus, completed.sku)[0]?.value ?? "",
        skus: normalizedSkuEntries(completed.skus, completed.sku),
        price: completed.price,
        mechanism: completed.mechanism.trim(),
        commission: completed.commission,
        status: completed.status ?? existing.status ?? "正常推广",
        packages: completedPackages.map((item) => {
          const previous = existing.packages.find((current) => current.id === item.id || normalizeSearchText(current.name) === normalizeSearchText(item.name));
          return { id: previous?.id ?? item.id ?? uid("package"), name: item.name.trim(), price: item.price, description: item.description.trim(), updatedAt: timestamp };
        }),
        links,
        updatedAt: timestamp,
      };
      products = database.products.map((product) => product.id === existing.id ? saved : product);
    } else {
      saved = {
        id: uid("product"),
        name: completed.name,
        manufacturer: completed.manufacturer || "未填写",
        sku: normalizedSkuEntries(completed.skus, completed.sku)[0]?.value ?? "",
        skus: normalizedSkuEntries(completed.skus, completed.sku),
        price: completed.price,
        mechanism: completed.mechanism.trim(),
        commission: completed.commission,
        status: completed.status ?? "正常推广",
        packages: completedPackages.map((item) => ({ id: item.id ?? uid("package"), name: item.name.trim(), price: item.price, description: item.description.trim(), updatedAt: timestamp })),
        imageUrl: "",
        aliases: [],
        notes: "",
        revision: 0,
        createdBy: database.user?.email ?? "",
        updatedBy: database.user?.email ?? "",
        createdAt: timestamp,
        updatedAt: timestamp,
        links: completed.links.map((entry) => ({
          id: uid("link"),
          platform: entry.platform,
          linkMode: entry.linkMode === "creator" ? "creator" as LinkMode : "shared" as LinkMode,
          url: entry.linkMode === "creator" ? "" : entry.url,
          creatorLinks: entry.linkMode === "creator" ? (entry.creatorLinks ?? []).map((item) => ({ id: item.id ?? uid("creator"), creatorName: item.creatorName.trim(), url: item.url.trim(), status: "有效" as LinkStatus, updatedAt: timestamp })) : [],
          mechanism: completed.mechanism!.trim(),
          commission: completed.commission!,
          status: "有效",
          updatedAt: timestamp,
        })),
      };
      products = [saved, ...database.products];
    }
    const committed = await commit({ ...database, products });
    if (!committed) return null;
    if (imageFile) {
      const uploaded = await uploadProductImage(saved.id, imageFile);
      if (uploaded) {
        saved = { ...saved, imageUrl: `/api/product-image?productId=${encodeURIComponent(saved.id)}&v=${Date.now()}` };
        await refresh(true);
      }
    } else if (removeImage && existing?.imageUrl) {
      if (await deleteProductImage(saved.id)) {
        saved = { ...saved, imageUrl: "" };
        await refresh(true);
      }
    }
    setDraft(null);
    setActiveProductId(saved.id);
    const lowCommission = saved.commission < 30;
    const similarReminder = duplicates.similarProducts.length
      ? `\n名称相近提醒：产品库中还有“${duplicates.similarProducts.map((item) => item.product.name).join("、")}”，请确认不是同一款产品。`
      : "";
    reply(`${targetProductId ? "已更新" : "已保存"}“${saved.name}”，单品价 ${formatProductPrice(saved.price)}${saved.packages.length ? `，另有 ${saved.packages.length} 个套餐` : ""}。以后查询时，我会同步告诉你产品机制、统一佣金和各平台链接。${lowCommission ? "\n产品佣金低于30%，低于规定水平。" : ""}${similarReminder}`, [saved]);
    return saved;
  }

  function startAdd(text: string, imageFile: File | null = null, imagePreview = "") {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { reply("你当前只有查看权限，请联系管理员开启“新增 / 编辑”权限。"); return; }
    const parsed = parseQuickProductInput(text);
    const entries = parsed.links.length ? parsed.links : extractLinkEntries(text);
    const name = parsed.name || extractName(text);
    const manufacturer = parsed.manufacturer || extractManufacturer(text);
    const price = parsed.price ?? extractPrice(text) ?? undefined;
    const packages = parsed.packages;
    const mechanism = parsed.mechanism || extractMechanism(text);
    const commission = parsed.commission ?? extractCommission(text) ?? undefined;
    const links = makeQuickLinkRows(entries, "draft").map((link) => ({ platform: link.platform, linkMode: link.linkMode, url: link.url, creatorLinks: link.creatorLinks }));
    if (!name || price === undefined || price <= 0 || !links.length || !mechanism || commission === undefined) {
      openQuickEntry(text, imageFile, imagePreview);
      reply(imageFile ? "产品图片已带入补全卡片。请一次补齐标红项目后确认保存。" : "我已识别你发送的资料，并打开补全卡片。请一次补齐标红项目后确认保存，不需要再逐条回复。 ");
      return;
    }
    void saveCompletedDraft({ name, manufacturer, skus: parsed.skuEntries, price, mechanism, commission, status: parsed.productStatus, packages, links, awaiting: "mechanism" }, imageFile);
  }

  function continueDraft(text: string, current: Draft) {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setDraft(null); reply("你的编辑权限已关闭，本次录入没有保存。"); return; }
    if (current.awaiting === "name") {
      const name = text.replace(/^(?:产品|商品)?(?:名称)?(?:是|叫|为|[:：])?\s*/, "").trim();
      if (!name) return reply("我还没有识别到产品名称，请再说一次。 ");
      const nextAwaiting = current.price === undefined ? "price" : !current.links.length ? "link" : !current.mechanism ? "mechanism" : "commission";
      const next = { ...current, name, awaiting: nextAwaiting as Draft["awaiting"] };
      if (current.price !== undefined && current.links.length && current.mechanism && current.commission !== undefined) {
        void saveCompletedDraft(next);
        return;
      }
      setDraft(next);
      reply(current.price === undefined
        ? `好的，产品是“${name}”。现在请补充单品价格。`
        : current.links.length
        ? !current.mechanism
          ? `好的，产品是“${name}”。现在请补充规格、买赠等产品机制。`
          : `好的，产品是“${name}”。现在请按百分比补充佣金。`
        : `好的，产品是“${name}”。现在请发平台名称和链接。`);
      return;
    }
    if (current.awaiting === "price") {
      const price = extractPrice(text) ?? Number(text.replace(/[¥￥元块\s]/g, ""));
      if (!Number.isFinite(price) || price <= 0) return reply("价格格式不正确，请输入例如“59.9”或“单品价59.9元”。");
      const next = { ...current, price, awaiting: (!current.links.length ? "link" : !current.mechanism ? "mechanism" : "commission") as Draft["awaiting"] };
      if (current.links.length && current.mechanism && current.commission !== undefined) void saveCompletedDraft(next);
      else { setDraft(next); reply(!current.links.length ? "价格已记录。现在请发平台名称和链接。" : "价格已记录。请继续补充产品机制和佣金。"); }
      return;
    }
    if (current.awaiting === "link") {
      const entries = extractLinkEntries(text);
      if (entries.length === 0) return reply("没有识别到链接内容。请按“抖音链接 你的链接内容”重新发送，链接不需要以 https 开头。 ");
      const mechanism = extractMechanism(text);
      const commission = extractCommission(text) ?? undefined;
      const next: Draft = {
        ...current,
        links: makeQuickLinkRows(entries, "draft").map((link) => ({ platform: link.platform, linkMode: link.linkMode, url: link.url, creatorLinks: link.creatorLinks })),
        mechanism,
        commission,
        awaiting: mechanism ? "mechanism" : "mechanism",
      };
      if (mechanism) void saveCompletedDraft(next);
      else {
        setDraft(next);
        reply("链接收到了。最后请补充到手价格、规格数量和买赠活动等产品机制。 ");
      }
      return;
    }
    if (current.awaiting === "commission") {
      const commission = extractCommission(text);
      if (commission === null) return reply("佣金格式不正确，请用百分比填写，例如“35%”或“佣金35%”。 ");
      void saveCompletedDraft({ ...current, commission });
      return;
    }
    const mechanism = extractMechanism(text) ?? text.trim();
    if (mechanism.length < 2) return reply("机制内容太短了，请至少告诉我价格或活动信息。 ");
    const commission = extractCommission(text) ?? undefined;
    void saveCompletedDraft({ ...current, mechanism, commission: commission ?? current.commission });
  }

  function resolveConversationProduct(query = "") {
    if (query.trim()) return findProducts(database.products, query)[0];
    return database.products.find((product) => product.id === activeProductId);
  }

  function describeProductChanges(before: Product, after: Product) {
    const changes: string[] = [];
    if (before.name !== after.name) changes.push(`产品名称：${before.name} → ${after.name}`);
    if (before.manufacturer !== after.manufacturer) changes.push(`厂家：${before.manufacturer} → ${after.manufacturer}`);
    if (before.price !== after.price) changes.push(`单品价格：${formatProductPrice(before.price)} → ${formatProductPrice(after.price)}`);
    if (before.mechanism !== after.mechanism) changes.push(`产品机制：${before.mechanism} → ${after.mechanism}`);
    if (before.commission !== after.commission) changes.push(`统一佣金：${before.commission}% → ${after.commission}%`);
    if (JSON.stringify(normalizedSkuEntries(before.skus, before.sku)) !== JSON.stringify(normalizedSkuEntries(after.skus, after.sku))) changes.push("SKU / 规格及对应价格将恢复到修改前");
    if (before.status !== after.status) changes.push(`推广状态：${before.status} → ${after.status}`);
    if (JSON.stringify(before.packages) !== JSON.stringify(after.packages)) changes.push("套餐资料将恢复到修改前");
    const platforms = new Set([...before.links.map((link) => link.platform), ...after.links.map((link) => link.platform)]);
    platforms.forEach((platform) => {
      const previous = before.links.find((link) => link.platform === platform);
      const next = after.links.find((link) => link.platform === platform);
      if (!previous && next) changes.push(`${platform}：恢复平台资料`);
      else if (previous && !next) changes.push(`${platform}：移除后来添加的平台资料`);
      else if (previous && next) {
        if (previous.url !== next.url) changes.push(`${platform}链接：${previous.url} → ${next.url}`);
        if (previous.status !== next.status) changes.push(`${platform}链接状态：${previous.status} → ${next.status}`);
      }
    });
    return changes;
  }

  function stageProductChange(product: Product, updated: Product) {
    const changes = describeProductChanges(product, updated);
    if (!changes.length) {
      setActiveProductId(product.id);
      reply(`“${product.name}”目前已经是你要求的内容，不需要修改。`, [product], { productActions: true });
      return;
    }
    setActiveProductId(product.id);
    setPendingChange({ kind: "edit", productId: product.id, before: product, after: updated, changes });
    const lowCommissionWarning = product.commission !== updated.commission && updated.commission < 30
      ? "\n\n提醒：产品佣金低于30%，低于规定水平，但确认后仍可保存。"
      : "";
    reply(`是否将“${product.name}”的信息更改为以下内容？\n${changes.map((item) => `• ${item}`).join("\n")}\n\n点击下方“确认”后才会保存；点击“取消”则不改动。${lowCommissionWarning}`, [updated]);
  }

  function prepareConversationalEdit(text: string) {
    const edit = parseConversationalProductEdit(text);
    if (!edit.fieldCount) return false;
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { reply("你当前只有查看权限，请联系管理员开启“新增 / 编辑”权限。"); return true; }
    const isContextual = !edit.query;
    const product = resolveConversationProduct(edit.query);
    if (!product) {
      reply(isContextual ? "我还不知道你指的是哪款产品。请先查询产品，再直接告诉我要修改的字段。" : `没有找到“${edit.query}”。`);
      return true;
    }
    if (edit.price !== undefined && (!Number.isFinite(edit.price) || edit.price <= 0 || edit.price > 99_999_999)) {
      reply("单品价格格式不正确，请输入大于0的金额。");
      return true;
    }
    if (edit.commission !== undefined && (!Number.isFinite(edit.commission) || edit.commission < 0 || edit.commission > 100)) {
      reply("佣金必须是0%到100%之间的百分比。");
      return true;
    }
    const timestamp = nowIso();
    const links = product.links.map((link) => {
      return {
        ...link,
        mechanism: edit.mechanism ?? link.mechanism,
        commission: edit.commission ?? link.commission,
      };
    });
    const updated: Product = {
      ...product,
      price: edit.price ?? product.price,
      mechanism: edit.mechanism ?? product.mechanism,
      commission: edit.commission ?? product.commission,
      status: edit.productStatus ?? product.status,
      links,
      updatedAt: timestamp,
    };
    stageProductChange(product, updated);
    return true;
  }

  function prepareUndo() {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { reply("你当前没有编辑权限，无法撤销产品修改。"); return; }
    const latest = database.activity.find((item) => item.actorEmail === database.user?.email && item.action === "update" && item.entityType === "product" && item.beforeJson);
    if (!latest?.beforeJson) {
      reply("暂时没有找到可以撤销的最近一次产品修改。");
      return;
    }
    const current = database.products.find((product) => product.id === latest.entityId);
    if (!current) {
      reply("最近修改的产品当前不在产品库中，无法直接撤销。");
      return;
    }
    try {
      const snapshot = JSON.parse(latest.beforeJson) as Partial<Product>;
      if (!snapshot.id || !snapshot.name || !Array.isArray(snapshot.links)) throw new Error("invalid snapshot");
      const restored: Product = {
        ...current,
        ...snapshot,
        id: current.id,
        status: snapshot.status ?? "正常推广",
        imageUrl: current.imageUrl,
        packages: snapshot.packages ?? [],
        links: snapshot.links,
        revision: current.revision,
        updatedAt: nowIso(),
      };
      const changes = describeProductChanges(current, restored);
      if (!changes.length) {
        reply(`“${current.name}”已经是修改前的内容，不需要再次撤销。`, [current]);
        return;
      }
      setActiveProductId(current.id);
      setPendingChange({ kind: "undo", productId: current.id, before: current, after: restored, changes });
      reply(`准备撤销“${current.name}”最近一次修改：\n${changes.map((item) => `• ${item}`).join("\n")}\n\n请回复“确认撤销”继续，或回复“取消撤销”。`, [restored]);
    } catch {
      reply("最近一次修改记录不完整，暂时无法自动撤销。你仍可打开产品卡片手动修改。", [current]);
    }
  }

  async function confirmPendingChange() {
    if (!pendingChange) return;
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setPendingChange(null); reply("你的编辑权限已关闭，本次修改没有保存。"); return; }
    const current = database.products.find((product) => product.id === pendingChange.productId);
    if (!current || current.revision !== pendingChange.before.revision) {
      setPendingChange(null);
      await refresh(true);
      reply("这款产品刚刚被其他成员修改了。为避免覆盖新资料，本次操作已取消，请重新发起修改。");
      return;
    }
    const after = { ...pendingChange.after, revision: current.revision, updatedAt: nowIso() };
    const saved = await commit({ ...database, products: database.products.map((product) => product.id === after.id ? after : product) });
    if (saved) {
      setActiveProductId(after.id);
      reply(pendingChange.kind === "undo" ? `已撤销“${after.name}”最近一次修改。` : `已确认并保存“${after.name}”的修改。`, [after]);
    }
    setPendingChange(null);
  }

  function queryByConditions(text: string) {
    if (!/(找出|筛选|哪些|查看|查询|搜索)/.test(text)) return false;
    const status: ProductStatus | undefined = text.includes("正常推广") ? "正常推广" : text.includes("暂停推广") ? "暂停推广" : text.includes("已下架") ? "已下架" : undefined;
    const platform = PLATFORMS.find((item) => item !== "其他" && text.includes(item));
    const staleMatch = text.match(/(?:超过|大于|超出)\s*(\d+)\s*天.*(?:没|未)?更新|(?:没|未)更新.*?(\d+)\s*天|过期链接|陈旧链接/);
    const wantsStale = Boolean(staleMatch);
    const staleThreshold = Number(staleMatch?.[1] ?? staleMatch?.[2] ?? 7);
    const commissionAtLeast = text.match(/佣金\s*(?:不低于|不少于|至少|大于等于|≥|>=)\s*(\d+(?:\.\d+)?)\s*[%％]?/);
    const commissionBelow = text.match(/佣金\s*(?:低于|少于|小于|<)\s*(\d+(?:\.\d+)?)\s*[%％]?/);
    const commissionAbove = text.match(/佣金\s*(?:高于|大于|超过|>)\s*(\d+(?:\.\d+)?)\s*[%％]?/);
    const priceAtMost = text.match(/(?:价格|单品价)\s*(?:不高于|不超过|最多|小于等于|≤|<=|低于|小于)\s*[¥￥]?(\d+(?:\.\d+)?)/);
    const priceAtLeast = text.match(/(?:价格|单品价)\s*(?:不低于|至少|大于等于|≥|>=|高于|大于)\s*[¥￥]?(\d+(?:\.\d+)?)/);
    const hasCondition = Boolean(status || platform || wantsStale || commissionAtLeast || commissionBelow || commissionAbove || priceAtMost || priceAtLeast);
    if (!hasCondition) return false;
    const productMatches = database.products.flatMap((product) => {
      if (status && product.status !== status) return [];
      if (priceAtMost && product.price > Number(priceAtMost[1])) return [];
      if (priceAtLeast && product.price < Number(priceAtLeast[1])) return [];
      if (commissionAtLeast && product.commission < Number(commissionAtLeast[1])) return [];
      if (commissionBelow && product.commission >= Number(commissionBelow[1])) return [];
      if (commissionAbove && product.commission <= Number(commissionAbove[1])) return [];
      const needsLinkFilter = Boolean(platform || wantsStale);
      const links = product.links.flatMap((link) => {
        if (platform && link.platform !== platform) return [];
        if (wantsStale) {
          const staleTargets = filterLinkTargets(link, (target) => staleLinkDays(target) > staleThreshold);
          return staleTargets ? [staleTargets] : [];
        }
        return [link];
      });
      if (needsLinkFilter && !links.length) return [];
      return [{ ...product, links: needsLinkFilter ? links : product.links }];
    });
    if (productMatches.length === 1) setActiveProductId(productMatches[0].id);
    else setActiveProductId(null);
    const labels = [status, platform, wantsStale ? `超过${staleThreshold}天未更新` : "", commissionAtLeast ? `佣金不低于${commissionAtLeast[1]}%` : "", commissionBelow ? `佣金低于${commissionBelow[1]}%` : "", commissionAbove ? `佣金高于${commissionAbove[1]}%` : "", priceAtMost ? `价格不高于${priceAtMost[1]}元` : "", priceAtLeast ? `价格不低于${priceAtLeast[1]}元` : ""].filter(Boolean).join("、");
    reply(productMatches.length ? `按“${labels}”找到 ${productMatches.length} 款产品：` : `没有找到符合“${labels}”的产品。`, productMatches);
    return true;
  }

  function runPreflightCheck(text: string) {
    if (!/(上品前检查|能不能上品|能否上品|是否可以上品|可以不可以上品|能不能推广|能否推广)/.test(text)) return false;
    const platform = PLATFORMS.find((item) => item !== "其他" && text.includes(item));
    const query = text
      .replace(/(?:请帮我|帮我|请|检查一下|检查|看一下|看看|现在|上品前检查|能不能上品|能否上品|是否可以上品|可以不可以上品|能不能推广|能否推广|这款|这个|产品|商品|吗|呢|[？?。！!])/g, "")
      .replace(new RegExp(PLATFORMS.join("|"), "g"), "")
      .replace(/的$/, "")
      .trim();
    const product = resolveConversationProduct(query);
    if (!product) {
      reply(query ? `没有找到“${query}”。` : "请先告诉我要检查哪款产品，例如“XX能不能上品？”");
      return true;
    }
    setActiveProductId(product.id);
    const links = platform ? product.links.filter((link) => link.platform === platform) : product.links;
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (product.status === "暂停推广") blockers.push("产品当前为暂停推广");
    if (product.status === "已下架") blockers.push("产品已经下架");
    if (!links.length) blockers.push(`没有保存${platform ?? "任何平台"}链接`);
    links.forEach((link) => {
      productLinkTargets(link).forEach((target) => {
        const label = productLinkMode(link) === "creator" ? `${link.platform}达人“${target.creatorName}”` : link.platform;
        if (target.status === "已失效") blockers.push(`${label}链接已失效`);
        else if (target.status !== "有效") warnings.push(`${label}链接状态为${target.status}`);
        const days = staleLinkDays(target);
        if (days > 7) warnings.push(`${label}链接已${days}天未更新`);
      });
    });
    if (product.commission < 30) warnings.push(`产品统一佣金${product.commission}%，低于30%`);
    const verdict = blockers.length ? "不建议上品" : warnings.length ? "建议先检查" : "可以上品";
    const detail = [...blockers.map((item) => `• 阻止项：${item}`), ...warnings.map((item) => `• 提醒项：${item}`)];
    reply(`“${product.name}”检查结果：${verdict}。\n${detail.length ? detail.join("\n") : "• 产品状态、链接状态、更新时间和佣金均无异常。"}`, [{ ...product, links }]);
    return true;
  }

  function queryLinks(text: string) {
    const platform = PLATFORMS.find((item) => item !== "其他" && text.includes(item));
    const requestedCreator = database.products.flatMap((product) => product.links.flatMap((link) => (link.creatorLinks ?? []).map((item) => item.creatorName))).filter(Boolean).sort((a, b) => b.length - a.length).find((name) => text.includes(name));
    const query = extractQueryName(requestedCreator ? text.replace(requestedCreator, "") : text);
    const matches = findProducts(database.products, query);
    if (!matches.length) {
      reply(`产品库里暂时没有找到“${query || "这款产品"}”。你可以说“添加产品……”来录入。`);
      return;
    }
    const bestScore = fuzzyScore(matches[0], query);
    const selected = matches.filter((product) => fuzzyScore(product, query) >= Math.max(38, bestScore - 8)).slice(0, 4);
    const filtered = selected.map((product) => ({
      ...product,
      links: (platform ? product.links.filter((link) => link.platform === platform) : product.links).map((link) => requestedCreator && productLinkMode(link) === "creator" ? { ...link, creatorLinks: link.creatorLinks.filter((item) => item.creatorName === requestedCreator) } : link).filter((link) => !requestedCreator || productLinkMode(link) === "shared" || link.creatorLinks.length),
    })).filter((product) => product.links.length);
    if (!filtered.length) {
      reply(`找到了“${matches[0].name}”，但还没有保存${platform ?? "对应平台"}链接。`);
      return;
    }
    if (filtered.length === 1) setActiveProductId(filtered[0].id);
    else setActiveProductId(null);
    reply(filtered.length > 1 ? "找到了几个相近的产品，请确认你要的是哪一个：" : `这是“${filtered[0].name}”${requestedCreator ? `给达人“${requestedCreator}”使用的` : "的"}链接、单品价、套餐、产品机制和佣金：`, filtered);
  }

  function queryPrices(text: string) {
    if (!/(?:多少钱|单品价|单品价格|套餐|价格)/.test(text)) return false;
    if (/(?:添加|新增|录入|记录|保存|修改|编辑|更新)/.test(text)) return false;
    const normalizedText = normalizeSearchText(text);
    const skuMatch = database.products.flatMap((product) => normalizedSkuEntries(product.skus, product.sku).map((sku) => ({ product, sku })))
      .find(({ sku }) => {
        const value = normalizeSearchText(sku.value);
        return value.length >= 2 && normalizedText.includes(value);
      });
    const matches = fuzzyFind(database.products, text, 4);
    if (!matches.length) {
      if (skuMatch) matches.push({ product: skuMatch.product, score: 100 });
      const cleaned = text.replace(/(?:请问|帮我|查询|查一下|的|套餐|单品|价格|价钱|多少钱|是多少|有哪些|是什么|呢|吗|？|\?)/g, "").trim();
      if (!matches.length) {
        const fallback = findProducts(database.products, cleaned)[0];
        if (!fallback) { reply("没有找到对应产品。你可以把产品名称说得完整一些。 "); return true; }
        matches.push({ product: fallback, score: fuzzyScore(fallback, cleaned) });
      }
    }
    const directlyNamed = database.products
      .filter((item) => normalizedText.includes(normalizeSearchText(item.name)))
      .sort((left, right) => normalizeSearchText(right.name).length - normalizeSearchText(left.name).length);
    const product = skuMatch?.product ?? directlyNamed[0] ?? matches[0].product;
    setActiveProductId(product.id);
    if (skuMatch?.sku.price !== null) {
      reply(`“${product.name}”的“${skuMatch.sku.value}”规格价格是 ${formatProductPrice(skuMatch.sku.price)}。`, [product]);
      return true;
    }
    const matchedPackage = product.packages.find((item) => normalizedText.includes(normalizeSearchText(item.name)));
    if (matchedPackage) {
      reply(`“${product.name}”的“${matchedPackage.name}”套餐价格是 ${formatProductPrice(matchedPackage.price)}${matchedPackage.description ? `，套餐内容：${matchedPackage.description}` : ""}。单品价是 ${formatProductPrice(product.price)}。`, [product]);
      return true;
    }
    const packageText = product.packages.length
      ? `套餐：${product.packages.map((item) => `${item.name} ${formatProductPrice(item.price)}${item.description ? `（${item.description}）` : ""}`).join("；")}。`
      : "目前没有额外套餐。";
    reply(`“${product.name}”的单品价是 ${formatProductPrice(product.price)}。${packageText}`, [product]);
    return true;
  }

  function queryBareProductName(text: string) {
    if (!database.products.length || text.length > 50) return false;
    if (/(?:添加|新增|录入|记录|保存|修改|编辑|更新|删除|移除|检测|检查|筛选|日报|周报|批量)/.test(text)) return false;
    const matches = fuzzyFind(database.products, text, 5);
    if (!matches.length || matches[0].score < 55) return false;
    const bestScore = matches[0].score;
    const products = matches
      .filter((item) => item.score >= Math.max(55, bestScore - 8))
      .map((item) => item.product)
      .slice(0, 4);
    if (products.length === 1) setActiveProductId(products[0].id);
    else setActiveProductId(null);
    reply(
      products.length === 1
        ? `已找到“${products[0].name}”。你可以直接查看资料，也可以选择下一步操作：`
        : "找到几款名称相近的产品，请在正确的产品卡片上选择下一步操作：",
      products,
      { productActions: true },
    );
    return true;
  }

  function updateMechanism(text: string) {
    const match = text.match(/(?:把|更新|修改)?\s*(.+?)(?:的)?(抖音|视频号|小红书|淘宝|天猫|京东|快手|拼多多)?(?:的)?(?:产品)?机制\s*(?:改成|更新为|修改为|是|为|[:：])\s*(.+)$/);
    if (!match) return false;
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { reply("你当前没有编辑权限，无法修改产品机制。"); return true; }
    const query = match[1].trim();
    const mechanism = match[3].trim();
    const product = findProducts(database.products, query)[0];
    if (!product) { reply(`没有找到“${query}”。`); return true; }
    const links = product.links.map((link) => ({ ...link, mechanism }));
    const updated = { ...product, mechanism, links, updatedAt: nowIso() };
    stageProductChange(product, updated);
    return true;
  }

  function updateCommission(text: string) {
    const match = text.match(/(?:把|更新|修改)?\s*(.+?)(?:的)?(抖音|视频号|小红书|淘宝|天猫|京东|快手|拼多多)?(?:的)?佣金\s*(?:改成|更新为|修改为|是|为|[:：])\s*(\d+(?:\.\d+)?)\s*[%％]$/);
    if (!match) return false;
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { reply("你当前没有编辑权限，无法修改佣金。"); return true; }
    const query = match[1].trim();
    const commission = Number(match[3]);
    if (!Number.isFinite(commission) || commission < 0 || commission > 100) { reply("佣金必须是0%到100%之间的百分比。 "); return true; }
    const product = findProducts(database.products, query)[0];
    if (!product) { reply(`没有找到“${query}”。`); return true; }
    const links = product.links.map((link) => ({ ...link, commission }));
    const updated = { ...product, commission, links, updatedAt: nowIso() };
    stageProductChange(product, updated);
    return true;
  }

  function updateProductStatus(text: string) {
    if (text.includes("链接") || !/(正常推广|暂停推广|暂停|已下架|下架|恢复推广|恢复正常)/.test(text)) return false;
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { reply("你当前没有编辑权限，无法切换产品状态。"); return true; }
    const status: ProductStatus = /暂停/.test(text) ? "暂停推广" : /下架/.test(text) ? "已下架" : "正常推广";
    const query = text
      .replace(/^(?:把|将|请把|请将)/, "")
      .replace(/(?:的)?(?:产品|商品)?(?:推广状态|状态)?\s*(?:改成|更新为|修改为|设为|标记为|是|为)?\s*(?:正常推广|暂停推广|暂停|已下架|下架|恢复推广|恢复正常)(?:了)?[。.!！]?$/, "")
      .replace(/(?:这款|这个)?(?:产品|商品)$/g, "")
      .trim();
    const product = findProducts(database.products, query)[0];
    if (!product) { reply(`没有找到“${query || "这款产品"}”。`); return true; }
    const updated = { ...product, status, updatedAt: nowIso() };
    stageProductChange(product, updated);
    return true;
  }

  function updateLinkStatus(text: string) {
    if (!text.includes("链接") || !/(失效|无效|下架|待复核|恢复有效)/.test(text)) return false;
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { reply("你当前没有编辑权限，无法修改链接状态。"); return true; }
    const platform = PLATFORMS.find((item) => item !== "其他" && text.includes(item));
    const status: LinkStatus = text.includes("恢复有效") ? "有效" : text.includes("待复核") ? "待复核" : "已失效";
    const query = text
      .replace(/^(?:把|将)/, "")
      .replace(new RegExp(`(?:的)?(?:${PLATFORMS.join("|")})?(?:的)?链接(?:标记为)?(?:已经|已)?(?:失效|无效|下架|待复核|恢复有效)(?:了)?`), "")
      .replace(/[，,。.!！?？\s]/g, "");
    const product = findProducts(database.products, query)[0];
    if (!product) { reply(`没有找到“${query || "这款产品"}”。`); return true; }
    const links = product.links.map((link) => !platform || link.platform === platform ? { ...link, status, updatedAt: nowIso() } : link);
    const updated = { ...product, links, updatedAt: nowIso() };
    stageProductChange(product, updated);
    return true;
  }

  function requestProductEdit(text: string) {
    const query = extractEditQuery(text);
    if (!query) return false;
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { reply("你当前只有查看权限，请联系管理员开启“新增 / 编辑”权限。"); return true; }
    const matches = fuzzyFind(database.products, query, 4);
    if (!matches.length) {
      reply(`没有找到与“${query}”相近的产品。你可以换一个简称，或到产品库中搜索。`);
      return true;
    }
    const bestScore = matches[0].score;
    const products = matches
      .filter((item) => item.score >= Math.max(38, bestScore - 10))
      .map((item) => item.product)
      .slice(0, 4);
    reply(
      products.length > 1
        ? `找到 ${products.length} 款相近产品，请在正确的产品卡片上选择要做的操作：`
        : `找到了“${products[0].name}”。你可以直接编辑全部资料，也可以在对话中只修改某一项：`,
      products,
      { productActions: true },
    );
    if (products.length === 1) setActiveProductId(products[0].id);
    else setActiveProductId(null);
    return true;
  }

  function deleteByChat(text: string) {
    const match = text.match(/^(?:删除|移除)(?:产品|商品)?\s*(.+)$/);
    if (!match) return false;
    const product = findProducts(database.products, match[1])[0];
    if (!product) { reply(`没有找到“${match[1]}”。`); return true; }
    if (!(database.user?.role === "admin" || database.user?.canDelete)) { reply("你当前没有删除权限，请联系管理员开启“删除 / 恢复”权限。 "); return true; }
    if (!window.confirm(`确定删除“${product.name}”及其全部平台链接吗？`)) {
      reply("已取消删除。 ");
      return true;
    }
    commit({ ...database, products: database.products.filter((item) => item.id !== product.id) });
    reply(`已删除“${product.name}”。`);
    return true;
  }

  function reportDuplicates() {
    const nameGroups = new Map<string, Product[]>();
    const urlGroups = new Map<string, Array<{ product: Product; link: ProductLink; creatorName: string }>>();
    database.products.forEach((product) => {
      const nameKey = normalizeSearchText(product.name);
      if (nameKey) nameGroups.set(nameKey, [...(nameGroups.get(nameKey) ?? []), product]);
      product.links.forEach((link) => productLinkTargets(link).forEach((target) => {
        const urlKey = target.url.trim();
        if (urlKey) urlGroups.set(urlKey, [...(urlGroups.get(urlKey) ?? []), { product, link, creatorName: target.creatorName }]);
      }));
    });
    const duplicateNames = [...nameGroups.values()].filter((products) => products.length > 1);
    const duplicateLinks = [...urlGroups.values()].filter((matches) => matches.length > 1);
    const similarPairs: Array<{ left: Product; right: Product }> = [];
    for (let leftIndex = 0; leftIndex < database.products.length && similarPairs.length < 5; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < database.products.length && similarPairs.length < 5; rightIndex += 1) {
        const left = database.products[leftIndex];
        const right = database.products[rightIndex];
        if (normalizeSearchText(left.name) !== normalizeSearchText(right.name) && fuzzyScore(left, right.name) >= 92) {
          similarPairs.push({ left, right });
        }
      }
    }
    const affected = [
      ...duplicateNames.flat(),
      ...duplicateLinks.flatMap((matches) => matches.map((match) => match.product)),
      ...similarPairs.flatMap((pair) => [pair.left, pair.right]),
    ].filter((product, index, products) => products.findIndex((item) => item.id === product.id) === index).slice(0, 12);
    if (!duplicateNames.length && !duplicateLinks.length && !similarPairs.length) {
      reply("检测完成：没有发现重复产品、重复链接或高度相似的产品名称。");
      return;
    }
    const summary = [
      duplicateNames.length ? `${duplicateNames.length} 组重复产品名称` : "",
      duplicateLinks.length ? `${duplicateLinks.length} 组重复链接` : "",
      similarPairs.length ? `${similarPairs.length} 组相似名称提醒（不判定为重复）` : "",
    ].filter(Boolean).join("、");
    const similarDetail = similarPairs.length
      ? `\n相似名称：${similarPairs.map((pair) => `“${pair.left.name}”与“${pair.right.name}”`).join("；")}`
      : "";
    reply(`检测完成：发现${summary}。重复项需要编辑处理，相似名称只供你确认。${similarDetail}`, affected);
  }

  function handleText(raw: string) {
    const text = raw.trim();
    const imageFile = composerImageFile;
    const imagePreview = composerImagePreview;
    if (!text && !imageFile) return;
    addUserMessage(text || "产品图片", imagePreview || undefined);
    setInput("");
    clearComposerImage();
    if (pendingChange) {
      if (/^确认(?:修改|撤销)?$/.test(text)) { void confirmPendingChange(); return; }
      if (/^(?:取消|取消修改|取消撤销|算了|不用了)$/.test(text)) {
        const label = pendingChange.kind === "undo" ? "撤销" : "修改";
        setPendingChange(null);
        reply(`已取消本次${label}，产品资料没有变化。`);
        return;
      }
      reply(`还有一项${pendingChange.kind === "undo" ? "撤销" : "修改"}等待确认。请回复“确认${pendingChange.kind === "undo" ? "撤销" : "修改"}”或“取消${pendingChange.kind === "undo" ? "撤销" : "修改"}”。`);
      return;
    }
    if (imageFile) {
      setDraft(null);
      return startAdd(text, imageFile, imagePreview);
    }
    if (draft) return continueDraft(text, draft);
    if (/^(取消|算了|不用了)$/.test(text)) { setDraft(null); reply("好的，已取消当前录入。 "); return; }
    if (/^(?:请)?撤销(?:刚才|最近|上一次)?(?:的)?修改[。.!！]?$/.test(text)) { prepareUndo(); return; }
    if (/(批量导入|批量录入|一次录入多款|一次导入多款)/.test(text)) {
      if (!(database.user?.role === "admin" || database.user?.canEdit)) { reply("你当前没有新增权限，无法批量导入产品。"); return; }
      openBatchImport();
      reply("批量导入已打开。你可以粘贴多款产品的聊天记录，也可以上传备用表格。 ");
      return;
    }
    if (/^(?:检测|检查|查找|扫描)(?:一下)?(?:产品库)?(?:中的)?(?:重复|重复产品|重复链接|重复产品和链接|重复资料)$/.test(text)
      || /(?:检测|检查|扫描).*(?:重复产品|重复链接|重复资料)/.test(text)) {
      reportDuplicates();
      return;
    }
    if (/(添加|新增|录入|记录|保存).*(产品|商品|链接)|^(添加|新增|录入|记录|保存)/.test(text)) return startAdd(text);
    if (runPreflightCheck(text)) return;
    if (prepareConversationalEdit(text)) return;
    if (updateCommission(text)) return;
    if (updateMechanism(text)) return;
    if (/(?:今日日报|今天日报|查看日报|生成日报|日报)$/.test(text)) {
      reply(buildProductReport(database.products, database.activity, "daily").text);
      return;
    }
    if (/(?:本周周报|查看周报|生成周报|周报)$/.test(text)) {
      reply(buildProductReport(database.products, database.activity, "weekly").text);
      return;
    }
    if (updateProductStatus(text)) return;
    if (updateLinkStatus(text)) return;
    if (requestProductEdit(text)) return;
    if (deleteByChat(text)) return;
    if (queryByConditions(text)) return;
    if (/(全部产品|产品列表|所有产品|我有多少产品)/.test(text)) {
      if (!database.products.length) reply("产品库目前是空的。试试说：添加产品晴雨伞，抖音链接 你的链接，机制到手价79元赠旅行装，佣金35%");
      else reply(`目前共有 ${database.products.length} 款产品、${database.products.reduce((sum, product) => sum + product.links.length, 0)} 条平台链接。`, database.products.slice(0, 20));
      return;
    }
    if (/(哪些|查看|查询).*(失效|待复核)|失效链接|待复核链接/.test(text)) {
      const problem = database.products.map((product) => ({ ...product, links: product.links.map((link) => filterLinkTargets(link, (target) => target.status !== "有效")).filter((link): link is ProductLink => Boolean(link)) })).filter((product) => product.links.length);
      reply(problem.length ? "这些链接需要你留意：" : "目前没有已标记为失效或待复核的链接。", problem);
      return;
    }
    if (/(哪些|查看|查询).*(暂停推广|已下架)|暂停推广产品|已下架产品/.test(text)) {
      const targetStatus: ProductStatus = text.includes("暂停") ? "暂停推广" : "已下架";
      const products = database.products.filter((product) => product.status === targetStatus);
      reply(products.length ? `这些产品目前是${targetStatus}状态：` : `目前没有${targetStatus}的产品。`, products);
      return;
    }
    if (/(超过|超出)?\s*7\s*天.*(?:没|未).*更新|过期链接|陈旧链接/.test(text)) {
      const stale = database.products.map((product) => ({ ...product, links: product.links.map((link) => filterLinkTargets(link, (target) => staleLinkDays(target) > 7)).filter((link): link is ProductLink => Boolean(link)) })).filter((product) => product.links.length);
      reply(stale.length ? "这些链接超过7天未更新，上品前请检查链接及佣金：" : "目前没有超过7天未更新的链接。", stale);
      return;
    }
    if (queryPrices(text)) return;
    if (/(链接|地址|口令)/.test(text)) return queryLinks(text);
    if (queryBareProductName(text)) return;
    reply("我还没理解这句话。你可以说“XX的抖音链接是什么”“XX能不能上品”“找出正常推广且佣金不低于30%的产品”，或直接修改产品资料。");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    handleText(input);
  }

  async function copy(value: string, label = "链接") {
    await navigator.clipboard.writeText(value);
    setToast(`${label}已复制`);
  }

  async function checkLink(productId: string, linkId: string, url: string, creatorLinkId?: string) {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setToast("管理员未开放产品编辑权限"); return; }
    setChecking(creatorLinkId ?? linkId);
    try {
      const response = await fetch("/api/check-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) throw new Error("unavailable");
      const result = await response.json();
      const timestamp = nowIso();
      const products = database.products.map((product) => product.id !== productId ? product : {
        ...product,
        updatedAt: timestamp,
        links: product.links.map((link) => link.id !== linkId ? link : {
          ...link,
          ...(creatorLinkId ? { creatorLinks: link.creatorLinks.map((item) => item.id !== creatorLinkId ? item : { ...item, lastCheckedAt: timestamp, updatedAt: timestamp, checkNote: result.message, status: result.kind === "suspected" ? "疑似失效" as LinkStatus : item.status }) } : { lastCheckedAt: timestamp, checkNote: result.message, status: result.kind === "suspected" ? "疑似失效" as LinkStatus : link.status }),
        }),
      });
      commit({ ...database, products });
      setToast(result.message);
    } catch {
      setToast("链接检测失败，请稍后重试");
    } finally {
      setChecking(null);
    }
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(database, null, 2)], { type: "application/json;charset=utf-8" });
    downloadBlob(blob, `产品链接管家备份-${new Date().toISOString().slice(0, 10)}.json`);
    setToast("备份已导出");
  }

  function exportCsv() {
    const header = ["产品名称", "厂家", "SKU / 产品规格", "单品价格", "产品状态", "套餐（选填）", "平台", "链接方式", "达人（选填）", "链接", "产品机制", "佣金", "链接状态", "更新时间"];
    const lines = [header, ...database.products.flatMap((product) => product.links.flatMap((link) => productLinkTargets(link).map((target) => [
      product.name,
      product.manufacturer,
      normalizedSkuEntries(product.skus, product.sku).map((item) => `${item.value}${item.price === null ? "" : ` ${formatProductPrice(item.price)}`}`).join("；"),
      String(product.price),
      product.status,
      formatPackages(product.packages),
      link.platform,
      productLinkMode(link) === "creator" ? "达人专属链接" : "统一链接",
      productLinkMode(link) === "creator" ? target.creatorName : "",
      target.url,
      product.mechanism,
      `${product.commission}%`,
      target.status,
      target.updatedAt,
    ])))].map((row) => row.map(escapeCsv).join(","));
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `产品链接清单-${new Date().toISOString().slice(0, 10)}.csv`);
    setToast("Excel 可打开的清单已导出");
  }

  function downloadBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      let next: Database;
      if (file.name.toLowerCase().endsWith(".json")) {
        const parsed = JSON.parse(text) as { products?: Product[] };
        if (!Array.isArray(parsed.products)) throw new Error("invalid");
        const incomplete = parsed.products.some((product) => !Number.isFinite(product.price) || product.price <= 0
          || (product.packages ?? []).some((item) => !item.name?.trim() || !Number.isFinite(item.price) || item.price <= 0)
          || !(product.mechanism ?? product.links[0]?.mechanism)?.trim() || !Number.isFinite(Number(product.commission ?? product.links[0]?.commission)));
        if (incomplete) throw new Error("missing-required-fields");
        next = { ...database, products: parsed.products.map((product) => {
          const skus = normalizedSkuEntries(product.skus, product.sku);
          const timestamp = product.updatedAt || nowIso();
          const mechanism = String(product.mechanism ?? product.links[0]?.mechanism ?? "").trim();
          const commission = Number(product.commission ?? product.links[0]?.commission ?? 0);
          return {
            ...product,
            sku: skus[0]?.value ?? "",
            skus,
            status: PRODUCT_STATUSES.includes(product.status) ? product.status : "正常推广",
            price: Number(product.price ?? 0),
            mechanism,
            commission,
            packages: product.packages ?? [],
            imageUrl: product.imageUrl ?? "",
            revision: product.revision ?? 0,
            createdBy: product.createdBy ?? database.user?.email ?? "",
            updatedBy: product.updatedBy ?? database.user?.email ?? "",
            links: product.links.map((link) => {
              const creatorLinks = Array.isArray(link.creatorLinks) ? link.creatorLinks.filter((item) => item.creatorName?.trim() && item.url?.trim()).map((item) => ({ ...item, id: item.id || uid("creator"), status: item.status || "待复核" as LinkStatus, updatedAt: item.updatedAt || timestamp })) : [];
              const linkMode: LinkMode = link.linkMode === "creator" && creatorLinks.length ? "creator" : "shared";
              return { ...link, id: link.id || uid("link"), linkMode, url: linkMode === "shared" ? String(link.url ?? "").trim() : "", creatorLinks: linkMode === "creator" ? creatorLinks : [], mechanism, commission, status: link.status || "待复核" as LinkStatus, updatedAt: link.updatedAt || timestamp };
            }),
          };
        }) };
      } else {
        const rows = parseCsv(text);
        if (rows.length < 2) throw new Error("invalid");
        const headers = rows[0].map((value) => value.trim());
        const col = (name: string) => headers.indexOf(name);
        const priceColumn = col("单品价格") >= 0 ? col("单品价格") : col("产品价格");
        const required = ["产品名称", "平台", "链接", "产品机制", "佣金"];
        if (required.some((name) => col(name) < 0)) throw new Error("invalid");
        if (priceColumn < 0) throw new Error("invalid");
        const products: Product[] = [];
        rows.slice(1).forEach((row) => {
          const name = row[col("产品名称")]?.trim();
          const mechanism = row[col("产品机制")]?.trim();
          const url = row[col("链接")]?.trim();
          const price = Number(row[priceColumn]?.trim().replace(/[¥￥元块]/g, ""));
          const commissionValue = row[col("佣金")]?.trim().replace(/[％%]/g, "");
          const commission = Number(commissionValue);
          if (!name || !mechanism || !url || !Number.isFinite(price) || price <= 0 || !Number.isFinite(commission) || commission < 0 || commission > 100) return;
          let product = products.find((item) => normalizeSearchText(item.name) === normalizeSearchText(name));
          if (!product) {
            const timestamp = nowIso();
            const packages = col("套餐（选填）") >= 0
              ? extractPackages(`套餐：${row[col("套餐（选填）")]?.trim() ?? ""}`).map((item) => ({ id: uid("package"), ...item, updatedAt: timestamp }))
              : [];
            const importedStatus = row[col("产品状态")]?.trim() as ProductStatus;
            const skuColumn = col("SKU / 产品规格") >= 0 ? col("SKU / 产品规格") : col("SKU");
            const skus = skuColumn >= 0 ? splitSkuEntries(row[skuColumn]?.trim() || "") : [];
            product = { id: uid("product"), name, manufacturer: row[col("厂家")]?.trim() || "未填写", sku: skus[0]?.value ?? "", skus, price, mechanism, commission, status: PRODUCT_STATUSES.includes(importedStatus) ? importedStatus : "正常推广", packages, imageUrl: "", aliases: [], notes: "", revision: 0, createdBy: database.user?.email ?? "", updatedBy: database.user?.email ?? "", links: [], createdAt: timestamp, updatedAt: timestamp };
            products.push(product);
          }
          const platform = row[col("平台")]?.trim() || inferPlatform(url);
          const importedMode = col("链接方式") >= 0 ? row[col("链接方式")]?.trim() : "";
          const creatorName = col("达人（选填）") >= 0 ? row[col("达人（选填）")]?.trim() : (col("达人") >= 0 ? row[col("达人")]?.trim() : "");
          const creatorMode = Boolean(creatorName) || /达人|专属/.test(importedMode);
          const importedLinkStatus = (row[col("链接状态")] as LinkStatus) || (row[col("状态")] as LinkStatus) || "待复核";
          const timestamp = row[col("更新时间")]?.trim() || nowIso();
          const existingLink = product.links.find((item) => item.platform === platform);
          if (creatorMode && creatorName) {
            const creatorLink: CreatorLink = { id: uid("creator"), creatorName, url, status: importedLinkStatus, updatedAt: timestamp };
            if (existingLink) {
              if (productLinkMode(existingLink) === "shared" && existingLink.url.trim()) existingLink.creatorLinks.push({ id: uid("creator"), creatorName: "未标注达人", url: existingLink.url, status: existingLink.status, updatedAt: existingLink.updatedAt });
              existingLink.linkMode = "creator";
              existingLink.url = "";
              existingLink.creatorLinks.push(creatorLink);
            } else {
              product.links.push({ id: uid("link"), platform, linkMode: "creator", url: "", creatorLinks: [creatorLink], mechanism, commission, status: "有效", updatedAt: timestamp });
            }
          } else if (!existingLink) {
            product.links.push({ id: uid("link"), platform, linkMode: "shared", url, creatorLinks: [], mechanism, commission, status: importedLinkStatus, updatedAt: timestamp });
          }
        });
        next = { ...database, products };
      }
      if (!window.confirm(`将导入 ${next.products.length} 款产品，并替换当前产品库。是否继续？`)) return;
      commit(next);
      setToast("导入成功");
      reply(`已导入 ${next.products.length} 款产品。`);
    } catch (error) {
      setToast(error instanceof Error && error.message === "missing-required-fields" ? "导入失败：存在未填写价格、机制或佣金的产品" : "文件格式不正确");
    } finally {
      event.target.value = "";
    }
  }

  function removeProduct(product: Product) {
    if (!(database.user?.role === "admin" || database.user?.canDelete)) { setToast("管理员未开放产品删除权限"); return; }
    if (!window.confirm(`确定删除“${product.name}”及其全部平台链接吗？`)) return;
    commit({ ...database, products: database.products.filter((item) => item.id !== product.id) });
    setToast("产品已删除");
  }

  async function changeProductStatus(product: Product, status: ProductStatus) {
    if (!(database.user?.role === "admin" || database.user?.canEdit)) { setToast("管理员未开放产品编辑权限"); return; }
    if (product.status === status || changingStatusId) return;
    setChangingStatusId(product.id);
    try {
      const updated = { ...product, status, updatedAt: nowIso() };
      const saved = await commit({ ...database, products: database.products.map((item) => item.id === product.id ? updated : item) });
      if (saved) setToast(`“${product.name}”已切换为${status}`);
    } finally {
      setChangingStatusId(null);
    }
  }

  async function addMember(event: FormEvent) {
    event.preventDefault();
    if (!memberEmail.trim() || !memberPassword) return;
    const ok = await postAction({ action: "add_member", email: memberEmail.trim(), displayName: memberName.trim(), temporaryPassword: memberPassword });
    if (ok) {
      setMemberEmail("");
      setMemberName("");
      setMemberPassword("");
      await refresh(true);
      setToast("团队成员已添加，请将临时密码单独告知对方");
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
    } finally {
      setDatabase(EMPTY_DB);
      setActiveProductId(null);
      setPendingChange(null);
      setAuthMode("login");
      setView("chat");
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmNewPassword) { setToast("两次输入的新密码不一致"); return; }
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "change_password", currentPassword, newPassword }),
      });
      const payload = await response.json();
      if (!response.ok) { setToast(payload.error || "密码修改失败"); return; }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      await refresh(true);
      setToast("密码已修改");
    } catch {
      setToast("网络连接失败，请稍后重试");
    }
  }

  function openBranding() {
    const brand = database.team ?? DEFAULT_TEAM;
    setBrandName(brand.name);
    setBrandSubtitle(brand.subtitle);
    setBrandColor(displayBrandColor(brand.themeColor));
    setBrandAvatarPreview(brand.avatarUrl);
    setBrandAvatarFile(null);
    setRemoveBrandAvatar(false);
    setView("branding");
  }

  function chooseBrandAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!(["image/jpeg", "image/png", "image/webp"] as string[]).includes(file.type)) {
      setToast("头像仅支持 JPG、PNG 或 WebP 图片");
      event.target.value = "";
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setToast("头像大小不能超过2MB");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBrandAvatarPreview(String(reader.result ?? ""));
    reader.readAsDataURL(file);
    setBrandAvatarFile(file);
    setRemoveBrandAvatar(false);
  }

  async function saveBranding(event: FormEvent) {
    event.preventDefault();
    if (brandName.trim().length < 2 || brandName.trim().length > 24) { setToast("团队名称需要2到24个字"); return; }
    setSavingBrand(true);
    try {
      const saved = await postAction({ action: "update_team", teamName: brandName.trim(), subtitle: brandSubtitle.trim(), themeColor: brandColor });
      if (!saved) return;
      if (brandAvatarFile) {
        const form = new FormData();
        form.append("avatar", brandAvatarFile);
        const response = await fetch("/api/team-avatar", { method: "POST", body: form });
        const payload = await response.json().catch(() => ({ error: "头像上传失败" }));
        if (!response.ok) { setToast(payload.error || "头像上传失败"); return; }
      } else if (removeBrandAvatar) {
        const response = await fetch("/api/team-avatar", { method: "DELETE" });
        const payload = await response.json().catch(() => ({ error: "恢复默认头像失败" }));
        if (!response.ok) { setToast(payload.error || "恢复默认头像失败"); return; }
      }
      setBrandAvatarFile(null);
      setRemoveBrandAvatar(false);
      await refresh(true);
      setToast("团队外观已同步给所有成员");
    } catch {
      setToast("网络连接失败，请稍后重试");
    } finally {
      setSavingBrand(false);
    }
  }

  function resetBrandingForm() {
    setBrandName(DEFAULT_TEAM.name);
    setBrandSubtitle(DEFAULT_TEAM.subtitle);
    setBrandColor(DEFAULT_TEAM.themeColor);
    setBrandAvatarPreview("");
    setBrandAvatarFile(null);
    setRemoveBrandAvatar(true);
    if (avatarInput.current) avatarInput.current.value = "";
  }

  async function removeMember(member: Member) {
    if (!window.confirm(`确定停用成员“${member.displayName}”吗？`)) return;
    if (await postAction({ action: "remove_member", email: member.email })) {
      await refresh(true);
      setToast("成员已停用");
    }
  }

  async function updateMemberPermissions(target: Member, patch: Partial<Pick<Member, "canEdit" | "canDelete">>) {
    if (updatingPermissionEmail) return;
    const canEdit = patch.canEdit ?? target.canEdit;
    const canDelete = patch.canDelete ?? target.canDelete;
    setUpdatingPermissionEmail(target.email);
    try {
      if (await postAction({ action: "update_member_permissions", email: target.email, canEdit, canDelete })) {
        await refresh(true);
        setToast(`已更新“${target.displayName}”的权限`);
      }
    } finally {
      setUpdatingPermissionEmail(null);
    }
  }

  async function restoreProduct(product: Product) {
    if (!(database.user?.role === "admin" || database.user?.canDelete)) { setToast("管理员未开放产品恢复权限"); return; }
    if (await postAction({ action: "restore_product", productId: product.id })) {
      await refresh(true);
      setToast("产品已恢复");
    }
  }

  const reviewCount = useMemo(() => database.products.reduce((sum, product) => sum + product.links.reduce((linkSum, link) => linkSum + productLinkTargets(link).filter((target) => target.status !== "有效" || staleLinkDays(target) > 7).length, 0), 0), [database]);
  const quickMissingCount = (quickEntry.name.trim() ? 0 : 1) + (validQuickPrice(quickEntry.price) ? 0 : 1) + (quickEntry.mechanism.trim() ? 0 : 1) + (validQuickCommission(quickEntry.commission) ? 0 : 1)
    + quickEntry.packages.reduce((count, item) => count + (item.name.trim() ? 0 : 1) + (validQuickPrice(item.price) ? 0 : 1), 0)
    + quickEntry.links.reduce((count, link) => (
    count + (link.linkMode === "shared" ? (link.url.trim() ? 0 : 1) : link.creatorLinks.length ? link.creatorLinks.reduce((sum, item) => sum + (item.creatorName.trim() ? 0 : 1) + (item.url.trim() ? 0 : 1), 0) : 1)
  ), 0);
  const quickPackageNames = quickEntry.packages.map((item) => normalizeSearchText(item.name)).filter(Boolean);
  const quickHasDuplicatePackages = new Set(quickPackageNames).size !== quickPackageNames.length;
  const quickHasDuplicatePlatforms = new Set(quickEntry.links.map((link) => link.platform)).size !== quickEntry.links.length;
  const quickDuplicateCheck = detectProductDuplicates(database.products, {
    name: quickEntry.name,
    links: flattenQuickLinks(quickEntry.links),
  }, editingProductId);
  const quickHasBlockingDuplicate = Boolean(quickDuplicateCheck.exactNameProduct || quickDuplicateCheck.urlMatches.length || quickDuplicateCheck.duplicateUrls.length);
  const activeBrand = database.team ?? DEFAULT_TEAM;
  const canEditProducts = database.user?.role === "admin" || Boolean(database.user?.canEdit);
  const canDeleteProducts = database.user?.role === "admin" || Boolean(database.user?.canDelete);
  const activeReport = useMemo(() => buildProductReport(database.products, database.activity, reportPeriod), [database, reportPeriod]);
  const editedBrand: TeamBrand = { ...activeBrand, name: brandName, subtitle: brandSubtitle, themeColor: brandColor, avatarUrl: removeBrandAvatar ? "" : brandAvatarPreview };
  const visibleProducts = useMemo(() => {
    const source = view === "review"
      ? database.products.map((product) => ({ ...product, links: product.links.map((link) => filterLinkTargets(link, (target) => target.status !== "有效" || staleLinkDays(target) > 7)).filter((link): link is ProductLink => Boolean(link)) })).filter((product) => product.links.length)
      : database.products;
    if (!search.trim()) return source;
    return source.filter((product) => fuzzyScore(product, search) >= 38 || product.manufacturer.includes(search) || skuValues(product.skus, product.sku).some((value) => value.toLowerCase().includes(search.toLowerCase())));
  }, [database, search, view]);
  const libraryProducts = useMemo(() => view !== "products" || libraryStatusFilter === "全部"
    ? visibleProducts
    : visibleProducts.filter((product) => (product.status ?? "正常推广") === libraryStatusFilter), [visibleProducts, view, libraryStatusFilter]);
  const selectedLibraryProduct = libraryProducts.find((product) => product.id === selectedLibraryId) ?? libraryProducts[0] ?? null;

  if (authMode === "loading") return <div className="loading-screen"><div className="brand-mark"><Icon name="bot" /></div><p>正在连接团队产品库…</p></div>;
  if (authMode !== "app") return <AuthGate mode={authMode} initialError={accessError} onAuthenticated={() => refresh(false)} />;

  return (
    <main className="app-shell" style={{ "--green": UI_ACCENT, "--green-dark": "#5146D8", "--green-soft": "#F0EEFF", "--brand-color": displayBrandColor(activeBrand.themeColor) } as React.CSSProperties}>
      <aside className="sidebar">
        <div className="brand">
          <TeamMark brand={activeBrand} />
          <div><strong>{activeBrand.name}</strong><span><i /> {activeBrand.subtitle || "团队数据实时同步"}</span></div>
        </div>
        <nav className="main-nav" aria-label="主要导航">
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><Icon name="chat" /><span>智能对话</span></button>
          <button className={view === "products" ? "active" : ""} onClick={() => setView("products")}><Icon name="box" /><span>产品库</span><b>{database.products.length}</b></button>
          <button className={view === "review" ? "active" : ""} onClick={() => setView("review")}><Icon name="alert" /><span>待复核</span>{reviewCount > 0 && <b className="warn-count">{reviewCount}</b>}</button>
          <button className={view === "reports" ? "active" : ""} onClick={() => setView("reports")}><Icon name="report" /><span>日报周报</span></button>
          <button className={view === "activity" ? "active" : ""} onClick={() => setView("activity")}><Icon name="history" /><span>操作记录</span></button>
          {database.user?.role === "admin" && <button className={view === "team" ? "active" : ""} onClick={() => setView("team")}><Icon name="users" /><span>团队成员</span><b>{database.members.filter((member) => member.active).length}</b></button>}
          {database.user?.role === "admin" && <button className={view === "branding" ? "active" : ""} onClick={openBranding}><Icon name="palette" /><span>团队外观</span></button>}
          {canDeleteProducts && <button className={view === "trash" ? "active" : ""} onClick={() => setView("trash")}><Icon name="trash" /><span>回收站</span>{database.trash.length > 0 && <b>{database.trash.length}</b>}</button>}
          <button className={view === "account" ? "active" : ""} onClick={() => setView("account")}><Icon name="users" /><span>账户与密码</span></button>
        </nav>
        <div className="sidebar-account-summary">
          <span>{(database.user?.displayName || database.user?.email || "成").slice(0, 1).toUpperCase()}</span>
          <div><strong>{database.user?.displayName || "团队成员"}</strong><small>{database.user?.role === "admin" ? "管理员" : "团队成员"} · 已同步</small></div>
        </div>
        <div className="side-actions">
          <button onClick={exportBackup}><Icon name="download" />备份数据</button>
          {database.user?.role === "admin" && <button onClick={() => fileInput.current?.click()}>恢复备份</button>}
          <button onClick={() => void logout()}>退出</button>
          <input ref={fileInput} hidden type="file" accept=".json" onChange={importFile} />
        </div>
      </aside>

      <section className="workspace">
        {view === "chat" ? (
          <>
            <header className="workspace-header">
              <div><h1>智能对话</h1><p>用自然语言管理产品、平台链接和销售机制</p></div>
              <div className="chat-header-actions">
                {canEditProducts && <button className="batch-entry-button" onClick={openBatchImport}>批量导入</button>}
                {canEditProducts && <button className="quick-entry-button" onClick={() => openQuickEntry()}>＋ 快速录入</button>}
                <div className="connection-pill"><i className="online" />已同步 · {database.user?.displayName ?? database.user?.email}</div>
              </div>
            </header>
            <div className="chat-feed">
              {messages.map((message) => (
                <div className={`message-row ${message.role}`} key={message.id}>
                  {message.role === "assistant" && <TeamMark brand={activeBrand} className="assistant-avatar" />}
                  <div className="message-stack">
                    <div className={`message-bubble ${message.imageUrl ? "with-image" : ""}`}>{message.imageUrl && <img src={message.imageUrl} alt="本次发送的产品图片" />}{message.text && <span>{message.text}</span>}</div>
                    {message.products?.map((product) => <ProductResult key={`${message.id}-${product.id}`} product={product} onCopy={copy} onCheck={checkLink} onEdit={openProductEditor} onChatAction={handleProductChatAction} showChatActions={Boolean(message.productActions)} checking={checking} canEdit={canEditProducts} />)}
                  </div>
                </div>
              ))}
              {database.products.length === 0 && messages.length === 1 && (
                <section className="starter-prompts">
                  <p>从这些话开始</p>
                  <div>
                    {canEditProducts && <button onClick={() => openQuickEntry()}><span>智能粘贴录入</span><small>整段资料一次识别</small></button>}
                    <button onClick={() => setInput("查看全部产品")}><span>查看产品库</span><small>统计所有平台链接</small></button>
                    <button onClick={() => setInput("哪些链接需要复核？")}><span>检查链接状态</span><small>找出待处理的记录</small></button>
                  </div>
                </section>
              )}
              <div ref={chatEnd} />
            </div>
            <form className="composer" onSubmit={submit}>
              {draft && <div className="draft-notice"><span>正在录入</span><strong>{draft.name ?? "待填写产品名"}</strong><button type="button" onClick={() => { setDraft(null); reply("已取消当前录入。 "); }}>取消</button></div>}
              {pendingChange && <div className="draft-notice pending-change-notice"><span>{pendingChange.kind === "undo" ? "等待撤销确认" : "等待修改确认"}</span><strong>{pendingChange.after.name}</strong><div><button type="button" onClick={() => handleText(pendingChange.kind === "undo" ? "取消撤销" : "取消修改")}>取消</button><button type="button" className="confirm" onClick={() => handleText(pendingChange.kind === "undo" ? "确认撤销" : "确认修改")}>确认</button></div></div>}
              {composerImagePreview && <div className="composer-image-preview"><img src={composerImagePreview} alt="待发送的产品图片" /><div><strong>产品图片已添加</strong><span>将和这次发送的产品资料一起录入</span></div><button type="button" aria-label="移除待发送图片" onClick={clearComposerImage}>×</button></div>}
              <div className="composer-box">
                <button type="button" className="composer-image-button" title="添加产品图片" aria-label="添加产品图片" onClick={() => composerImageInput.current?.click()}><Icon name="image" /></button>
                <input ref={composerImageInput} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseComposerImage} />
                <textarea ref={composerInput} value={input} onChange={(event) => setInput(event.target.value)} onPaste={pasteComposerImage} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); handleText(input); } }} placeholder={pendingChange ? `请确认或取消本次${pendingChange.kind === "undo" ? "撤销" : "修改"}` : draft?.awaiting === "price" ? "请输入单品价格，例如：59.9元" : draft?.awaiting === "mechanism" ? "请输入规格、买赠活动等机制…" : draft?.awaiting === "commission" ? "请输入佣金百分比，例如：35%" : "直接输入产品名，或说“把XX佣金改为35%”…"} rows={1} />
                <button aria-label="发送" disabled={!input.trim() && !composerImageFile}><Icon name="send" /></button>
              </div>
              <p>单品价格、机制与佣金为必填项 · 套餐和产品图片选填 · 链接检测结果仅供参考</p>
            </form>
          </>
        ) : view === "reports" ? (
          <>
            <header className="workspace-header library-header">
              <div><h1>日报周报</h1><p>汇总推广状态、链接健康、佣金风险和团队变动</p></div>
              <button className="primary report-copy-button" onClick={() => void copy(activeReport.text, "报表")}><Icon name="copy" />复制报表</button>
            </header>
            <div className="report-body">
              <div className="report-period-tabs"><button className={reportPeriod === "daily" ? "active" : ""} onClick={() => setReportPeriod("daily")}>今日日报</button><button className={reportPeriod === "weekly" ? "active" : ""} onClick={() => setReportPeriod("weekly")}>本周周报</button></div>
              <section className="report-hero"><div><span>{activeReport.period === "daily" ? "DAILY REPORT" : "WEEKLY REPORT"}</span><h2>{activeReport.title}</h2><p>数据按当前产品库与操作记录实时生成</p></div><div className="report-health"><strong>{activeReport.metrics.find((item) => item.label === "正常推广")?.value ?? 0}</strong><span>款正常推广</span></div></section>
              <div className="report-metrics">{activeReport.metrics.map((metric) => <article className={metric.tone ?? ""} key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></article>)}</div>
              <div className="report-grid">
                <section className="report-panel alert-panel"><header><div><span className="section-kicker">重点提醒</span><h3>上品前需要确认</h3></div><Icon name="alert" /></header>{activeReport.alerts.length ? <ul>{activeReport.alerts.map((item) => <li key={item}>{item}</li>)}</ul> : <div className="report-empty"><Icon name="check" />暂无异常提醒</div>}</section>
                <section className="report-panel"><header><div><span className="section-kicker">最近变动</span><h3>{reportPeriod === "daily" ? "今日操作" : "本周操作"}</h3></div><Icon name="history" /></header>{activeReport.changes.length ? <ul>{activeReport.changes.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <div className="report-empty">本期暂无操作</div>}</section>
              </div>
              {reportPeriod === "weekly" && <div className="report-grid compact"><section className="report-panel"><header><div><span className="section-kicker">平台分布</span><h3>当前链接构成</h3></div></header><div className="report-tags">{activeReport.platformBreakdown.map((item) => <span key={item}>{item}</span>)}</div></section><section className="report-panel"><header><div><span className="section-kicker">团队活跃</span><h3>本周操作次数</h3></div></header><div className="report-tags">{activeReport.teamBreakdown.length ? activeReport.teamBreakdown.map((item) => <span key={item}>{item}</span>) : <small>本周暂无团队操作</small>}</div></section></div>}
              <details className="report-text-preview"><summary>查看可复制的完整报表</summary><pre>{activeReport.text}</pre></details>
            </div>
          </>
        ) : view === "branding" ? (
          <>
            <header className="workspace-header library-header">
              <div><h1>团队外观</h1><p>自定义团队名称、头像、标语和主题颜色</p></div>
              <span className="connection-pill"><i className="online" />管理员设置 · 全员同步</span>
            </header>
            <div className="admin-body branding-body">
              <section className="admin-panel branding-panel">
                <div className="brand-preview-column">
                  <span className="section-kicker">实时预览</span>
                  <h2>你的团队名片</h2>
                  <div className="brand-preview-card" style={{ borderColor: `${brandColor}33` }}>
                    <TeamMark brand={editedBrand} className="brand-preview-mark" />
                    <strong>{brandName.trim() || "团队名称"}</strong>
                    <span>{brandSubtitle.trim() || "团队产品资料安全同步"}</span>
                    <div style={{ backgroundColor: brandColor }}><i />团队数据实时同步</div>
                  </div>
                  <p>保存后，团队名称、头像和标识颜色会同步给所有成员；主界面继续保持统一的简约紫灰配色。</p>
                </div>
                <form className="branding-form" onSubmit={saveBranding}>
                  <div className="avatar-setting">
                    <TeamMark brand={editedBrand} className="avatar-preview" />
                    <div><strong>团队头像 / Logo</strong><p>推荐正方形图片，支持 JPG、PNG、WebP，大小不超过2MB。</p><div><label>选择图片<input ref={avatarInput} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseBrandAvatar} /></label>{(brandAvatarPreview || activeBrand.avatarUrl) && <button type="button" onClick={() => { setBrandAvatarPreview(""); setBrandAvatarFile(null); setRemoveBrandAvatar(true); if (avatarInput.current) avatarInput.current.value = ""; }}>移除头像</button>}</div></div>
                  </div>
                  <label>团队名称 <small>{brandName.trim().length}/24</small><input required minLength={2} maxLength={24} value={brandName} onChange={(event) => setBrandName(event.target.value)} placeholder="例如：小李选品团队" /></label>
                  <label>团队标语 <small>{brandSubtitle.length}/40</small><input maxLength={40} value={brandSubtitle} onChange={(event) => setBrandSubtitle(event.target.value)} placeholder="例如：好产品，值得认真分享" /></label>
                  <fieldset className="color-setting">
                    <legend>团队标识颜色</legend>
                    <div className="color-presets">{BRAND_COLORS.map((color) => <button key={color} type="button" aria-label={`选择颜色 ${color}`} className={brandColor === color ? "active" : ""} style={{ backgroundColor: color }} onClick={() => setBrandColor(color)} />)}<label className="custom-color" title="自定义颜色"><input type="color" value={brandColor} onChange={(event) => setBrandColor(event.target.value.toUpperCase())} /><span>自定义</span></label></div>
                  </fieldset>
                  <div className="branding-actions"><button type="button" onClick={resetBrandingForm}>恢复默认</button><button className="primary" disabled={savingBrand}>{savingBrand ? "保存中…" : "保存并同步"}</button></div>
                </form>
              </section>
            </div>
          </>
        ) : view === "account" ? (
          <>
            <header className="workspace-header library-header">
              <div><h1>账户与密码</h1><p>管理你的独立登录密码和当前登录状态</p></div>
              <button className="signout-link" onClick={() => void logout()}>退出登录</button>
            </header>
            <div className="admin-body">
              {database.user?.mustChangePassword && <section className="password-alert"><strong>请先修改临时密码</strong><span>这是你首次登录。修改为自己的密码后即可继续使用产品库。</span></section>}
              <section className="admin-panel account-panel">
                <div><span className="section-kicker">当前账户</span><h2>{database.user?.displayName}</h2><p>{database.user?.email} · {database.user?.role === "admin" ? "管理员 · 全部权限" : `普通成员 · ${canEditProducts ? "可新增编辑" : "仅查看"} · ${canDeleteProducts ? "可删除恢复" : "不可删除"}`}</p></div>
                <form onSubmit={changePassword}>
                  <label>当前密码<input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
                  <label>新密码<input required minLength={8} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少8位，包含字母和数字" /></label>
                  <label>确认新密码<input required minLength={8} type="password" autoComplete="new-password" value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} /></label>
                  <button>修改密码</button>
                </form>
              </section>
            </div>
          </>
        ) : view === "team" ? (
          <>
            <header className="workspace-header library-header">
              <div><h1>团队成员</h1><p>管理员可以分别设置每位成员的新增编辑和删除恢复权限</p></div>
              <button className="signout-link" onClick={() => void logout()}>退出登录</button>
            </header>
            <div className="admin-body">
              <section className="admin-panel invite-panel">
                <div><span className="section-kicker">添加成员</span><h2>创建团队账号</h2><p>填写成员邮箱并设置临时密码。请通过私密方式把临时密码告诉对方，对方首次登录后必须修改密码。</p></div>
                <form onSubmit={addMember}><label>成员姓名<input value={memberName} onChange={(event) => setMemberName(event.target.value)} placeholder="例如：小王" /></label><label>登录邮箱<input type="email" required value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} placeholder="name@example.com" /></label><label>临时密码<input type="password" required minLength={8} autoComplete="new-password" value={memberPassword} onChange={(event) => setMemberPassword(event.target.value)} placeholder="字母＋数字，至少8位" /></label><button>创建普通成员</button></form>
              </section>
              <section className="admin-panel"><div className="panel-heading"><div><span className="section-kicker">当前团队</span><h2>{database.members.filter((member) => member.active).length} 位成员</h2></div><small>新成员默认可新增编辑、不可删除</small></div><div className="member-list">{database.members.filter((member) => member.active).map((member) => <article key={member.email}><div className="member-avatar">{member.displayName.slice(0, 1).toUpperCase()}</div><div className="member-identity"><strong>{member.displayName}</strong><span>{member.email}</span></div><em className={member.role}>{member.role === "admin" ? "管理员" : "普通成员"}</em>{member.role === "admin" ? <div className="member-admin-access">全部权限</div> : <><div className="member-permissions"><label><input type="checkbox" disabled={updatingPermissionEmail === member.email} checked={member.canEdit} onChange={(event) => void updateMemberPermissions(member, { canEdit: event.target.checked })} /><span>新增 / 编辑</span></label><label><input type="checkbox" disabled={updatingPermissionEmail === member.email} checked={member.canDelete} onChange={(event) => void updateMemberPermissions(member, { canDelete: event.target.checked })} /><span>删除 / 恢复</span></label></div><button className="member-stop" disabled={updatingPermissionEmail === member.email} onClick={() => void removeMember(member)}>停用</button></>}</article>)}</div></section>
            </div>
          </>
        ) : view === "activity" ? (
          <>
            <header className="workspace-header library-header"><div><h1>操作记录</h1><p>查看团队成员最近的新增、修改、删除和恢复操作</p></div><div className="connection-pill"><i className="online" />自动更新</div></header>
            <div className="admin-body"><section className="admin-panel"><div className="activity-list">{database.activity.length ? database.activity.map((item) => <article key={item.id}><div className="activity-dot" /><div><strong>{item.productName || item.summary}</strong><p>{item.summary}</p><span>{item.actorEmail} · {friendlyDate(item.createdAt)}</span></div></article>) : <div className="mini-empty">还没有操作记录</div>}</div></section></div>
          </>
        ) : view === "trash" ? (
          <>
            <header className="workspace-header library-header"><div><h1>回收站</h1><p>拥有删除 / 恢复权限的成员可以恢复误删产品</p></div><span className="connection-pill">{database.trash.length} 款产品</span></header>
            <div className="admin-body"><section className="admin-panel"><div className="trash-list">{database.trash.length ? database.trash.map((product) => <article key={product.id}><div className="product-avatar">{product.name.slice(0, 1)}</div><div><strong>{product.name}</strong><span>{product.manufacturer} · {product.links.length} 条链接</span></div><small>删除人：{product.updatedBy || "管理员"}</small><button onClick={() => void restoreProduct(product)}>恢复产品</button></article>) : <div className="mini-empty"><Icon name="check" /><strong>回收站是空的</strong><span>被删除的产品会暂存在这里。</span></div>}</div></section></div>
          </>
        ) : (
          <>
            <header className="workspace-header library-header spacious-header">
              <div><span className="page-eyebrow">PRODUCT CENTER</span><h1>{view === "review" ? "待复核与超期链接" : "产品库"}</h1><p>{view === "review" ? "集中处理疑似失效、手动标记或超过7天未更新的链接" : "清晰查看产品、规格、平台链接与推广机制"}</p></div>
              {view === "products" ? <div className="library-header-actions">
                <details className="library-more-menu">
                  <summary>更多 <span>⌄</span></summary>
                  <div><button onClick={exportCsv}><Icon name="download" />导出 Excel 清单</button>{canEditProducts && <button onClick={openBatchImport}><Icon name="download" />批量导入</button>}</div>
                </details>
                {canEditProducts && <button className="library-add-button" onClick={() => openQuickEntry()}>＋ 添加产品</button>}
              </div> : <div className="header-buttons"><button onClick={exportCsv}><Icon name="download" />导出清单</button></div>}
            </header>
            {view === "products" ? <div className="library-body product-library-body">
              <section className="library-main-panel">
                <div className="library-panel-top">
                  <div><h2>全部产品 <span>{database.products.length}</span></h2><p>选择任意产品，在右侧查看完整资料</p></div>
                  <label className="library-search"><Icon name="search" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、厂家、SKU…" /></label>
                </div>
                <div className="library-filter-tabs" role="tablist" aria-label="按推广状态筛选">
                  {(["全部", ...PRODUCT_STATUSES] as const).map((status) => <button type="button" role="tab" aria-selected={libraryStatusFilter === status} className={libraryStatusFilter === status ? "active" : ""} key={status} onClick={() => setLibraryStatusFilter(status)}>{status}<span>{status === "全部" ? database.products.length : database.products.filter((product) => (product.status ?? "正常推广") === status).length}</span></button>)}
                </div>
                {libraryProducts.length ? <div className="library-table-wrap">
                  <div className="library-table-head"><span>产品</span><span>状态 · 可切换</span><span>单品价</span><span>SKU / 规格</span><span>平台</span><span>最近更新</span></div>
                  <div className="library-table-body">{libraryProducts.map((product) => <LibraryProductRow key={product.id} product={product} selected={selectedLibraryProduct?.id === product.id} onSelect={() => setSelectedLibraryId(product.id)} onStatusChange={changeProductStatus} statusChanging={changingStatusId === product.id} canEdit={canEditProducts} />)}</div>
                </div> : <div className="empty-library compact-empty"><div className="empty-icon"><Icon name="box" /></div><h2>{search || libraryStatusFilter !== "全部" ? "没有符合条件的产品" : "产品库还是空的"}</h2><p>{search || libraryStatusFilter !== "全部" ? "换个关键词或筛选条件试试。" : canEditProducts ? "粘贴厂家发来的整段资料，确认一次即可保存。" : "你当前拥有查看权限，管理员开放编辑权限后即可录入。"}</p>{!search && libraryStatusFilter === "全部" && canEditProducts && <button onClick={() => openQuickEntry()}>添加第一款产品</button>}</div>}
              </section>
              {selectedLibraryProduct && <ProductDetailPanel product={selectedLibraryProduct} onCopy={copy} onCheck={checkLink} onEdit={openProductEditor} onStatusChange={changeProductStatus} statusChanging={changingStatusId === selectedLibraryProduct.id} onDelete={removeProduct} onImageChange={replaceProductImage} onImageRemove={removeProductImage} canEdit={canEditProducts} canDelete={canDeleteProducts} onEditMechanism={() => { setView("chat"); setInput(`把${selectedLibraryProduct.name}的产品机制改成 `); }} checking={checking} />}
            </div> : <div className="library-body review-library-body">
              <div className="library-toolbar"><label><Icon name="search" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索产品名称、厂家或 SKU" /></label><span>共 {visibleProducts.length} 款产品</span></div>
              {visibleProducts.length ? <div className="product-list">{visibleProducts.map((product) => <ProductRow key={product.id} product={product} onCopy={copy} onCheck={checkLink} onEdit={openProductEditor} onStatusChange={changeProductStatus} statusChanging={changingStatusId === product.id} onDelete={removeProduct} onImageChange={replaceProductImage} onImageRemove={removeProductImage} canEdit={canEditProducts} canDelete={canDeleteProducts} onEditMechanism={() => { setView("chat"); setInput(`把${product.name}的产品机制改成 `); }} checking={checking} />)}</div> : <div className="empty-library"><div className="empty-icon"><Icon name="check" /></div><h2>没有需要复核的链接</h2><p>目前所有链接状态正常，且最近7天内已更新或检测。</p></div>}
            </div>}
          </>
        )}
      </section>
      {quickOpen && (
        <div className="quick-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) closeQuickEntry(); }}>
          <section className="quick-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-entry-title">
            <header className="quick-dialog-header">
              <div><span>{editingProductId ? "编辑产品" : "快速录入"}</span><h2 id="quick-entry-title">{editingProductId ? `修改“${database.products.find((product) => product.id === editingProductId)?.name ?? "产品"}”` : "粘贴整段资料，一次确认"}</h2><p>{editingProductId ? "名称、SKU/规格及对应价格、推广状态、套餐、平台链接、机制、佣金和图片都可以一次修改。" : "自动拆分产品、多个 SKU/规格及对应价格、推广状态、套餐、平台链接、机制和佣金。"}</p></div>
              <button type="button" aria-label={editingProductId ? "关闭产品编辑" : "关闭快速录入"} onClick={closeQuickEntry}>×</button>
            </header>
            <div className="quick-layout simplified">
              <form className="quick-form" onSubmit={saveQuickEntry} onPaste={pasteQuickImage}>
                {!editingProductId && <details className="quick-smart-paste">
                  <summary><span><Icon name="bot" /><strong>粘贴厂家资料，自动识别</strong></span><small>可选</small></summary>
                  <div className="quick-paste-content">
                    <textarea
                      id="quick-raw"
                      value={quickRaw}
                      onChange={(event) => setQuickRaw(event.target.value)}
                      placeholder={"产品名称：胶原蛋白饮\n厂家：示例食品\nSKU1：A-102，价格1：39.9元\nSKU2：A-103，价格2：49.9元\n推广状态：正常推广\n套餐：2盒69.9元；3盒99元\n抖音：7@8.com:/abc123\n机制：拍一发一\n佣金：35%"}
                    />
                    <div><small>整段粘贴后自动拆分，所有结果仍可修改。</small><button type="button" onClick={() => parseIntoQuickEntry(quickRaw)}>识别资料</button></div>
                  </div>
                </details>}

                <section className="quick-section quick-basics-section">
                  <div className="quick-section-heading"><div><span>01</span><strong>基本信息</strong></div><small>套餐选填，不影响普通产品</small></div>
                  <div className="quick-product-fields">
                    <label className={quickEntry.name.trim() ? "" : "missing"}>产品名称 <em>必填</em><input value={quickEntry.name} onChange={(event) => setQuickEntry((current) => ({ ...current, name: event.target.value }))} placeholder="例如：胶原蛋白饮" />
                      {quickDuplicateCheck.exactNameProduct && <small className="duplicate-tip">已有同名产品“{quickDuplicateCheck.exactNameProduct.name}”，请编辑已有产品</small>}
                      {!quickDuplicateCheck.exactNameProduct && quickDuplicateCheck.similarProducts.length > 0 && <small className="similar-tip">可能相似：{quickDuplicateCheck.similarProducts.map((item) => item.product.name).join("、")}（仅提醒）</small>}
                    </label>
                    <label className={validQuickPrice(quickEntry.price) ? "" : "missing"}>单品价格（元） <em>必填</em><input type="number" min="0.01" max="99999999" step="0.01" value={quickEntry.price} onChange={(event) => setQuickEntry((current) => ({ ...current, price: event.target.value }))} placeholder="例如 39.9" /></label>
                    <label>厂家 <small>选填</small><input value={quickEntry.manufacturer} onChange={(event) => setQuickEntry((current) => ({ ...current, manufacturer: event.target.value }))} placeholder="可不填写" /></label>
                    <label>推广状态 <em>必填</em><select value={quickEntry.status} onChange={(event) => setQuickEntry((current) => ({ ...current, status: event.target.value as ProductStatus }))}>{PRODUCT_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
                  </div>
                  <details className="quick-optional-fields" open={Boolean(quickEntry.skus.length || quickEntry.packages.length || quickImagePreview) || undefined}>
                    <summary><span><strong>更多可选信息</strong><small>SKU / 规格、套餐、产品图片</small></span><em>{quickEntry.skus.length + quickEntry.packages.length + (quickImagePreview ? 1 : 0) || "展开"}</em></summary>
                    <div className="quick-optional-content">
                      <div className="quick-sku-block">
                        <div className="quick-sku-heading"><div><strong>SKU / 产品规格</strong><small>可添加多个并填写各自价格</small>{quickEntry.skus.filter((item) => item.value.trim()).length > 0 && <em>{quickEntry.skus.filter((item) => item.value.trim()).length} 个</em>}</div><button type="button" onClick={addQuickSku}>＋ 添加规格</button></div>
                        {quickEntry.skus.length > 0 ? <div className="quick-sku-list">{quickEntry.skus.map((item, index) => <div className="quick-sku-row" key={item.id}><span>{String(index + 1).padStart(2, "0")}</span><input maxLength={120} value={item.value} onChange={(event) => updateQuickSku(item.id, { value: event.target.value })} placeholder="规格名称 / SKU编码" aria-label={`SKU / 产品规格 ${index + 1}`} /><div className={`sku-price-input ${item.price.trim() && !validQuickPrice(item.price) ? "missing" : ""}`}><b>¥</b><input type="number" min="0.01" max="99999999" step="0.01" value={item.price} onChange={(event) => updateQuickSku(item.id, { price: event.target.value })} placeholder="对应价格（选填）" aria-label={`规格${index + 1}对应价格`} /></div><button type="button" aria-label={`移除规格${index + 1}`} onClick={() => setQuickEntry((current) => ({ ...current, skus: current.skus.filter((currentItem) => currentItem.id !== item.id) }))}>×</button></div>)}</div> : <p className="quick-sku-empty">没有规格可留空；识别到多个 SKU 和价格时会自动配对。</p>}
                      </div>
                      <div className="quick-package-block">
                        <div className="quick-package-heading"><div><strong>套餐</strong><span>选填</span>{quickEntry.packages.length > 0 && <em>{quickEntry.packages.length} 个</em>}</div><button type="button" onClick={addQuickPackage}>＋ 添加套餐</button></div>
                        {quickEntry.packages.length > 0 && <div className="quick-package-list">{quickEntry.packages.map((item, index) => <div className="quick-package-row" key={item.id}><span>{String(index + 1).padStart(2, "0")}</span><label className={item.name.trim() ? "" : "missing"}>套餐名称 <em>必填</em><input value={item.name} onChange={(event) => updateQuickPackage(item.id, { name: event.target.value })} placeholder="例如：2盒装" /></label><label className={validQuickPrice(item.price) ? "" : "missing"}>套餐价格（元） <em>必填</em><input type="number" min="0.01" max="99999999" step="0.01" value={item.price} onChange={(event) => updateQuickPackage(item.id, { price: event.target.value })} placeholder="69.9" /></label><label>套餐内容 <small>选填</small><input value={item.description} onChange={(event) => updateQuickPackage(item.id, { description: event.target.value })} placeholder="例如：拍2发3" /></label><button type="button" aria-label={`移除套餐${index + 1}`} onClick={() => setQuickEntry((current) => ({ ...current, packages: current.packages.filter((currentItem) => currentItem.id !== item.id) }))}>×</button></div>)}{quickHasDuplicatePackages && <small className="duplicate-tip">存在重复套餐名称，请合并或修改后再保存</small>}</div>}
                      </div>
                      <div className={`quick-image-drop ${quickImagePreview ? "has-image" : ""}`} tabIndex={0} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) void applyQuickImage(file); }}>
                        {quickImagePreview ? <img src={quickImagePreview} alt="待上传的产品图片" /> : <div className="quick-image-placeholder"><Icon name="image" /></div>}
                        <div><strong>产品图片 <small>选填</small></strong><p>{quickImagePreview ? "已添加图片，可替换或移除" : "点击选择、拖入，或按 Ctrl+V 粘贴图片"}</p></div>
                        <div className="quick-image-actions"><label>{quickImagePreview ? "更换" : "选择图片"}<input hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseQuickImage} /></label>{quickImagePreview && <button type="button" onClick={() => { setQuickImageFile(null); setQuickImagePreview(""); if (editingProductId) setRemoveQuickImage(true); }}>移除</button>}</div>
                      </div>
                    </div>
                  </details>
                </section>

                <section className="quick-section quick-promotion-section">
                  <div className="quick-section-heading"><div><span>02</span><strong>统一推广信息</strong></div><small>每款产品只填写一次，所有平台和达人共用</small></div>
                  <div className="quick-promotion-fields">
                    <label className={quickEntry.mechanism.trim() ? "" : "missing"}>产品机制 <em>必填</em><textarea value={quickEntry.mechanism} onChange={(event) => setQuickEntry((current) => ({ ...current, mechanism: event.target.value }))} placeholder="规格、到手价、买赠活动等" /></label>
                    <label className={validQuickCommission(quickEntry.commission) ? "" : "missing"}>统一佣金（%） <em>必填</em><input type="number" min="0" max="100" step="0.01" value={quickEntry.commission} onChange={(event) => setQuickEntry((current) => ({ ...current, commission: event.target.value }))} placeholder="35" />{validQuickCommission(quickEntry.commission) && Number(quickEntry.commission) < 30 && <small className="low-commission-tip">产品佣金低于30%，低于规定水平；仍可保存</small>}</label>
                  </div>
                </section>

                <section className="quick-section quick-platforms-section">
                  <div className="quick-links-heading">
                    <div><span>03</span><strong>平台与链接</strong><em>{quickEntry.links.length} 个平台</em></div>
                    <button type="button" onClick={addQuickPlatform}>＋ 添加平台</button>
                  </div>

                  <div className="quick-link-list">
                    {quickEntry.links.map((link) => {
                      const linkUrls = quickLinkUrls(link);
                      const complete = Boolean(link.linkMode === "shared" ? link.url.trim() : link.creatorLinks.length && link.creatorLinks.every((item) => item.creatorName.trim() && item.url.trim()));
                      const active = activeQuickLinkId === link.id;
                      const duplicateLinkMatch = quickDuplicateCheck.urlMatches.find((match) => linkUrls.includes(match.matchedUrl));
                      const duplicateWithinEntry = quickDuplicateCheck.duplicateUrls.some((url) => linkUrls.includes(url));
                      return <article className={`quick-link-card ${active ? "active" : ""} ${duplicateLinkMatch || duplicateWithinEntry ? "duplicate" : ""}`} key={link.id}>
                        <div className="quick-platform-head">
                          <button type="button" className="quick-platform-toggle" onClick={() => setActiveQuickLinkId(active ? null : link.id)}>
                            <span className="quick-platform-badge">{link.platform}</span>
                            <span className="quick-platform-summary"><strong>{link.linkMode === "creator" ? `${link.creatorLinks.filter((item) => item.creatorName.trim()).length || 0} 位达人专属链接` : link.url.trim() || "统一链接待填写"}</strong><small>{link.linkMode === "creator" ? "达人姓名＋专属链接" : "所有达人共用一条链接"}</small></span>
                            <em className={complete ? "complete" : "incomplete"}>{complete ? "链接完整" : "待补充"}</em>
                            <b>{active ? "收起" : "编辑"}</b>
                          </button>
                          {quickEntry.links.length > 1 && <button type="button" className="quick-platform-remove" aria-label={`移除${link.platform}`} onClick={() => { setQuickEntry((current) => ({ ...current, links: current.links.filter((item) => item.id !== link.id) })); if (active) setActiveQuickLinkId(null); }}>×</button>}
                        </div>
                        {active && <div className="quick-link-editor">
                          <div className="link-mode-switch"><span>链接方式</span><div><button type="button" className={link.linkMode === "shared" ? "active" : ""} onClick={() => setQuickLinkMode(link.id, "shared")}>所有达人统一链接</button><button type="button" className={link.linkMode === "creator" ? "active" : ""} onClick={() => setQuickLinkMode(link.id, "creator")}>每位达人不同链接</button></div><small>{link.linkMode === "shared" ? "这个平台只填写一条链接" : "这里只填写达人姓名和专属链接"}</small></div>
                          <div className={`quick-row-grid ${link.linkMode === "creator" ? "creator-mode" : ""}`}>
                            <label>平台<select value={link.platform} onChange={(event) => updateQuickLink(link.id, { platform: event.target.value })}>{PLATFORMS.map((platform) => <option key={platform}>{platform}</option>)}</select></label>
                            {link.linkMode === "shared" && <label className={link.url.trim() ? "" : "missing"}>统一链接 <em>必填</em><input value={link.url} onChange={(event) => updateQuickLink(link.id, { url: event.target.value })} placeholder="所有达人共同使用的链接" /></label>}
                          </div>
                          {link.linkMode === "creator" && <div className="quick-creator-links"><div className="creator-links-heading"><div><strong>达人专属链接</strong><small>达人信息仅在需要时填写</small></div><button type="button" onClick={() => addQuickCreatorLink(link.id)}>＋ 添加达人</button></div>{link.creatorLinks.map((item, index) => <div className="creator-link-row" key={item.id}><span>{index + 1}</span><label className={item.creatorName.trim() ? "" : "missing"}>达人姓名 <input value={item.creatorName} onChange={(event) => updateQuickCreatorLink(link.id, item.id, { creatorName: event.target.value })} placeholder="例如：小王" /></label><label className={item.url.trim() ? "" : "missing"}>专属链接 <input value={item.url} onChange={(event) => updateQuickCreatorLink(link.id, item.id, { url: event.target.value })} placeholder="该达人使用的链接" /></label><button type="button" aria-label={`移除达人${index + 1}`} onClick={() => removeQuickCreatorLink(link.id, item.id)}>×</button></div>)}</div>}
                          {(duplicateLinkMatch || duplicateWithinEntry) && <div className="creator-duplicate-alert">{duplicateLinkMatch ? `链接已用于“${duplicateLinkMatch.product.name}”的${duplicateLinkMatch.link.platform || "其他"}平台` : "当前产品中存在重复链接"}</div>}
                        </div>}
                      </article>;
                    })}
                  </div>
                </section>

                <footer className="quick-footer">
                  <span className={quickMissingCount || quickHasDuplicatePlatforms || quickHasDuplicatePackages || quickHasBlockingDuplicate ? "quick-issues" : "quick-complete"}>{quickHasDuplicatePlatforms ? "存在重复平台" : quickHasDuplicatePackages ? "存在重复套餐" : quickHasBlockingDuplicate ? "存在重复产品或链接" : quickMissingCount ? `还缺 ${quickMissingCount} 项` : "资料完整"}</span>
                  <div><button type="button" onClick={closeQuickEntry}>取消</button><button className="primary" disabled={savingQuickEntry || quickMissingCount > 0 || quickHasDuplicatePlatforms || quickHasDuplicatePackages || quickHasBlockingDuplicate}>{savingQuickEntry ? "保存中…" : editingProductId ? "保存修改" : "确认保存"}</button></div>
                </footer>
              </form>
            </div>
          </section>
        </div>
      )}
      {batchOpen && (
        <div className="quick-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !savingBatch) closeBatchImport(); }}>
          <section className="batch-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-import-title">
            <header className="quick-dialog-header">
              <div><span>批量导入</span><h2 id="batch-import-title">一次整理多款产品</h2><p>{batchEntries.length ? "完整资料保持折叠，缺项和重复内容会明确标出。" : "推荐直接粘贴厂家聊天记录，表格导入作为备用方式。"}</p></div>
              <button type="button" aria-label="关闭批量导入" disabled={savingBatch} onClick={closeBatchImport}>×</button>
            </header>

            {!batchEntries.length ? <div className="batch-source-body">
              <div className="batch-source-tabs" role="tablist" aria-label="选择批量导入方式">
                <button type="button" className={batchSource === "text" ? "active" : ""} onClick={() => setBatchSource("text")}><Icon name="chat" /><span><strong>粘贴聊天记录</strong><small>推荐，最省事</small></span></button>
                <button type="button" className={batchSource === "table" ? "active" : ""} onClick={() => setBatchSource("table")}><Icon name="download" /><span><strong>导入表格</strong><small>备用方式</small></span></button>
              </div>

              {batchSource === "text" ? <section className="batch-text-source">
                <label htmlFor="batch-raw">把多款产品资料一次粘贴到这里</label>
                <textarea id="batch-raw" value={batchRaw} onChange={(event) => setBatchRaw(event.target.value)} placeholder={"产品：胶原蛋白\nSKU：A-102 39.9元；A-103 49.9元\n抖音：xxxx\n机制：拍一发一\n佣金：35%\n\n产品：洗衣液\n规格1：500ml，价格1：29.9元\n规格2：1L，价格2：39.9元\n视频号：xxxx\n机制：两瓶装\n佣金：32%"} />
                <div className="batch-source-tip"><Icon name="check" /><span>产品之间可以空一行，也可以用“---”分隔；原始链接不要求 https 开头。</span></div>
                <button type="button" className="batch-recognize-button" disabled={!batchRaw.trim()} onClick={parseBatchText}>识别并生成产品卡片</button>
              </section> : <section className="batch-table-source">
                <div className="batch-upload-icon"><Icon name="download" /></div>
                <h3>上传 CSV 表格</h3>
                <p>支持 Excel 可编辑的 CSV 或制表符表格。上传后先预览检查，不会直接写入产品库。</p>
                <input ref={batchTableInput} hidden type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" onChange={chooseBatchTable} />
                <div><button type="button" className="primary" onClick={() => batchTableInput.current?.click()}>选择表格文件</button><button type="button" onClick={downloadBatchTemplate}>下载表格模板</button></div>
                <small>产品机制和佣金每款只需填写一次；同一产品的多个平台或达人链接可分多行填写。</small>
              </section>}
            </div> : <div className="batch-preview-body">
              <div className="batch-preview-toolbar">
                <div><strong>识别到 {batchEntries.length} 款产品</strong><span>{batchFileName || (batchSource === "text" ? "来自粘贴的聊天记录" : "来自表格")}</span></div>
                <div><em className="complete">{batchEntries.filter((entry) => getBatchEntryIssues(entry).length === 0).length} 款完整</em>{batchEntries.some((entry) => getBatchEntryIssues(entry).length > 0) && <em className="incomplete">{batchEntries.filter((entry) => getBatchEntryIssues(entry).length > 0).length} 款待处理</em>}<button type="button" disabled={savingBatch} onClick={() => { setBatchEntries([]); setActiveBatchEntryId(null); setBatchProgress(0); }}>重新导入</button></div>
              </div>

              <div className="batch-card-list">
                {batchEntries.map((entry, index) => {
                  const issues = getBatchEntryIssues(entry);
                  const active = activeBatchEntryId === entry.id;
                  const lowCommission = validQuickCommission(entry.commission) && Number(entry.commission) < 30;
                  return <article className={`batch-product-card ${active ? "active" : ""} ${issues.length ? "needs-attention" : "ready"}`} key={entry.id}>
                    <div className="batch-product-head">
                      <button type="button" className="batch-product-toggle" onClick={() => setActiveBatchEntryId(active ? null : entry.id)}>
                        {entry.imagePreview ? <img src={entry.imagePreview} alt="产品预览" /> : <span className="batch-product-number">{String(index + 1).padStart(2, "0")}</span>}
                        <span className="batch-product-summary"><strong>{entry.name.trim() || "未识别产品名称"}</strong><small>{validQuickPrice(entry.price) ? `单品 ¥${entry.price}` : "单品价待补充"}{entry.packages.length ? ` · ${entry.packages.length} 个套餐` : ""} · {entry.links.length} 个平台</small></span>
                        <em className={issues.length ? "incomplete" : "complete"}>{issues.length ? `${issues.length} 项待处理` : lowCommission ? "完整 · 低佣金" : "资料完整"}</em>
                        <b>{active ? "收起" : "编辑"}</b>
                      </button>
                      <button type="button" className="batch-product-remove" aria-label={`移除${entry.name || `第${index + 1}款产品`}`} disabled={savingBatch} onClick={() => { setBatchEntries((current) => current.filter((item) => item.id !== entry.id)); if (active) setActiveBatchEntryId(null); }}>×</button>
                    </div>
                    {!active && issues.length > 0 && <div className="batch-issue-line">{issues.slice(0, 2).join(" · ")}{issues.length > 2 ? ` · 还有${issues.length - 2}项` : ""}</div>}

                    {active && <div className="batch-product-editor">
                      {issues.length > 0 && <div className="batch-editor-alert"><Icon name="alert" /><span>{issues.join("；")}</span></div>}
                      <div className="batch-basic-fields">
                        <label className={entry.name.trim() ? "" : "missing"}>产品名称 <em>必填</em><input value={entry.name} onChange={(event) => updateBatchEntry(entry.id, { name: event.target.value })} /></label>
                        <label className={validQuickPrice(entry.price) ? "" : "missing"}>单品价格（元） <em>必填</em><input type="number" min="0.01" max="99999999" step="0.01" value={entry.price} onChange={(event) => updateBatchEntry(entry.id, { price: event.target.value })} /></label>
                        <label>厂家 <small>选填</small><input value={entry.manufacturer} onChange={(event) => updateBatchEntry(entry.id, { manufacturer: event.target.value })} /></label>
                        <label>推广状态 <em>必填</em><select value={entry.status} onChange={(event) => updateBatchEntry(entry.id, { status: event.target.value as ProductStatus })}>{PRODUCT_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
                      </div>
                      <div className="batch-promotion-fields">
                        <label className={entry.mechanism.trim() ? "" : "missing"}>统一产品机制 <em>必填</em><textarea value={entry.mechanism} onChange={(event) => updateBatchEntry(entry.id, { mechanism: event.target.value })} placeholder="所有平台和达人共用" /></label>
                        <label className={validQuickCommission(entry.commission) ? "" : "missing"}>统一佣金（%） <em>必填</em><input type="number" min="0" max="100" step="0.01" value={entry.commission} onChange={(event) => updateBatchEntry(entry.id, { commission: event.target.value })} />{validQuickCommission(entry.commission) && Number(entry.commission) < 30 && <small className="low-commission-tip">低于规定水平，仍可导入</small>}</label>
                      </div>
                      <div className="batch-sku-block">
                        <div className="batch-package-heading"><div><strong>SKU / 产品规格</strong><small>选填；多个规格及对应价格会自动拆分配对</small></div><button type="button" onClick={() => addBatchSku(entry.id)}>＋ 添加规格</button></div>
                        {entry.skus.length > 0 && <div className="batch-sku-list">{entry.skus.map((item, skuIndex) => <div className="batch-sku-row" key={item.id}><span>{skuIndex + 1}</span><input maxLength={120} value={item.value} onChange={(event) => updateBatchSku(entry.id, item.id, { value: event.target.value })} placeholder="规格名称 / SKU编码" aria-label={`${entry.name || "产品"}规格${skuIndex + 1}`} /><div className={`sku-price-input ${item.price.trim() && !validQuickPrice(item.price) ? "missing" : ""}`}><b>¥</b><input type="number" min="0.01" max="99999999" step="0.01" value={item.price} onChange={(event) => updateBatchSku(entry.id, item.id, { price: event.target.value })} placeholder="对应价格（选填）" aria-label={`规格${skuIndex + 1}对应价格`} /></div><button type="button" aria-label={`移除规格${skuIndex + 1}`} onClick={() => setBatchEntries((current) => current.map((currentEntry) => currentEntry.id === entry.id ? { ...currentEntry, skus: currentEntry.skus.filter((currentItem) => currentItem.id !== item.id) } : currentEntry))}>×</button></div>)}</div>}
                      </div>
                      <div className="batch-package-heading"><div><strong>套餐</strong><small>选填，没有套餐可留空</small></div><button type="button" onClick={() => addBatchPackage(entry.id)}>＋ 添加套餐</button></div>
                      {entry.packages.length > 0 && <div className="batch-package-list">
                        {entry.packages.map((item, packageIndex) => <div className="batch-package-row" key={item.id}>
                          <span>{packageIndex + 1}</span>
                          <label className={item.name.trim() ? "" : "missing"}>套餐名称 <em>必填</em><input value={item.name} onChange={(event) => updateBatchPackage(entry.id, item.id, { name: event.target.value })} /></label>
                          <label className={validQuickPrice(item.price) ? "" : "missing"}>套餐价格（元） <em>必填</em><input type="number" min="0.01" max="99999999" step="0.01" value={item.price} onChange={(event) => updateBatchPackage(entry.id, item.id, { price: event.target.value })} /></label>
                          <label>套餐内容 <small>选填</small><input value={item.description} onChange={(event) => updateBatchPackage(entry.id, item.id, { description: event.target.value })} /></label>
                          <button type="button" onClick={() => setBatchEntries((current) => current.map((currentEntry) => currentEntry.id === entry.id ? { ...currentEntry, packages: currentEntry.packages.filter((currentItem) => currentItem.id !== item.id) } : currentEntry))}>×</button>
                        </div>)}
                      </div>}
                      <div className="batch-image-row">
                        {entry.imagePreview ? <img src={entry.imagePreview} alt="产品预览" /> : <span><Icon name="image" /></span>}
                        <div><strong>产品图片</strong><small>选填，可在导入前补充</small></div>
                        <label>{entry.imagePreview ? "更换图片" : "选择图片"}<input hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void applyBatchImage(entry.id, file); event.target.value = ""; }} /></label>
                        {entry.imagePreview && <button type="button" onClick={() => setBatchEntries((current) => current.map((item) => item.id === entry.id ? { ...item, imageFile: null, imagePreview: "" } : item))}>移除</button>}
                      </div>

                      <div className="batch-platform-heading"><strong>平台资料</strong><button type="button" onClick={() => addBatchPlatform(entry.id)}>＋ 添加平台</button></div>
                      <div className="batch-link-editors">
                        {entry.links.map((link, linkIndex) => <section key={link.id}>
                          <div className="batch-link-title"><span>平台 {linkIndex + 1}</span>{entry.links.length > 1 && <button type="button" onClick={() => setBatchEntries((current) => current.map((item) => item.id !== entry.id ? item : { ...item, links: item.links.filter((row) => row.id !== link.id) }))}>移除</button>}</div>
                          <div className="link-mode-switch batch-link-mode"><span>链接方式</span><div><button type="button" className={link.linkMode === "shared" ? "active" : ""} onClick={() => setBatchLinkMode(entry.id, link.id, "shared")}>统一链接</button><button type="button" className={link.linkMode === "creator" ? "active" : ""} onClick={() => setBatchLinkMode(entry.id, link.id, "creator")}>达人专属</button></div></div>
                          <div className={`batch-link-fields ${link.linkMode === "creator" ? "creator-mode" : ""}`}>
                            <label>平台<select value={link.platform} onChange={(event) => updateBatchLink(entry.id, link.id, { platform: event.target.value })}>{PLATFORMS.map((platform) => <option key={platform}>{platform}</option>)}</select></label>
                            {link.linkMode === "shared" && <label className={link.url.trim() ? "" : "missing"}>统一链接 <em>必填</em><input value={link.url} onChange={(event) => updateBatchLink(entry.id, link.id, { url: event.target.value })} /></label>}
                          </div>
                          {link.linkMode === "creator" && <div className="quick-creator-links batch-creator-links"><div className="creator-links-heading"><div><strong>达人专属链接</strong><small>这里只填写达人姓名和链接</small></div><button type="button" onClick={() => addBatchCreatorLink(entry.id, link.id)}>＋ 添加达人</button></div>{link.creatorLinks.map((item, creatorIndex) => <div className="creator-link-row" key={item.id}><span>{creatorIndex + 1}</span><label className={item.creatorName.trim() ? "" : "missing"}>达人姓名<input value={item.creatorName} onChange={(event) => updateBatchCreatorLink(entry.id, link.id, item.id, { creatorName: event.target.value })} /></label><label className={item.url.trim() ? "" : "missing"}>专属链接<input value={item.url} onChange={(event) => updateBatchCreatorLink(entry.id, link.id, item.id, { url: event.target.value })} /></label><button type="button" onClick={() => removeBatchCreatorLink(entry.id, link.id, item.id)}>×</button></div>)}</div>}
                        </section>)}
                      </div>
                    </div>}
                  </article>;
                })}
              </div>
            </div>}

            {batchEntries.length > 0 && <footer className="batch-footer">
              <span className={batchEntries.some((entry) => getBatchEntryIssues(entry).length) ? "quick-issues" : "quick-complete"}>{savingBatch ? `正在导入 ${batchProgress}/${batchEntries.length}` : batchEntries.some((entry) => getBatchEntryIssues(entry).length) ? "请先处理标红的产品" : `${batchEntries.length} 款产品可以导入`}</span>
              <div><button type="button" disabled={savingBatch} onClick={closeBatchImport}>取消</button><button type="button" className="primary" disabled={savingBatch || batchEntries.some((entry) => getBatchEntryIssues(entry).length > 0)} onClick={() => void saveBatchEntries()}>{savingBatch ? "导入中…" : "全部导入"}</button></div>
            </footer>}
          </section>
        </div>
      )}
      <nav className="mobile-nav"><button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}><Icon name="chat" /><span>对话</span></button><button className={view === "products" ? "active" : ""} onClick={() => setView("products")}><Icon name="box" /><span>产品库</span></button><button className={view === "review" ? "active" : ""} onClick={() => setView("review")}><Icon name="alert" /><span>待复核</span></button><button className={view === "reports" ? "active" : ""} onClick={() => setView("reports")}><Icon name="report" /><span>报表</span></button><button className={view === "activity" ? "active" : ""} onClick={() => setView("activity")}><Icon name="history" /><span>记录</span></button>{database.user?.role === "admin" && <button className={view === "team" ? "active" : ""} onClick={() => setView("team")}><Icon name="users" /><span>团队</span></button>}{database.user?.role === "admin" && <button className={view === "branding" ? "active" : ""} onClick={openBranding}><Icon name="palette" /><span>外观</span></button>}{canDeleteProducts && <button className={view === "trash" ? "active" : ""} onClick={() => setView("trash")}><Icon name="trash" /><span>回收站</span></button>}<button className={view === "account" ? "active" : ""} onClick={() => setView("account")}><Icon name="users" /><span>账户</span></button></nav>
      {toast && <div className="toast"><Icon name="check" />{toast}</div>}
    </main>
  );
}

function CreatorLinksDisplay({ productId, link, onCopy, onCheck, checking, canEdit }: { productId: string; link: ProductLink; onCopy: (value: string) => void; onCheck: (productId: string, linkId: string, url: string, creatorLinkId?: string) => void; checking: string | null; canEdit: boolean }) {
  return <div className="creator-links-display">{productLinkTargets(link).map((item) => <article key={item.id}>
    <div className="creator-link-identity"><span>{item.creatorName.slice(0, 1)}</span><div><strong>{item.creatorName}</strong><small className={statusClass(item.status)}>{item.status}</small></div></div>
    {staleLinkDays(item) > 7 && <em>已 {staleLinkDays(item)} 天未更新</em>}
    <button type="button" className="creator-url-button" title={item.url} onClick={() => void onCopy(item.url)}><span>{item.url}</span><Icon name="copy" /></button>
    <div className="creator-link-actions">{openableHref(item.url) && <a href={openableHref(item.url)!} target="_blank" rel="noreferrer"><Icon name="open" />打开</a>}{canEdit && <button type="button" disabled={checking === item.id} onClick={() => void onCheck(productId, link.id, item.url, item.id)}>{checking === item.id ? "检测中…" : "检测"}</button>}</div>
  </article>)}</div>;
}

function ProductResult({ product, onCopy, onCheck, onEdit, onChatAction, showChatActions, checking, canEdit }: { product: Product; onCopy: (value: string) => void; onCheck: (productId: string, linkId: string, url: string, creatorLinkId?: string) => void; onEdit: (product: Product) => void; onChatAction: (product: Product, action: ProductChatAction) => void; showChatActions: boolean; checking: string | null; canEdit: boolean }) {
  const promotionStatus = product.status ?? "正常推广";
  const productSkus = normalizedSkuEntries(product.skus, product.sku);
  return <article className="result-card">
    <header><div className="result-product-title">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} /> : <div className="result-product-placeholder">{product.name.slice(0, 1)}</div>}<div><span className="product-kicker">产品</span><h3>{product.name}</h3><span className={productStatusClass(promotionStatus)}>{promotionStatus}</span></div></div><div className="result-product-meta"><strong>单品 {formatProductPrice(product.price)}</strong><small>{product.manufacturer}</small>{productSkus.length > 0 && <div className="product-sku-tags" aria-label="SKU和产品规格">{productSkus.map((item) => <small key={item.value}>{item.value}{item.price !== null && <b>{formatProductPrice(item.price)}</b>}</small>)}</div>}{canEdit && !showChatActions && <button className="result-edit-button" onClick={() => onEdit(product)}>编辑资料</button>}</div></header>
    {productStatusWarning(promotionStatus) && <div className={`promotion-warning ${promotionStatus === "已下架" ? "danger" : "warning"}`}><Icon name="alert" /><strong>{productStatusWarning(promotionStatus)}</strong></div>}
    {product.packages.length > 0 && <div className="result-packages"><span>可选套餐</span><div>{product.packages.map((item) => <div key={item.id}><strong>{item.name}</strong><b>{formatProductPrice(item.price)}</b>{item.description && <small>{item.description}</small>}</div>)}</div></div>}
    <div className="product-promotion-summary"><div><span>统一产品机制</span><p>{product.mechanism}</p></div><div className={product.commission < 30 ? "low" : ""}><span>统一佣金</span><strong>{product.commission}%</strong>{product.commission < 30 && <em>低于规定水平</em>}</div></div>
    {product.links.map((link) => <div className="result-link" key={link.id}>
      <div className="link-heading"><strong>{link.platform}</strong><span className={statusClass(link.status)}>{link.status}</span></div>
      {productLinkMode(link) === "shared" && staleLinkDays(link) > 7 && <div className="stale-link-warning"><Icon name="history" /><span>该链接已 {staleLinkDays(link)} 天未更新，上品前请检查链接及佣金</span></div>}
      {productLinkMode(link) === "creator" ? <CreatorLinksDisplay productId={product.id} link={link} onCopy={onCopy} onCheck={onCheck} checking={checking} canEdit={canEdit} /> : <button className="url-line" title={link.url} onClick={() => void onCopy(link.url)}><span>{link.url}</span><Icon name="copy" /></button>}
      {productLinkMode(link) === "shared" && <div className="card-actions"><button onClick={() => void onCopy(link.url)}><Icon name="copy" />复制链接</button>{openableHref(link.url) && <a href={openableHref(link.url)!} target="_blank" rel="noreferrer"><Icon name="open" />打开链接</a>}{canEdit && <button disabled={checking === link.id} onClick={() => void onCheck(product.id, link.id, link.url)}>{checking === link.id ? "检测中…" : "检测"}</button>}</div>}
    </div>)}
    {showChatActions && <footer className="product-chat-actions"><span>接下来要做什么？</span><div><button type="button" onClick={() => onChatAction(product, "links")}>查看链接</button><button type="button" onClick={() => onChatAction(product, "preflight")}>检查能否上品</button>{canEdit && <><button type="button" className="primary" onClick={() => onChatAction(product, "edit")}>编辑产品信息</button><button type="button" onClick={() => onChatAction(product, "price")}>改价格</button><button type="button" onClick={() => onChatAction(product, "mechanism")}>改机制</button><button type="button" onClick={() => onChatAction(product, "commission")}>改佣金</button><button type="button" onClick={() => onChatAction(product, "status")}>改状态</button></>}</div></footer>}
  </article>;
}

function LibraryProductRow({ product, selected, onSelect, onStatusChange, statusChanging, canEdit }: { product: Product; selected: boolean; onSelect: () => void; onStatusChange: (product: Product, status: ProductStatus) => void; statusChanging: boolean; canEdit: boolean }) {
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const promotionStatus = product.status ?? "正常推广";
  const productSkus = normalizedSkuEntries(product.skus, product.sku);
  const latestUpdate = product.links.reduce((latest, link) => link.updatedAt > latest ? link.updatedAt : latest, product.updatedAt);
  return <article className={`library-product-row ${selected ? "selected" : ""} ${statusMenuOpen ? "status-open" : ""}`}>
    <button type="button" className="library-row-hit" aria-label={`查看${product.name}详情`} onClick={() => { setStatusMenuOpen(false); onSelect(); }} />
    <span className="library-product-cell"><span className="library-product-thumb">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} /> : product.name.slice(0, 1)}</span><span><strong>{product.name}</strong><small>{product.manufacturer || "厂家未填写"}</small></span></span>
    <span className="library-row-status"><button type="button" className={productStatusClass(promotionStatus)} disabled={!canEdit || statusChanging} aria-haspopup="menu" aria-expanded={statusMenuOpen} onClick={() => canEdit && setStatusMenuOpen((current) => !current)}>{statusChanging ? "保存中…" : promotionStatus}{canEdit && <b>⌄</b>}</button>{canEdit && statusMenuOpen && <div role="menu" aria-label={`切换${product.name}的推广状态`}>{PRODUCT_STATUSES.map((status) => <button type="button" role="menuitem" className={promotionStatus === status ? "active" : ""} key={status} onClick={() => { setStatusMenuOpen(false); onStatusChange(product, status); }}><i className={`status-dot status-dot-${status}`} />{status}{promotionStatus === status && <Icon name="check" />}</button>)}</div>}</span>
    <span className="library-price">{formatProductPrice(product.price)}</span>
    <span className="library-muted">{productSkus.length ? `${productSkus.length} 个规格` : "—"}</span>
    <span className="library-platforms">{product.links.slice(0, 2).map((link) => <i key={link.id}>{link.platform}</i>)}{product.links.length > 2 && <i>+{product.links.length - 2}</i>}</span>
    <span className="library-muted">{friendlyDate(latestUpdate)}</span>
  </article>;
}

function ProductDetailPanel({ product, onCopy, onCheck, onEdit, onStatusChange, statusChanging, onDelete, onImageChange, onImageRemove, onEditMechanism, checking, canEdit, canDelete }: { product: Product; onCopy: (value: string) => void; onCheck: (productId: string, linkId: string, url: string, creatorLinkId?: string) => void; onEdit: (product: Product) => void; onStatusChange: (product: Product, status: ProductStatus) => void; statusChanging: boolean; onDelete: (product: Product) => void; onImageChange: (product: Product, file: File) => void; onImageRemove: (product: Product) => void; onEditMechanism: () => void; checking: string | null; canEdit: boolean; canDelete: boolean }) {
  const imageInput = useRef<HTMLInputElement>(null);
  const promotionStatus = product.status ?? "正常推广";
  const productSkus = normalizedSkuEntries(product.skus, product.sku);
  return <aside className="library-detail-panel">
    <header className="library-detail-header">
      <div className="library-detail-title"><span className="library-detail-thumb">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} /> : product.name.slice(0, 1)}</span><div><small>产品详情</small><h2>{product.name}</h2><p>{product.manufacturer || "厂家未填写"}</p></div></div>
      {canEdit && <button type="button" className="detail-edit-button" onClick={() => onEdit(product)}>编辑</button>}
    </header>
    <input ref={imageInput} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImageChange(product, file); event.target.value = ""; }} />
    <div className="library-detail-scroll">
      {productStatusWarning(promotionStatus) && <div className={`promotion-warning ${promotionStatus === "已下架" ? "danger" : "warning"}`}><Icon name="alert" /><strong>{productStatusWarning(promotionStatus)}</strong></div>}
      <div className="library-detail-metrics">
        <div><span>单品价格</span><strong>{formatProductPrice(product.price)}</strong></div>
        <div><span>平台链接</span><strong>{product.links.length}</strong></div>
        <label><span>推广状态</span><select value={promotionStatus} disabled={!canEdit || statusChanging} onChange={(event) => onStatusChange(product, event.target.value as ProductStatus)}>{PRODUCT_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
      </div>
      {productSkus.length > 0 && <section className="detail-data-section"><header><strong>SKU / 产品规格</strong><span>{productSkus.length} 个</span></header><div className="detail-sku-list">{productSkus.map((item) => <div key={item.value}><span>{item.value}</span><strong>{item.price !== null ? formatProductPrice(item.price) : "随单品价"}</strong></div>)}</div></section>}
      {product.packages.length > 0 && <section className="detail-data-section"><header><strong>可选套餐</strong><span>{product.packages.length} 个</span></header><div className="detail-package-list">{product.packages.map((item) => <div key={item.id}><span><strong>{item.name}</strong>{item.description && <small>{item.description}</small>}</span><b>{formatProductPrice(item.price)}</b></div>)}</div></section>}
      <section className="detail-data-section product-promotion-detail"><header><strong>统一推广信息</strong>{canEdit && <button type="button" onClick={onEditMechanism}>修改</button>}</header><div><div><span>产品机制</span><p>{product.mechanism}</p></div><div className={product.commission < 30 ? "low" : ""}><span>佣金</span><strong>{product.commission}%</strong>{product.commission < 30 && <small>低于规定水平</small>}</div></div></section>
      <section className="detail-data-section detail-links-section"><header><strong>平台资料</strong><span>{product.links.length} 个</span></header>{product.links.map((link) => <article className="detail-link-card" key={link.id}>
        <div className="detail-link-heading"><span><strong>{link.platform}</strong><em className={statusClass(link.status)}>{link.status}</em></span><small>{friendlyDate(link.updatedAt)}</small></div>
        {productLinkMode(link) === "shared" && staleLinkDays(link) > 7 && <div className="stale-link-warning"><Icon name="history" /><span>已 {staleLinkDays(link)} 天未更新，上品前请检查链接及佣金</span></div>}
        {productLinkMode(link) === "creator" ? <CreatorLinksDisplay productId={product.id} link={link} onCopy={onCopy} onCheck={onCheck} checking={checking} canEdit={canEdit} /> : <button type="button" className="detail-link-url" title={link.url} onClick={() => void onCopy(link.url)}><span>{link.url}</span><Icon name="copy" /></button>}
        {productLinkMode(link) === "shared" && <div className="detail-link-footer"><span>统一链接</span><div>{openableHref(link.url) && <a href={openableHref(link.url)!} target="_blank" rel="noreferrer"><Icon name="open" />打开</a>}{canEdit && <button type="button" disabled={checking === link.id} onClick={() => void onCheck(product.id, link.id, link.url)}>{checking === link.id ? "检测中…" : "检测链接"}</button>}</div></div>}
      </article>)}</section>
    </div>
    {(canEdit || canDelete) && <footer className="library-detail-actions">{canEdit && <button type="button" onClick={() => imageInput.current?.click()}>{product.imageUrl ? "更换图片" : "添加图片"}</button>}{canEdit && product.imageUrl && <button type="button" onClick={() => onImageRemove(product)}>移除图片</button>}{canDelete && <button type="button" className="danger" onClick={() => onDelete(product)}>删除产品</button>}</footer>}
  </aside>;
}

function ProductRow({ product, onCopy, onCheck, onEdit, onStatusChange, statusChanging, onDelete, onImageChange, onImageRemove, onEditMechanism, checking, canEdit, canDelete }: { product: Product; onCopy: (value: string) => void; onCheck: (productId: string, linkId: string, url: string, creatorLinkId?: string) => void; onEdit: (product: Product) => void; onStatusChange: (product: Product, status: ProductStatus) => void; statusChanging: boolean; onDelete: (product: Product) => void; onImageChange: (product: Product, file: File) => void; onImageRemove: (product: Product) => void; onEditMechanism: () => void; checking: string | null; canEdit: boolean; canDelete: boolean }) {
  const [open, setOpen] = useState(true);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const promotionStatus = product.status ?? "正常推广";
  const productSkus = normalizedSkuEntries(product.skus, product.sku);
  return <article className={`product-row ${statusMenuOpen ? "status-menu-open" : ""}`}>
    <header onClick={() => { setOpen(!open); setStatusMenuOpen(false); }}><div className="product-avatar">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} /> : product.name.slice(0, 1)}</div><div className="product-title"><h3>{product.name}</h3><p>{product.manufacturer}{productSkus.length ? ` · ${productSkus.length} 个SKU/规格` : ""} · 单品 {formatProductPrice(product.price)}{product.packages.length ? ` · ${product.packages.length} 个套餐` : ""} · {product.links.length} 个平台</p></div><div className="platform-tags">{product.links.slice(0, 3).map((link) => <span key={link.id}>{link.platform}</span>)}</div><div className={`product-status-switch ${statusMenuOpen ? "open" : ""}`} onClick={(event) => event.stopPropagation()}><button type="button" className={productStatusClass(promotionStatus)} disabled={statusChanging || !canEdit} aria-haspopup="menu" aria-expanded={statusMenuOpen} onClick={() => canEdit && setStatusMenuOpen((current) => !current)}>{statusChanging ? "保存中…" : promotionStatus}{canEdit && <span>⌄</span>}</button>{canEdit && statusMenuOpen && <div role="menu" aria-label={`切换${product.name}的推广状态`}>{PRODUCT_STATUSES.map((status) => <button type="button" role="menuitem" className={promotionStatus === status ? "active" : ""} key={status} onClick={() => { setStatusMenuOpen(false); onStatusChange(product, status); }}><i className={`status-dot status-dot-${status}`} />{status}{promotionStatus === status && <Icon name="check" />}</button>)}</div>}</div>{canEdit && <button className="product-edit-button" onClick={(event) => { event.stopPropagation(); onEdit(product); }}>编辑</button>}<button className={`chevron ${open ? "open" : ""}`} aria-label={open ? "收起产品资料" : "展开产品资料"}>⌄</button></header>
    <input ref={imageInput} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) onImageChange(product, file); event.target.value = ""; }} />
    {open && <div className="product-details">{productStatusWarning(promotionStatus) && <div className={`promotion-warning ${promotionStatus === "已下架" ? "danger" : "warning"}`}><Icon name="alert" /><strong>{productStatusWarning(promotionStatus)}</strong></div>}{productSkus.length > 0 && <div className="product-sku-detail"><strong>SKU / 产品规格</strong><div>{productSkus.map((item, index) => <span key={item.value}><b>{index + 1}</b>{item.value}{item.price !== null && <em>{formatProductPrice(item.price)}</em>}</span>)}</div></div>}{product.packages.length > 0 && <div className="product-package-detail"><strong>可选套餐</strong><div>{product.packages.map((item) => <span key={item.id}><b>{item.name}</b><em>{formatProductPrice(item.price)}</em>{item.description && <small>{item.description}</small>}</span>)}</div></div>}<div className="product-promotion-summary product-row-promotion"><div><span>统一产品机制</span><p>{product.mechanism}</p>{canEdit && <button onClick={onEditMechanism}>修改</button>}</div><div className={product.commission < 30 ? "low" : ""}><span>统一佣金</span><strong>{product.commission}%</strong>{product.commission < 30 && <em>低于规定水平</em>}</div></div>{product.links.map((link) => <section key={link.id}>
      <div className="detail-top"><div><strong>{link.platform}</strong><span className={statusClass(link.status)}>{link.status}</span></div><small>更新于 {friendlyDate(link.updatedAt)}</small>{productLinkMode(link) === "shared" && staleLinkDays(link) > 7 && <div className="stale-link-warning"><Icon name="history" /><span>该链接已 {staleLinkDays(link)} 天未更新，上品前请检查链接及佣金</span></div>}</div>
      {productLinkMode(link) === "creator" ? <div className="review-creator-links"><CreatorLinksDisplay productId={product.id} link={link} onCopy={onCopy} onCheck={onCheck} checking={checking} canEdit={canEdit} /></div> : <div className="detail-url"><span>{link.url}</span><button onClick={() => void onCopy(link.url)}><Icon name="copy" /></button>{openableHref(link.url) && <a href={openableHref(link.url)!} target="_blank" rel="noreferrer"><Icon name="open" /></a>}</div>}
      {productLinkMode(link) === "shared" && <div className="check-line"><span>{link.checkNote ?? "尚未执行网页可访问性检测"}</span>{canEdit && <button disabled={checking === link.id} onClick={() => void onCheck(product.id, link.id, link.url)}>{checking === link.id ? "正在检测" : "检测链接"}</button>}</div>}
    </section>)}{(canEdit || canDelete) && <footer className="product-row-actions">{canEdit && <button className="product-image-button" onClick={() => imageInput.current?.click()}>{product.imageUrl ? "更换产品图片" : "添加产品图片"}</button>}{canEdit && product.imageUrl && <button className="product-image-remove" onClick={() => onImageRemove(product)}>移除图片</button>}{canDelete && <button className="delete-button" onClick={() => onDelete(product)}>删除产品</button>}</footer>}</div>}
  </article>;
}
