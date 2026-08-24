export const SUPPORTED_PLATFORMS = [
  "抖音",
  "视频号",
  "小红书",
  "淘宝",
  "天猫",
  "京东",
  "快手",
  "拼多多",
  "其他",
] as const;

export type LinkEntry = { platform: string; value: string };
export type PackageInput = { name: string; price: number; description: string };
export type ParsedProductStatus = "正常推广" | "暂停推广" | "已下架";
export type ConversationalProductEdit = {
  query: string;
  platform?: string;
  price?: number;
  mechanism?: string;
  commission?: number;
  productStatus?: ParsedProductStatus;
  fieldCount: number;
};

export type QuickProductInput = {
  name: string;
  manufacturer: string;
  price: number | null;
  packages: PackageInput[];
  mechanism: string;
  commission: number | null;
  productStatus: ParsedProductStatus;
  links: LinkEntry[];
};

// Supplier messages rarely use one fixed field name. Keep the aliases in one
// place so quick entry, batch import, and conversational editing understand the
// same wording (for example “产品佣金” and “推广佣金比例”).
const COMMISSION_FIELD_PATTERN = "(?:(?:产品|商品|推广|达人|带货|直播)\\s*)?佣金(?:比例|率|点位)?|(?:佣金)?点位|佣点";
const PRICE_FIELD_PATTERN = "单品价格|单品价|产品价格|商品价格|统一价格|活动价格|直播价格|零售价|售价|价格";
const MECHANISM_FIELD_PATTERN = "产品机制|商品机制|销售机制|带货机制|活动机制|促销机制|优惠机制|直播机制|机制";
const STATUS_FIELD_PATTERN = "推广状态|产品状态|商品状态|带货状态|状态";
const FIELD_SEPARATOR_PATTERN = "(?:是|为|叫|[:：])";

