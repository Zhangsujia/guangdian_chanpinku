import assert from "node:assert/strict";
import test from "node:test";
import { detectProductDuplicates, extractCommission, extractEditQuery, extractLinkEntries, extractManufacturer, extractMechanism, extractPackages, extractPrice, extractProductName, extractProductStatus, extractQueryName, extractSku, extractSkuEntries, extractSkus, fuzzyFind, parseBatchProductInputs, parseConversationalProductEdit, parseQuickProductInput } from "../app/chat-parser.ts";

test("accepts https, bare domains, deep links and non-empty platform tokens", () => {
  assert.deepEqual(extractLinkEntries("产品A，抖音链接 https://v.douyin.com/abc，视频号链接 wxchannels://item/88"), [
    { platform: "抖音", value: "https://v.douyin.com/abc" },
    { platform: "视频号", value: "wxchannels://item/88" },
  ]);
  assert.deepEqual(extractLinkEntries("添加产品A，抖音链接 v.douyin.com/abc"), [
    { platform: "抖音", value: "v.douyin.com/abc" },
  ]);
  assert.deepEqual(extractLinkEntries("添加产品A，视频号链接 #小程序://商品/AbCdEf"), [
    { platform: "视频号", value: "#小程序://商品/AbCdEf" },
  ]);
});

test("recognizes multiple creator-specific links on the same platform", () => {
  const parsed = parseQuickProductInput(`产品：胶原蛋白
价格：99元
抖音达人小王链接：douyin-wang-token
抖音达人小李链接：douyin-li-token
机制：拍一发二
佣金：35%`);
  assert.deepEqual(parsed.links, [
    { platform: "抖音", creatorName: "小王", value: "douyin-wang-token" },
    { platform: "抖音", creatorName: "小李", value: "douyin-li-token" },
  ]);
});

test("does not create an entry when the labeled link is blank", () => {
  assert.deepEqual(extractLinkEntries("添加产品A，抖音链接，机制79元"), []);
});

test("requires a valid percentage-shaped commission", () => {
  assert.equal(extractCommission("佣金35%"), 35);
  assert.equal(extractCommission("佣金：29.5％"), 29.5);
  assert.equal(extractCommission("产品佣金：35%"), 35);
  assert.equal(extractCommission("推广佣金比例为29.5％"), 29.5);
  assert.equal(extractCommission("达人佣金率 32%"), 32);
  assert.equal(extractCommission("主播提成35个点"), 35);
  assert.equal(extractCommission("返佣比例为31.5%"), 31.5);
  assert.equal(extractCommission("35%"), 35);
  assert.equal(extractCommission("佣金35元"), null);
  assert.equal(extractCommission("佣金120%"), null);
});

test("extracts one unified product price", () => {
  assert.equal(extractPrice("价格：99元"), 99);
  assert.equal(extractPrice("产品价格 ¥59.9"), 59.9);
  assert.equal(extractPrice("单盒只要49.9元"), 49.9);
  assert.equal(extractPrice("卖39.9元"), 39.9);
  assert.equal(extractPrice("59元一瓶"), 59);
  assert.equal(extractPrice("没有填写"), null);
});

test("extracts optional packages without changing the base item price", () => {
  assert.equal(extractPrice("单品价：39.9元\n套餐：2盒69.9元；3盒99元"), 39.9);
  assert.deepEqual(extractPackages("单品价：39.9元\n套餐：2盒69.9元；3盒99元 拍3发4"), [
    { name: "2盒", price: 69.9, description: "" },
    { name: "3盒", price: 99, description: "拍3发4" },
  ]);
  assert.deepEqual(extractPackages("单品价：39.9元"), []);
  assert.deepEqual(extractPackages("单盒49.9元，2盒69.9元，3盒99元"), [
    { name: "2盒", price: 69.9, description: "" },
    { name: "3盒", price: 99, description: "" },
  ]);
});

test("recognizes product-name and manufacturer concepts", () => {
  assert.equal(extractProductName("这个商品叫小熊洗衣液，单盒49.9元"), "小熊洗衣液");
  assert.equal(extractProductName("款名为晴雨伞，售价39元"), "晴雨伞");
  assert.equal(extractManufacturer("品牌方为自然堂，商品叫雪域面膜"), "自然堂");
  assert.equal(extractManufacturer("这款来自小熊工厂，单盒49.9元"), "小熊工厂");
  assert.equal(extractManufacturer("由清风日化生产，产品名为抽纸"), "清风日化");
});

