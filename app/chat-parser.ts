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

export type LinkEntry = { platform: string; value: string; creatorName?: string };
export type PackageInput = { name: string; price: number; description: string };
export type SkuInput = { value: string; price: number | null };
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

function cleanConversationalProductQuery(value: string) {
  return value
    .replace(/^(?:请)?(?:帮我|替我|给|把|将)\s*/, "")
    .replace(/[，,；;。.!！?？\s]+$/g, "")
    .replace(/(?:这个|这款)?(?:产品|商品)?(?:的)?(?:(?:资料|信息)(?:做)?(?:一下)?(?:修改|更改|更新|编辑|调整)|(?:修改|更改|更新|编辑|调整)(?:一下)?(?:产品|商品)?(?:的)?(?:资料|信息)?)[，,；;。.!！?？\s]*$/g, "")
    .replace(/(?:这个|这款)?(?:产品|商品)(?:的)?$/g, "")
    .replace(/(?:的)?(?:全部)?(?:资料|信息)$/g, "")
    .trim();
}

export type QuickProductInput = {
  name: string;
  manufacturer: string;
  sku: string;
  skus: string[];
  skuEntries: SkuInput[];
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
const NAME_FIELD_PATTERN = "产品名称|商品名称|产品名|商品名|品名|款名|名称|产品|商品";
const MANUFACTURER_FIELD_PATTERN = "厂家名称|品牌名称|生产厂家|生产商|制造商|厂商|供货商|供应商|品牌方|厂家|品牌";
const SKU_FIELD_PATTERN = "(?:SKU|sku)(?:编码|编号)?\\s*\\d*|(?:产品规格|商品规格|规格型号|产品型号|商品型号|规格列表|规格选项|多规格|货号|型号|规格)\\s*\\d*";
const COMMISSION_FIELD_PATTERN = "(?:(?:产品|商品|推广|达人|带货|直播|主播)\\s*)?佣金(?:比例|率|点位)?|提成(?:比例|率)?|返佣(?:比例|率)?|分成(?:比例|率)?|(?:佣金)?点位|佣点|点佣";
const PRICE_FIELD_PATTERN = "(?:多个价格|多价格|价格列表|(?:SKU|sku|规格)?(?:单品价格|单品价|产品价格|商品价格|统一价格|活动价格|直播价格|直播价|到手价格|到手价|日常价|零售价|成交价|售价|价格))\\s*\\d*";
const MECHANISM_FIELD_PATTERN = "(?:有|存在)\\s*(?:特殊|专属|活动|优惠|买赠)?机制|产品机制|商品机制|销售机制|带货机制|活动机制|促销机制|优惠机制|直播机制|特殊机制|专属机制|达人机制|机制内容|买赠活动|优惠活动|促销活动|活动方案|机制";
const STATUS_FIELD_PATTERN = "推广状态|产品状态|商品状态|带货状态|状态";
const PACKAGE_FIELD_PATTERN = "套餐|组合|套装|组合装|多件装";
const LINK_FIELD_PATTERN = "(?:商品|产品|推广|橱窗)?(?:链接|地址|口令|商品卡)|橱窗链接";
const FIELD_SEPARATOR_PATTERN = "(?:是|为|叫|[:：])";
const MECHANISM_SEPARATOR_PATTERN = "(?:(?:中|里|内)?(?:包含|包括|含有)|内容(?:是|为)?|有|是|为|叫|[:：])";
const MECHANISM_CONCEPT_PATTERN = /(?:拍\s*[一二三四五六七八九十百两\d]+\s*发\s*[一二三四五六七八九十百两\d]+|买\s*[一二三四五六七八九十百两\d]+\s*(?:送|赠)\s*[一二三四五六七八九十百两\d]+|买[^，,；;。\n]{0,12}(?:送|赠)[^，,；;。\n]{0,12}|加赠|赠品|赠送|送同款|满\s*\d+(?:\.\d+)?\s*(?:减|送)|满减|优惠券|第二件(?:半价|折扣|[0-9.]+折)|前\s*\d+\s*名|限量(?:赠|送)|任选\s*[一二三四五六七八九十百两\d]+|限时(?:折扣|优惠)|立减|包邮)/i;

export function extractCommission(text: string) {
  const labeled = text.match(new RegExp(`(?:${COMMISSION_FIELD_PATTERN})\\s*(?:${FIELD_SEPARATOR_PATTERN}|有)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:[%％]|个?点)`, "i"));
  const plain = text.trim().match(/^(\d+(?:\.\d+)?)\s*[%％]$/);
  const raw = labeled?.[1] ?? plain?.[1];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export function extractPrice(text: string) {
  const labeled = text.match(new RegExp(`(?:${PRICE_FIELD_PATTERN})\\s*(?:${FIELD_SEPARATOR_PATTERN}|有)?\\s*[¥￥]?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:元|块)?`, "i"));
  const conceptual = text.match(/(?:(?:单|每|一)(?:件|盒|瓶|袋|套|包|罐))\s*(?:售价|价格|价|卖到?|只要|到手|是|为)?\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/i)
    || text.match(/(?:卖到?|只要|到手)\s*(?:是|为|价|价格)?\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/i)
    || text.match(/[¥￥]?\s*(\d+(?:\.\d+)?)\s*(?:元|块)\s*(?:一|每|单)(?:件|盒|瓶|袋|套|包|罐)/i);
  const match = labeled ?? conceptual;
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 99_999_999 ? value : null;
}

function mechanismBoundaryPattern() {
  return `(?=(?:[，,；;。\\n]\\s*)?(?:${COMMISSION_FIELD_PATTERN}|${PACKAGE_FIELD_PATTERN}|${STATUS_FIELD_PATTERN}|${PRICE_FIELD_PATTERN}|${MANUFACTURER_FIELD_PATTERN}|${SKU_FIELD_PATTERN}|(?:(?:${PLATFORM_PATTERN})\\s*(?:的)?\\s*)?(?:${LINK_FIELD_PATTERN}))\\s*(?:${FIELD_SEPARATOR_PATTERN})?|$)`;
}

/**
 * Recognize both explicit mechanism labels and unlabeled promotion concepts.
 * Examples: “特殊机制中包含：买一送一” and a standalone “拍一发二”.
 */
export function extractMechanism(text: string) {
  const labeled = text.match(new RegExp(
    `(?:${MECHANISM_FIELD_PATTERN})\\s*(?:${MECHANISM_SEPARATOR_PATTERN})?\\s*[:：，,]?\\s*(.+?)${mechanismBoundaryPattern()}`,
    "i",
  ))?.[1]?.trim();
  if (labeled) return labeled.replace(/^[：:，,；;\s]+|[，,；;。\s]+$/g, "").trim();

  const excludedField = new RegExp(
    `^(?:${NAME_FIELD_PATTERN}|${MANUFACTURER_FIELD_PATTERN}|${SKU_FIELD_PATTERN}|${PRICE_FIELD_PATTERN}|${COMMISSION_FIELD_PATTERN}|${STATUS_FIELD_PATTERN}|${PACKAGE_FIELD_PATTERN}|(?:(?:${PLATFORM_PATTERN})\\s*(?:的)?\\s*)?(?:${LINK_FIELD_PATTERN}))\\s*(?:${FIELD_SEPARATOR_PATTERN})?`,
    "i",
  );
  const concepts = text
    .replace(/\r\n?/g, "\n")
    .split(new RegExp(
      `[，,；;。\\n]+|\\s+(?=(?:${NAME_FIELD_PATTERN}|${MANUFACTURER_FIELD_PATTERN}|${SKU_FIELD_PATTERN}|${PRICE_FIELD_PATTERN}|${PACKAGE_FIELD_PATTERN}|${COMMISSION_FIELD_PATTERN}|${STATUS_FIELD_PATTERN}|(?:(?:${PLATFORM_PATTERN})\\s*(?:的)?\\s*)?(?:${LINK_FIELD_PATTERN})|买\\s*[一二三四五六七八九十百两\\d]+\\s*(?:送|赠)|拍\\s*[一二三四五六七八九十百两\\d]+\\s*发|加赠|满减|优惠券|第二件|限时|立减|包邮))`,
      "i",
    ))
    .map((part) => part.trim())
    .filter((part) => part && !excludedField.test(part) && MECHANISM_CONCEPT_PATTERN.test(part))
    .map((part) => part.replace(/^(?:另外|另有|同时|还有|并且|而且|这款|该产品|这个产品)\s*/, "").trim());
  return [...new Set(concepts)].join("；");
}

/** Recognize optional package lists such as “套餐：2盒69.9元；3盒99元”. */
export function extractPackages(text: string): PackageInput[] {
  const parts: string[] = [];
  const packageLine = new RegExp(`^(?:${PACKAGE_FIELD_PATTERN})(?:\\s*\\d+)?\\s*(?:是|为|包括|包含|[:：])\\s*(.+)$`, "gim");
  for (const match of text.matchAll(packageLine)) {
    parts.push(...String(match[1] ?? "").split(/[；;]+/).map((item) => item.trim()).filter(Boolean));
  }
  const optionExpression = /([一二三四五六七八九十百两\d]+\s*(?:盒|瓶|袋|件|套|支|包|罐)(?:装)?)\s*(?:售价|价格|价|[:：])?\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?/gi;
  const conceptualOptions = [...text.matchAll(optionExpression)].map((match) => ({
    name: String(match[1] ?? "").replace(/\s+/g, ""),
    price: Number(match[2]),
  }));
  if (conceptualOptions.length > 1 || conceptualOptions.some((item) => !/^(?:1|一)(?:盒|瓶|袋|件|套|支|包|罐)$/.test(item.name))) {
    parts.push(...conceptualOptions.map((item) => `${item.name}${item.price}元`));
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
  const query = firstField ? cleanConversationalProductQuery(value.slice(0, firstField.index).replace(/的$/, "")) : "";
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
  const creatorPatterns = [
    new RegExp(`^(?<platform>${PLATFORM_PATTERN})\\s*(?:达人|主播)\\s*(?<creator>[^：:\\s]{1,24}?)\\s*(?:的)?(?:${LINK_FIELD_PATTERN})?\\s*[:：]\\s*(?<value>.+)$`, "gim"),
    new RegExp(`^(?<platform>${PLATFORM_PATTERN})\\s*[-—|｜]?\\s*(?<creator>[^：:\\s]{1,24}?)\\s*(?:的)?(?:${LINK_FIELD_PATTERN})\\s*[:：]\\s*(?<value>.+)$`, "gim"),
    new RegExp(`^(?<creator>[^：:\\s]{1,24}?)\\s*(?:的)?(?<platform>${PLATFORM_PATTERN})\\s*(?:达人|主播)?\\s*(?:${LINK_FIELD_PATTERN})\\s*[:：]\\s*(?<value>.+)$`, "gim"),
  ];
  for (const pattern of creatorPatterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match.groups?.value?.trim();
      const platform = match.groups?.platform?.trim();
      const creatorName = match.groups?.creator?.trim().replace(/^(?:达人|主播)/, "");
      if (value && platform && creatorName && !/^(?:统一|通用|共用|所有达人)$/.test(creatorName)) entries.push({ platform, creatorName, value });
    }
  }
  const labelExpression = new RegExp(
    `(?:(?<platform>${PLATFORM_PATTERN})\\s*(?:的)?\\s*)?(?:${LINK_FIELD_PATTERN})\\s*(?:${FIELD_SEPARATOR_PATTERN})?\\s*(?<value>.+?)(?=(?:\\s*[，,；;\\n]|\\s+(?:(?:(?:${PLATFORM_PATTERN})\\s*(?:的)?\\s*)?(?:${LINK_FIELD_PATTERN})|(?:${NAME_FIELD_PATTERN}|${MANUFACTURER_FIELD_PATTERN}|${SKU_FIELD_PATTERN}|${PACKAGE_FIELD_PATTERN}|${PRICE_FIELD_PATTERN}|${COMMISSION_FIELD_PATTERN}|${STATUS_FIELD_PATTERN})\\s*(?:${FIELD_SEPARATOR_PATTERN})?|(?:${MECHANISM_FIELD_PATTERN})\\s*(?:${MECHANISM_SEPARATOR_PATTERN})?\\s*[:：]?|${MECHANISM_CONCEPT_PATTERN.source}|暂时不推|先不推|暂停推广|停止推广|停推|不推广|已下架|下架了?|停售|恢复推广|继续推广)|\\s*$))`,
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

function cleanFieldValue(value = "") {
  return value.replace(/^[：:，,；;\\s]+|[，,；;。\\s]+$/g, "").trim();
}

function trimAtNextField(value = "") {
  const nextField = new RegExp(
    `\\s+(?=(?:(?:${PLATFORM_PATTERN})\\s*(?:的)?\\s*)?(?:${LINK_FIELD_PATTERN})|${MANUFACTURER_FIELD_PATTERN}|${SKU_FIELD_PATTERN}|${PRICE_FIELD_PATTERN}|${PACKAGE_FIELD_PATTERN}|${MECHANISM_FIELD_PATTERN}|${COMMISSION_FIELD_PATTERN}|${STATUS_FIELD_PATTERN}|来自|出自|由\\S{1,30}(?:生产|制造|供货)|(?:(?:单|每|一)(?:件|盒|瓶|袋|套|包|罐)|卖|只要|到手)\\s*(?:售价|价格|价|只要|是|为)?\\s*[¥￥]?\\d|[二三四五六七八九十百两\\d]+\\s*(?:件|盒|瓶|袋|套|包|罐)\\s*[¥￥]?\\d|买\\s*[一二三四五六七八九十百两\\d]+\\s*(?:送|赠)|拍\\s*[一二三四五六七八九十百两\\d]+\\s*发|暂时不推|先不推|暂停推广|停止推广|停推|已下架|下架了?|停售|恢复推广|继续推广)`,
    "i",
  );
  return cleanFieldValue(value.split(nextField)[0] ?? value);
}

function boundedValuePattern() {
  return "([^，,；;。\\n]+)";
}

/** Product names may be labelled, introduced conversationally, or follow an
 * add/save command. Values stop at the next ordinary supplier-message clause. */
export function extractProductName(text: string) {
  const bounded = boundedValuePattern();
  const patterns = [
    new RegExp(`(?:^|[，,；;。\\n])\\s*(?:产品名称|商品名称|产品名|商品名|品名|款名|名称)\\s*(?:${FIELD_SEPARATOR_PATTERN})?\\s*${bounded}`, "i"),
    new RegExp(`(?:^|[，,；;。\\n])\\s*(?:产品|商品)\\s*(?:${FIELD_SEPARATOR_PATTERN})\\s*${bounded}`, "i"),
    new RegExp(`(?:这个|这款|该|本)?\\s*(?:产品|商品)\\s*(?:名字|名称)?\\s*(?:叫做?|名为)\\s*${bounded}`, "i"),
    new RegExp(`(?:添加|新增|录入|记录|保存)\\s*(?:一个|一款|这款|这个)?\\s*(?:产品|商品)?\\s*[：:]?\\s*${bounded}`, "i"),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern)?.[1];
    if (!match) continue;
    const value = trimAtNextField(match)
      .replace(new RegExp(`\\s*(?:(?:${PLATFORM_PATTERN})\\s*(?:的)?\\s*)?(?:${LINK_FIELD_PATTERN})$`, "i"), "")
      .trim();
    if (value) return value;
  }
  return "";
}

/** Recognize supplier/brand aliases plus phrases such as “来自小熊工厂” and
 * “由小熊日化生产”. */
export function extractManufacturer(text: string) {
  const bounded = boundedValuePattern();
  const patterns = [
    new RegExp(`(?:^|[，,；;。\\n\\s])(?:${MANUFACTURER_FIELD_PATTERN})(?:(?:\\s*${FIELD_SEPARATOR_PATTERN}\\s*)|(?:\\s+))${bounded}`, "i"),
    new RegExp(`(?:来自|出自)\\s*${bounded}`, "i"),
    new RegExp(`由\\s*(.+?)\\s*(?:生产|制造|供货)(?=[，,；;。\\n]|$)`, "i"),
    new RegExp(`((?:[^，,；;。\\n]{1,30})(?:厂家|工厂|厂商|品牌方))\\s*(?:生产|制造|供货)(?=[，,；;。\\n]|$)`, "i"),
  ];
  for (const pattern of patterns) {
    const value = trimAtNextField(text.match(pattern)?.[1]);
    if (value) return value;
  }
  return "";
}

/** Recognize SKU/specification lists and pair each item with its own optional
 * price. Supports numbered fields, delimited lists, and conversational labels. */
export function extractSkuEntries(text: string): SkuInput[] {
  const boundary = `(?=(?:[，,；;。\\n]\\s*|\\s+)(?:${SKU_FIELD_PATTERN}|${PRICE_FIELD_PATTERN}|${MANUFACTURER_FIELD_PATTERN}|${PACKAGE_FIELD_PATTERN}|${MECHANISM_FIELD_PATTERN}|${COMMISSION_FIELD_PATTERN}|${STATUS_FIELD_PATTERN}|(?:(?:${PLATFORM_PATTERN})\\s*(?:的)?\\s*)?(?:${LINK_FIELD_PATTERN}))\\s*(?:${FIELD_SEPARATOR_PATTERN})?|$)`;
  const expression = new RegExp(
    `(?:^|[，,；;。\\n\\s])(?<label>${SKU_FIELD_PATTERN})(?:(?:\\s*${FIELD_SEPARATOR_PATTERN}\\s*)|(?:\\s+))(?<value>.+?)${boundary}`,
    "gim",
  );
  const numberedPrices = new Map<string, number>();
  const genericPrices: number[] = [];
  const priceExpression = new RegExp(`(?<label>${PRICE_FIELD_PATTERN})\\s*(?:${FIELD_SEPARATOR_PATTERN}|有)?\\s*[¥￥]?\\s*(?<price>\\d+(?:\\.\\d+)?)\\s*(?:元|块)?`, "gi");
  for (const match of text.matchAll(priceExpression)) {
    const label = String(match.groups?.label ?? "");
    const index = label.match(/(\d+)\s*$/)?.[1] ?? "";
    const price = Number(match.groups?.price);
    if (!Number.isFinite(price) || price <= 0 || price > 99_999_999) continue;
    if (index) numberedPrices.set(index, price);
    else genericPrices.push(price);
  }
  const priceListMatch = text.match(/(?:多个价格|多价格|价格列表|SKU价格|规格价格)\s*(?:是|为|[:：])?\s*([^。\n]+?)(?=(?:[，,；;]\s*)?(?:厂家|品牌|套餐|机制|佣金|推广状态|产品状态|抖音|视频号|小红书|淘宝|天猫|京东|快手|拼多多|链接)|\n|$)/i);
  const listedPrices = (priceListMatch?.[1]?.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 99_999_999);
  if (listedPrices.length > 1) genericPrices.splice(0, genericPrices.length, ...listedPrices);

  const entries: Array<SkuInput & { index: string }> = [];
  for (const match of text.matchAll(expression)) {
    const label = String(match.groups?.label ?? "");
    const labelIndex = label.match(/(\d+)\s*$/)?.[1] ?? "";
    const parts = String(match.groups?.value ?? "").split(/[，,；;、\\n]+/).map((value) => value.trim()).filter(Boolean);
    parts.forEach((part, partIndex) => {
      const boundedPart = trimAtNextField(part);
      const inlinePrice = boundedPart.match(/(?:价格|售价|价)?\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(?:元|块)(?:\s*$|\s*[/|—-])/i);
      const price = inlinePrice ? Number(inlinePrice[1]) : labelIndex ? numberedPrices.get(labelIndex) ?? null : genericPrices.length === parts.length ? genericPrices[partIndex] : parts.length === 1 && genericPrices.length === 1 ? genericPrices[0] : null;
      const value = cleanFieldValue(boundedPart
        .replace(/(?:对应)?(?:SKU|sku|规格)?(?:价格|售价|价)\s*\d*\s*(?:是|为|[:：])?\s*[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元|块)?/gi, "")
        .replace(/[¥￥]?\s*\d+(?:\.\d+)?\s*(?:元|块)(?:\s*$|\s*[/|—-].*$)/i, ""))
        .replace(/^(?:规格|SKU)\s*[-—:]?\s*/i, "")
        .trim();
      if (value) entries.push({ value, price, index: labelIndex || String(partIndex + 1) });
    });
  }

  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = normalizeSearchText(entry.value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ value, price }) => ({ value, price }));
}

export function extractSkus(text: string) {
  return extractSkuEntries(text).map((entry) => entry.value);
}

export function extractSku(text: string) {
  return extractSkus(text)[0] ?? "";
}

/** Map both labelled values and everyday promotion wording to the three saved
 * product states. */
export function extractProductStatus(text: string): ParsedProductStatus {
  const explicit = text.match(new RegExp(
    `(?:${STATUS_FIELD_PATTERN})\\s*(?:${FIELD_SEPARATOR_PATTERN})?\\s*(正常推广|推广中|在推|暂停推广|暂停|暂时不推|先不推|停推|停止推广|不推广|已下架|下架了?|停售|恢复推广|继续推广|可以推广|正常上架)`,
    "i",
  ))?.[1] ?? "";
  const source = explicit || text;
  if (/(?:已下架|下架了?|商品下架|产品下架|停售)/.test(source)) return "已下架";
  if (/(?:暂停推广|暂时不推|先不推|停止推广|停推|不推广)/.test(source)) return "暂停推广";
  return "正常推广";
}

export function parseQuickProductInput(text: string): QuickProductInput {
  const name = extractProductName(text);
  const manufacturer = extractManufacturer(text);
  const skuEntries = extractSkuEntries(text);
  const skus = skuEntries.map((entry) => entry.value);
  const sku = skus[0] ?? "";
  const explicitPrice = extractPrice(text);
  const skuPrices = skuEntries.map((entry) => entry.price).filter((value): value is number => value !== null);
  const price = explicitPrice ?? (skuPrices.length ? Math.min(...skuPrices) : null);
  const packages = extractPackages(text);
  const mechanism = extractMechanism(text);
  const commission = extractCommission(text);
  const productStatus = extractProductStatus(text);
  const links: LinkEntry[] = [...extractLinkEntries(text).filter((entry) => Boolean(entry.creatorName))];
  const platformLine = new RegExp(`^(?<platform>${PLATFORM_PATTERN})\\s*(?:的)?\\s*(?:(?:${LINK_FIELD_PATTERN})\\s*)?(?:${FIELD_SEPARATOR_PATTERN})\\s*(?<value>.+)$`, "gim");
  for (const match of text.matchAll(platformLine)) {
    const value = match.groups?.value?.trim();
    const platform = match.groups?.platform?.trim();
    if (platform && value) links.push({ platform, value });
  }
  const genericLink = lineField(text, [LINK_FIELD_PATTERN]);
  if (genericLink) links.push({ platform: inferPlatform(genericLink, text), value: genericLink });
  if (!links.length) links.push(...extractLinkEntries(text));
  return { name, manufacturer, sku, skus, skuEntries, price, packages, mechanism, commission, productStatus, links: dedupeEntries(links) };
}

/** Split a pasted chat transcript into product-sized blocks. A new labelled
 * product line or a visible divider starts the next product, so users do not
 * need to clean up ordinary supplier messages before pasting them. */
export function parseBatchProductInputs(text: string): QuickProductInput[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  const productStart = /^(?:(?:产品|商品)(?:名称|名)?|品名|款名)\s*\d*\s*(?:是|为|叫|名为|[:：])|^(?:这个|这款|该)?(?:产品|商品)\s*(?:名字|名称)?\s*(?:叫做?|名为)|^(?:添加|新增|录入|记录|保存)\s*(?:一个|一款|这款|这个)?\s*(?:产品|商品)/;
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
    const key = `${entry.platform}\u0000${entry.creatorName ?? ""}\u0000${entry.value}`;
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
  if (/(?:机制|佣金|价格|链接|状态)\s*(?:改成|改为|更新为|修改为|设为|设置为|是|为|[:：])/.test(value)) return "";
  const polite = value.replace(/^(?:请帮我|麻烦帮我|帮我|我要|我想|需要|请|麻烦)\s*/, "");
  const leadingVerb = polite.match(/^(?:修改|编辑|更新|更改|调整)\s*(.+)$/)?.[1];
  const directed = polite.match(/^(?:给|把|将)\s*(.+)$/)?.[1];
  const candidate = leadingVerb ?? (directed && /(?:修改|编辑|更新|更改|调整)/.test(directed) ? directed : "");
  return candidate ? cleanConversationalProductQuery(candidate) : "";
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
  links: Array<{ url: string; platform?: string; creatorLinks?: Array<{ url: string }> }>;
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
  const urlMatches = available.flatMap((product) => product.links.flatMap((link) => {
    const urls = [link.url, ...(link.creatorLinks ?? []).map((item) => item.url)].map((url) => url.trim()).filter(Boolean);
    return urls.filter((url) => candidateUrlSet.has(url)).map((matchedUrl) => ({ product, link, matchedUrl }));
  }));
  const duplicateUrls = [...new Set(candidateUrls.filter((url, index) => candidateUrls.indexOf(url) !== index))];
  const similarProducts = normalizedName
    ? fuzzyFind(available, candidate.name, 4)
      .filter((item) => item.score >= 72 && normalizeSearchText(item.product.name) !== normalizedName)
    : [];

  return { exactNameProduct, urlMatches, duplicateUrls, similarProducts };
}