export function extractCommission(text: string) {
  const labeled = text.match(new RegExp(`(?:${COMMISSION_FIELD_PATTERN})\\s*${FIELD_SEPARATOR_PATTERN}?\\s*(\\d+(?:\\.\\d+)?)\\s*[%％]`, "i"));
  const plain = text.trim().match(/^(\d+(?:\.\d+)?)\s*[%％]$/);
  const raw = labeled?.[1] ?? plain?.[1];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export function extractPrice(text: string) {
  const match = text.match(new RegExp(`(?:${PRICE_FIELD_PATTERN})\\s*${FIELD_SEPARATOR_PATTERN}?\\s*[¥￥]?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:元|块)?`, "i"));
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 99_999_999 ? value : null;
}

/** Recognize optional package lists such as “套餐：2盒69.9元；3盒99元”. */
export function extractPackages(text: string): PackageInput[] {
  const parts: string[] = [];
  const packageLine = /^(?:套餐|组合|规格)(?:\s*\d+)?\s*[:：]\s*(.+)$/gim;
  for (const match of text.matchAll(packageLine)) {
    parts.push(...String(match[1] ?? "").split(/[；;]+/).map((item) => item.trim()).filter(Boolean));
  }
  const seen = new Set<string>();
  const packages: PackageInput[] = [];
  for (const part of parts) {
    const match = part.match(/^(.+?)\s*(?:价格\s*[:：]?\s*)?[¥￥]?\s*(\d+(?:\.\d+)?)\s*(?:元|块)(?:\s*[,，、|/—-]?\s*(.*))?$/i);
    if (!match) continue;
    const name = match[1].trim().replace(/[：:]$/, "").trim();
    const price = Number(match[2]);
    const description = (match[3] ?? "").trim();
    const key = normalizeSearchText(name);
    if (!name || !Number.isFinite(price) || price <= 0 || !key || seen.has(key)) continue;
    seen.add(key);
    packages.push({ name, price, description });
  }
  return packages;
}

export type SearchableProduct = {
  name: string;
  aliases?: string[];
  manufacturer?: string;
};

const PLATFORM_PATTERN = SUPPORTED_PLATFORMS.join("|");

/** Parse one or more edits from natural language. An empty query means the
 * command is a follow-up for the product already in conversation context. */
export function parseConversationalProductEdit(text: string): ConversationalProductEdit {
  const value = text.trim().replace(/^(?:请)?(?:把|将)\s*/, "");
  const operator = "(?:改成|改为|更新为|修改为|设为|设置为|是|为|[:：])";
  const editableFieldPattern = `(?:${PRICE_FIELD_PATTERN}|${MECHANISM_FIELD_PATTERN}|${COMMISSION_FIELD_PATTERN}|${STATUS_FIELD_PATTERN})`;
  const firstField = new RegExp(`(?:的)?(?:${PLATFORM_PATTERN})?(?:的)?${editableFieldPattern}\\s*${operator}`).exec(value);
  const query = firstField ? value.slice(0, firstField.index).replace(/的$/, "").trim() : "";
  const platform = SUPPORTED_PLATFORMS.find((item) => item !== "其他" && value.includes(item));
  const priceMatch = value.match(new RegExp(`(?:${PRICE_FIELD_PATTERN})\\s*${operator}\\s*[¥￥]?(\\d+(?:\\.\\d+)?)\\s*(?:元|块)?`, "i"));
  const commissionMatch = value.match(new RegExp(`(?:${COMMISSION_FIELD_PATTERN})\\s*${operator}\\s*(\\d+(?:\\.\\d+)?)\\s*[%％]`, "i"));
  const mechanismMatch = value.match(new RegExp(`(?:${MECHANISM_FIELD_PATTERN})\\s*${operator}\\s*(.+?)(?=\\s*[，,；;]\\s*${editableFieldPattern}\\s*${operator}|$)`, "i"));
  const statusMatch = value.match(new RegExp(`(?:${STATUS_FIELD_PATTERN})\\s*${operator}\\s*(正常推广|暂停推广|暂停|已下架|下架|恢复推广|恢复正常)`, "i"));
  const price = priceMatch ? Number(priceMatch[1]) : undefined;
  const commission = commissionMatch ? Number(commissionMatch[1]) : undefined;
  const productStatus: ParsedProductStatus | undefined = statusMatch
    ? statusMatch[1].includes("暂停") ? "暂停推广" : statusMatch[1].includes("下架") ? "已下架" : "正常推广"
    : undefined;
  const mechanism = mechanismMatch?.[1]?.trim();
  const fields = [price, mechanism, commission, productStatus].filter((item) => item !== undefined);
  return { query, platform, price, mechanism, commission, productStatus, fieldCount: fields.length };
}

export function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/(?:官方旗舰店|旗舰店|专卖店)/g, "")
    .replace(/[\s，,。.!！?？:：；;“”'"《》【】（）()_\-/]/g, "");
}

export function inferPlatform(value: string, context = "") {
  const combined = `${context} ${value}`.toLowerCase();
  if (/视频号|微信|weixin|channels/.test(combined)) return "视频号";
  if (/抖音|douyin/.test(combined)) return "抖音";
  if (/小红书|xiaohongshu|xhslink/.test(combined)) return "小红书";
  if (/天猫|tmall/.test(combined)) return "天猫";
  if (/淘宝|taobao|tb\.cn/.test(combined)) return "淘宝";
  if (/京东|jd\.com|3\.cn/.test(combined)) return "京东";
  if (/快手|kuaishou/.test(combined)) return "快手";
  if (/拼多多|pinduoduo|yangkeduo/.test(combined)) return "拼多多";
  return "其他";
}

/**
 * Extract values explicitly supplied after “链接”. The value can be a normal
 * URL, a scheme URL, a short domain, an app deep link, or a platform token.
 * The only hard requirement is that the captured value is not blank.
 */
export function extractLinkEntries(text: string): LinkEntry[] {
  const entries: LinkEntry[] = [];
  const labelExpression = new RegExp(
    `(?:(?<platform>${PLATFORM_PATTERN})\\s*(?:的)?\\s*)?(?:商品|产品)?链接\\s*(?:是|为|[:：])?\\s*(?<value>.+?)(?=\\s*(?:[，,；;\\n]|(?:${PLATFORM_PATTERN})\\s*(?:的)?\\s*(?:商品|产品)?链接|(?:厂家|品牌|供应商|${MECHANISM_FIELD_PATTERN}|套餐|组合|规格|${PRICE_FIELD_PATTERN}|到手价|${COMMISSION_FIELD_PATTERN}|${STATUS_FIELD_PATTERN})\\s*(?:是|为|[:：])|$))`,
    "gi",
  );

  for (const match of text.matchAll(labelExpression)) {
    const value = match.groups?.value?.trim();
    if (!value || /^[，,；;]/.test(value)) continue;
    const explicitPlatform = match.groups?.platform?.trim();
    entries.push({
      platform: explicitPlatform || inferPlatform(value, match[0]),
      value,
    });
  }

  if (entries.length) return dedupeEntries(entries);

  // Friendly fallback for messages such as “添加产品A 抖音 v.douyin.com/xxx”.
  const tokens = text.match(/(?:[a-z][a-z0-9+.-]*:\/\/[^\s，,；;]+|(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s，,；;]*)?|[\w-]+:\/\/[^\s，,；;]+)/gi) ?? [];
  return dedupeEntries(tokens.map((value) => ({ platform: inferPlatform(value, text), value: value.trim() })).filter((entry) => entry.value));
}