test("recognizes optional SKU and product-specification aliases", () => {
  assert.equal(extractSku("SKU：A-102，价格49.9元"), "A-102");
  assert.equal(extractSku("产品规格 500ml×2瓶 单盒49.9元"), "500ml×2瓶");
  assert.equal(extractSku("货号为XY-88，佣金35%"), "XY-88");
  assert.equal(extractSku("产品：普通洗衣液，价格49.9元"), "");
  assert.deepEqual(extractPackages("产品规格：500ml×2瓶，价格49.9元"), []);
  assert.equal(parseQuickProductInput("产品：洗衣液，SKU：A-102，价格49.9元，抖音口令 token，机制买一送一，佣金35%").sku, "A-102");
});

test("recognizes multiple SKU/specification values for quick and batch entry", () => {
  assert.deepEqual(extractSkus("产品：洗衣液\nSKU：A-102；A-103；A-104\n价格：49.9元"), ["A-102", "A-103", "A-104"]);
  assert.deepEqual(extractSkus("产品规格1：500ml×2瓶\n产品规格2：1L×2瓶\n价格：49.9元"), ["500ml×2瓶", "1L×2瓶"]);
  assert.deepEqual(parseQuickProductInput("产品：洗衣液，SKU1：A-1，SKU2：A-2，价格：49.9元").skus, ["A-1", "A-2"]);
  const batch = parseBatchProductInputs("产品：洗衣液\nSKU：A-1；A-2\n价格：49.9元\n抖音：token\n机制：拍一发一\n佣金：35%");
  assert.deepEqual(batch[0]?.skus, ["A-1", "A-2"]);
});

test("pairs fuzzy SKU/specification input with multiple prices", () => {
  assert.deepEqual(extractSkuEntries("SKU1：白色款，价格1：39.9元，SKU2：黑色款，价格2：49.9元"), [
    { value: "白色款", price: 39.9 },
    { value: "黑色款", price: 49.9 },
  ]);
  assert.deepEqual(extractSkuEntries("规格：500ml 29.9元；1L 39.9元"), [
    { value: "500ml", price: 29.9 },
    { value: "1L", price: 39.9 },
  ]);
  assert.deepEqual(extractSkuEntries("SKU1 白色款 售价1 39.9元 SKU2 黑色款 售价2 49.9元"), [
    { value: "白色款", price: 39.9 },
    { value: "黑色款", price: 49.9 },
  ]);
  assert.deepEqual(extractSkuEntries("SKU：A-1；A-2\n多价格：39.9元；49.9元"), [
    { value: "A-1", price: 39.9 },
    { value: "A-2", price: 49.9 },
  ]);
  const parsed = parseQuickProductInput("产品：保温杯\n多规格：白色 39.9元；黑色 49.9元\n抖音：token\n机制：拍一发一\n佣金：35%");
  assert.deepEqual(parsed.skuEntries, [
    { value: "白色", price: 39.9 },
    { value: "黑色", price: 49.9 },
  ]);
  assert.equal(parsed.price, 39.9);
});

test("extracts product names from common link questions", () => {
  assert.equal(extractQueryName("晴雨伞的链接是什么？"), "晴雨伞");
  assert.equal(extractQueryName("帮我找一下晴雨伞的视频号链接"), "晴雨伞");
  assert.equal(extractQueryName("我要晴雨伞链接"), "晴雨伞");
});

test("extracts full-product edit requests without intercepting single-field updates", () => {
  assert.equal(extractEditQuery("我要修改胶原蛋白产品"), "胶原蛋白");
  assert.equal(extractEditQuery("编辑晴雨伞的全部资料"), "晴雨伞");
  assert.equal(extractEditQuery("请帮我更新自然堂面膜信息！"), "自然堂面膜");
  assert.equal(extractEditQuery("给胶原蛋白产品更改信息"), "胶原蛋白");
  assert.equal(extractEditQuery("把自然堂面膜的信息调整一下"), "自然堂面膜");
  assert.equal(extractEditQuery("修改晴雨伞佣金为35%"), "");
});

test("fuzzy search tolerates abbreviations, omissions and a typo", () => {
  const products = [
    { name: "自然堂雪域精粹面膜", aliases: ["自然堂面膜"], manufacturer: "自然堂" },
    { name: "清风晴雨两用伞", aliases: ["晴雨伞"], manufacturer: "清风工厂" },
  ];
  assert.equal(fuzzyFind(products, "自然堂面膜")[0]?.product.name, "自然堂雪域精粹面膜");
  assert.equal(fuzzyFind(products, "清风雨伞")[0]?.product.name, "清风晴雨两用伞");
  assert.equal(fuzzyFind(products, "晴雨两用伞")[0]?.product.name, "清风晴雨两用伞");
});

test("quick paste recognizes multiline supplier material without https links", () => {
  const parsed = parseQuickProductInput(`产品：小熊洗衣液\n厂家：小熊工厂\n价格：49.9元\n抖音：7@8.com:/abc123\n视频号：wxchannels://product/888\n机制：39.9元两瓶，拍一发二\n佣金：35%`);
  assert.equal(parsed.name, "小熊洗衣液");
  assert.equal(parsed.manufacturer, "小熊工厂");
  assert.equal(parsed.price, 49.9);
  assert.deepEqual(parsed.packages, []);
  assert.equal(parsed.mechanism, "39.9元两瓶，拍一发二");
  assert.equal(parsed.commission, 35);
  assert.equal(parsed.productStatus, "正常推广");
  assert.deepEqual(parsed.links, [
    { platform: "抖音", value: "7@8.com:/abc123" },
    { platform: "视频号", value: "wxchannels://product/888" },
  ]);
});

test("quick paste recognizes fuzzy field labels and keeps their values separate", () => {
  const parsed = parseQuickProductInput("新增商品：小熊洗衣液，商品价格：49.9元，抖音链接：token-88，活动机制：拍一发二，产品佣金：35%，商品状态：暂停推广");
  assert.equal(parsed.name, "小熊洗衣液");
  assert.equal(parsed.price, 49.9);
  assert.equal(parsed.mechanism, "拍一发二");
  assert.equal(parsed.commission, 35);
  assert.equal(parsed.productStatus, "暂停推广");
  assert.deepEqual(parsed.links, [{ platform: "抖音", value: "token-88" }]);
});

test("quick paste semantically recognizes every supported text field", () => {
  const parsed = parseQuickProductInput("这个商品叫小熊洗衣液，来自小熊工厂，单盒只要49.9元，2盒69.9元，3盒99元，抖音口令是 token-88，买一送一，主播提成35个点，暂时不推");
  assert.equal(parsed.name, "小熊洗衣液");
  assert.equal(parsed.manufacturer, "小熊工厂");
  assert.equal(parsed.price, 49.9);
  assert.deepEqual(parsed.packages, [
    { name: "2盒", price: 69.9, description: "" },
    { name: "3盒", price: 99, description: "" },
  ]);
  assert.deepEqual(parsed.links, [{ platform: "抖音", value: "token-88" }]);
  assert.equal(parsed.mechanism, "买一送一");
  assert.equal(parsed.commission, 35);
  assert.equal(parsed.productStatus, "暂停推广");
});

test("quick paste also separates semantic fields without punctuation", () => {
  const parsed = parseQuickProductInput("新增产品 小熊洗衣液 厂家 小熊工厂 单盒49.9元 抖音口令 token-88 买一送一 佣金35% 暂时不推");
  assert.equal(parsed.name, "小熊洗衣液");
  assert.equal(parsed.manufacturer, "小熊工厂");
  assert.equal(parsed.price, 49.9);
  assert.deepEqual(parsed.links, [{ platform: "抖音", value: "token-88" }]);
  assert.equal(parsed.mechanism, "买一送一");
  assert.equal(parsed.commission, 35);
  assert.equal(parsed.productStatus, "暂停推广");
});

test("recognizes link-label and status concepts", () => {
  assert.deepEqual(extractLinkEntries("视频号商品卡为 wxchannels://product/88，产品佣金35%"), [
    { platform: "视频号", value: "wxchannels://product/88" },
  ]);
  assert.deepEqual(extractLinkEntries("橱窗链接：v.douyin.com/abc，提成32%"), [
    { platform: "抖音", value: "v.douyin.com/abc" },
  ]);
  assert.equal(extractProductStatus("这款已经下架了"), "已下架");
  assert.equal(extractProductStatus("商品暂时不推"), "暂停推广");
  assert.equal(extractProductStatus("现在恢复推广"), "正常推广");
});

test("recognizes mechanism descriptions and unlabeled promotion concepts", () => {
  assert.equal(extractMechanism("特殊机制中包含：买一送一，加赠随行杯\n产品佣金：35%"), "买一送一，加赠随行杯");
  assert.equal(extractMechanism("这款有机制：拍一发二\n佣金：32%"), "拍一发二");
  assert.equal(extractMechanism("产品：抽纸\n买一送一，前100名加赠收纳盒\n佣金：31%"), "买一送一；前100名加赠收纳盒");
  assert.equal(extractMechanism("产品：买一送一洗衣液\n佣金：35%"), "");
});

test("quick paste applies conceptual mechanism recognition", () => {
  const parsed = parseQuickProductInput("产品：坚果礼盒\n价格：99元\n抖音：token-99\n特殊机制中包含：买一送一，加赠杯子\n产品佣金：35%");
  assert.equal(parsed.mechanism, "买一送一，加赠杯子");
});