function lineField(text: string, labels: string[]) {
  const expression = new RegExp(`^(?:${labels.join("|")})\\s*(?:是|为|叫|[:：])\\s*(.+)$`, "im");
  return text.match(expression)?.[1]?.trim() ?? "";
}

export function parseQuickProductInput(text: string): QuickProductInput {
  const name = lineField(text, ["产品名称", "商品名称", "品名", "产品", "商品"])
    || text.match(new RegExp(`(?:添加|新增|录入|记录|保存)\\s*(?:一个|这款|这个)?\\s*(?:产品|商品)?\\s*[：:]?\\s*([^，,；;\\n]+?)(?=\\s*(?:抖音|视频号|小红书|淘宝|天猫|京东|快手|拼多多|链接|厂家|品牌|${PRICE_FIELD_PATTERN}|套餐|${MECHANISM_FIELD_PATTERN}|${COMMISSION_FIELD_PATTERN})|[，,；;\\n]|$)`, "i"))?.[1]?.trim()
    || "";
  const manufacturer = lineField(text, ["厂家", "品牌", "供应商"]);
  const price = extractPrice(text);
  const packages = extractPackages(text);
  const mechanism = lineField(text, [MECHANISM_FIELD_PATTERN])
    || text.match(new RegExp(`(?:${MECHANISM_FIELD_PATTERN})\\s*${FIELD_SEPARATOR_PATTERN}?\\s*(.+?)(?=(?:[，,；;]\\s*)?(?:${COMMISSION_FIELD_PATTERN}|套餐|组合|规格|${STATUS_FIELD_PATTERN})\\s*${FIELD_SEPARATOR_PATTERN}|$)`, "i"))?.[1]?.trim()
    || "";
  const commission = extractCommission(text);
  const rawStatus = lineField(text, [STATUS_FIELD_PATTERN])
    || text.match(new RegExp(`(?:${STATUS_FIELD_PATTERN})\\s*${FIELD_SEPARATOR_PATTERN}?\\s*(正常推广|暂停推广|暂停|已下架|下架)`, "i"))?.[1]?.trim()
    || "";
  const productStatus: ParsedProductStatus = rawStatus.includes("暂停")
    ? "暂停推广"
    : rawStatus.includes("下架")
      ? "已下架"
      : "正常推广";
  const links: LinkEntry[] = [];
  const platformLine = new RegExp(`^(?<platform>${PLATFORM_PATTERN})\\s*(?:商品|产品)?(?:链接|地址|口令)?\\s*[:：]\\s*(?<value>.+)$`, "gim");
  for (const match of text.matchAll(platformLine)) {
    const value = match.groups?.value?.trim();
    const platform = match.groups?.platform?.trim();
    if (platform && value) links.push({ platform, value });
  }
  const genericLink = lineField(text, ["链接", "地址", "口令"]);
  if (genericLink) links.push({ platform: inferPlatform(genericLink, text), value: genericLink });
  if (!links.length) links.push(...extractLinkEntries(text));
  return { name, manufacturer, price, packages, mechanism, commission, productStatus, links: dedupeEntries(links) };
}