test("quick paste recognizes an optional promotion status", () => {
  assert.equal(parseQuickProductInput("产品：面膜\n推广状态：暂停推广").productStatus, "暂停推广");
  assert.equal(parseQuickProductInput("产品：面膜\n产品状态：已下架").productStatus, "已下架");
});

test("parses multi-field and contextual conversational edits", () => {
  assert.deepEqual(parseConversationalProductEdit("把胶原蛋白的抖音佣金改成35%，机制改为拍一发二，状态设为正常推广"), {
    query: "胶原蛋白",
    platform: "抖音",
    commission: 35,
    mechanism: "拍一发二",
    productStatus: "正常推广",
    price: undefined,
    fieldCount: 3,
  });
  assert.deepEqual(parseConversationalProductEdit("视频号佣金改成32%"), {
    query: "",
    platform: "视频号",
    commission: 32,
    price: undefined,
    mechanism: undefined,
    productStatus: undefined,
    fieldCount: 1,
  });
  assert.deepEqual(parseConversationalProductEdit("把胶原蛋白的产品佣金改成36%，活动机制改为拍二发三"), {
    query: "胶原蛋白",
    platform: undefined,
    commission: 36,
    mechanism: "拍二发三",
    price: undefined,
    productStatus: undefined,
    fieldCount: 2,
  });
  assert.deepEqual(parseConversationalProductEdit("给胶原蛋白产品更改信息，佣金改成38%"), {
    query: "胶原蛋白",
    platform: undefined,
    commission: 38,
    price: undefined,
    mechanism: undefined,
    productStatus: undefined,
    fieldCount: 1,
  });
});

test("quick and batch paste keep package lists with their product", () => {
  const parsed = parseBatchProductInputs(`产品：胶原蛋白\n单品价：39.9元\n套餐：2盒69.9元；3盒99元\n抖音：token-1\n机制：拍一发一\n佣金：35%\n\n产品：洗衣液\n单品价：49.9元\n视频号：token-2\n机制：两瓶装\n佣金：32%`);
  assert.deepEqual(parsed[0].packages, [
    { name: "2盒", price: 69.9, description: "" },
    { name: "3盒", price: 99, description: "" },
  ]);
  assert.deepEqual(parsed[1].packages, []);
});

test("batch paste separates repeated product blocks without requiring a table", () => {
  const parsed = parseBatchProductInputs(`产品：胶原蛋白\n价格：99元\n抖音：douyin-token-1\n机制：拍一发三\n佣金：35%\n\n产品：洗衣液\n价格：49.9元\n视频号：wxchannels://item/2\n机制：两瓶装\n佣金：32%`);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "胶原蛋白");
  assert.equal(parsed[1].name, "洗衣液");
  assert.equal(parsed[1].links[0]?.platform, "视频号");
});

test("detects exact duplicate products and links while allowing self edits", () => {
  const products = [
    { id: "p1", name: "自然堂官方旗舰店 面膜", manufacturer: "自然堂", links: [{ platform: "抖音", url: "douyin-token-1" }] },
    { id: "p2", name: "清风晴雨两用伞", manufacturer: "清风", links: [{ platform: "视频号", url: "wx-token-2" }] },
  ];
  const duplicate = detectProductDuplicates(products, {
    name: "自然堂面膜",
    links: [{ url: "wx-token-2" }, { url: "wx-token-2" }],
  });
  assert.equal(duplicate.exactNameProduct?.id, "p1");
  assert.equal(duplicate.urlMatches[0]?.product.id, "p2");
  assert.deepEqual(duplicate.duplicateUrls, ["wx-token-2"]);

  const editing = detectProductDuplicates(products, {
    name: "清风晴雨两用伞",
    links: [{ url: "wx-token-2" }],
  }, "p2");
  assert.equal(editing.exactNameProduct, undefined);
  assert.equal(editing.urlMatches.length, 0);
});

test("detects a duplicate inside creator-specific platform links", () => {
  const products = [
    { id: "p1", name: "产品一", links: [{ platform: "抖音", url: "", creatorLinks: [{ url: "creator-token-1" }] }] },
  ];
  const duplicate = detectProductDuplicates(products, { name: "产品二", links: [{ url: "creator-token-1" }] });
  assert.equal(duplicate.urlMatches[0]?.product.id, "p1");
  assert.equal(duplicate.urlMatches[0]?.matchedUrl, "creator-token-1");
});

test("similar product names are reminders rather than exact duplicates", () => {
  const products = [
    { id: "p1", name: "清风晴雨两用伞", links: [{ url: "a" }] },
  ];
  const result = detectProductDuplicates(products, { name: "清风晴雨伞", links: [{ url: "b" }] });
  assert.equal(result.exactNameProduct, undefined);
  assert.equal(result.similarProducts[0]?.product.id, "p1");
});