/** Split a pasted chat transcript into product-sized blocks. A new labelled
 * product line or a visible divider starts the next product, so users do not
 * need to clean up ordinary supplier messages before pasting them. */
export function parseBatchProductInputs(text: string): QuickProductInput[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  const productStart = /^(?:(?:产品|商品)(?:名称)?|品名)\s*\d*\s*(?:是|为|叫|[:：])|^(?:添加|新增|录入|记录|保存)\s*(?:一个|这款|这个)?\s*(?:产品|商品)/;
  const divider = /^\s*(?:[-—_=*]{3,}|第\s*\d+\s*款)\s*$/;
  const hasProductStart = () => current.some((line) => productStart.test(line.trim()));
  const pushCurrent = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (divider.test(trimmed)) {
      pushCurrent();
      continue;
    }
    if (trimmed && productStart.test(trimmed) && current.some((item) => item.trim()) && hasProductStart()) pushCurrent();
    current.push(line);
  }
  pushCurrent();

  let candidates = blocks;
  if (blocks.length <= 1) {
    const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\s*\n+/).map((item) => item.trim()).filter(Boolean);
    if (paragraphs.length > 1 && paragraphs.every((item) => {
      const parsed = parseQuickProductInput(item);
      return Boolean(parsed.name || parsed.links.length || parsed.price !== null);
    })) candidates = paragraphs;
  }

  return candidates
    .map(parseQuickProductInput)
    .filter((item) => Boolean(item.name || item.links.length || item.price !== null || item.mechanism || item.commission !== null));
}

function dedupeEntries(entries: LinkEntry[]) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.platform}\u0000${entry.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractQueryName(text: string) {
  let value = text
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/[^\s，,；;]+|(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s，,；;]*)?)/gi, "")
    .replace(/^(?:请帮我|麻烦帮我|帮我|请|麻烦|给我|我要|我想要|查一下|查询一下|查询|查找|找一下|发我|打开|看看)\s*/g, "")
    .replace(new RegExp(`(?:的)?(?:${PLATFORM_PATTERN})?(?:的)?(?:产品|商品)?(?:链接|地址|口令)`, "g"), "")
    .replace(/[，,。.!！?？:：；;\s]/g, "")
    .replace(/(?:是什么|是多少|在哪里|在哪儿|在哪|有没有|给我|发我|呢|吗|呀|啊|一下)$/g, "")
    .trim();

  // “查XX” and “找XX” are also common, but only remove the leading verb.
  value = value.replace(/^(?:查|找)?一下(?=.)/, "").replace(/^(?:查|找)(?=.)/, "");
  return value;
}

/**
 * Recognize a request to open the full product editor without mistaking
 * single-field commands such as “把A的佣金修改为35%” for that intent.
 */
export function extractEditQuery(text: string) {
  const value = text.trim();
  if (/(?:机制|佣金|价格|链接|状态)\s*(?:改成|更新为|修改为|是|为|[:：])/.test(value)) return "";
  const match = value.match(/^(?:我要|我想|帮我|请帮我|麻烦帮我|需要)?\s*(?:修改|编辑|更新)\s*(.+)$/);
  if (!match?.[1]) return "";
  return match[1]
    .replace(/[。！？!?]+$/g, "")
    .replace(/(?:这个|这款)?(?:产品|商品)(?:的)?(?:全部)?(?:资料|信息)?$/g, "")
    .replace(/(?:的)?(?:全部)?(?:资料|信息)$/g, "")
    .trim();
}

function bigrams(value: string) {
  if (value.length < 2) return [value];
  const result: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) result.push(value.slice(index, index + 2));
  return result;
}

function diceCoefficient(left: string, right: string) {
  const a = bigrams(left);
  const b = bigrams(right);
  const counts = new Map<string, number>();
  a.forEach((item) => counts.set(item, (counts.get(item) ?? 0) + 1));
  let intersection = 0;
  b.forEach((item) => {
    const count = counts.get(item) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(item, count - 1);
    }
  });
  return (2 * intersection) / Math.max(1, a.length + b.length);
}

function charOverlap(left: string, right: string) {
  const a = new Set([...left]);
  const b = new Set([...right]);
  const common = [...a].filter((char) => b.has(char)).length;
  return common / Math.max(1, Math.min(a.size, b.size));
}

function levenshtein(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

export function fuzzyScore(product: SearchableProduct, query: string) {
  const q = normalizeSearchText(query);
  if (!q) return 0;
  const values = [product.name, ...(product.aliases ?? []), product.manufacturer ?? ""]
    .map(normalizeSearchText)
    .filter(Boolean);

  let best = 0;
  for (const value of values) {
    if (value === q) best = Math.max(best, 100);
    else if (value.includes(q) || q.includes(value)) best = Math.max(best, q.length === 1 ? 72 : 88);
    else {
      const dice = diceCoefficient(value, q);
      const overlap = charOverlap(value, q);
      const editSimilarity = 1 - levenshtein(value, q) / Math.max(value.length, q.length);
      best = Math.max(best, Math.round(dice * 45 + overlap * 30 + Math.max(0, editSimilarity) * 25));
    }
  }
  return best;
}

export function fuzzyFind<T extends SearchableProduct>(products: T[], query: string, limit = 6) {
  return products
    .map((product) => ({ product, score: fuzzyScore(product, query) }))
    .filter((item) => item.score >= 38)
    .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name, "zh-CN"))
    .slice(0, limit);
}

export type DuplicateProductCandidate = SearchableProduct & {
  id: string;
  links: Array<{ url: string; platform?: string }>;
};

/**
 * Detect exact duplicate names and links before saving. Similar names are kept
 * separate because they are only a reminder and must never block a valid save.
 */
export function detectProductDuplicates<T extends DuplicateProductCandidate>(
  products: T[],
  candidate: { name: string; links: Array<{ url: string }> },
  excludeProductId?: string | null,
) {
  const available = products.filter((product) => product.id !== excludeProductId);
  const normalizedName = normalizeSearchText(candidate.name);
  const exactNameProduct = normalizedName
    ? available.find((product) => normalizeSearchText(product.name) === normalizedName)
    : undefined;
  const candidateUrls = candidate.links.map((link) => link.url.trim()).filter(Boolean);
  const candidateUrlSet = new Set(candidateUrls);
  const urlMatches = available.flatMap((product) => product.links
    .filter((link) => candidateUrlSet.has(link.url.trim()))
    .map((link) => ({ product, link })));
  const duplicateUrls = [...new Set(candidateUrls.filter((url, index) => candidateUrls.indexOf(url) !== index))];
  const similarProducts = normalizedName
    ? fuzzyFind(available, candidate.name, 4)
      .filter((item) => item.score >= 72 && normalizeSearchText(item.product.name) !== normalizedName)
    : [];

  return { exactNameProduct, urlMatches, duplicateUrls, similarProducts };
}
