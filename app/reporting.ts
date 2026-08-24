export type ProductStatus = "正常推广" | "暂停推广" | "已下架";
export type ReportPeriod = "daily" | "weekly";

export const PRODUCT_STATUSES: ProductStatus[] = ["正常推广", "暂停推广", "已下架"];

export type ReportLink = {
  platform: string;
  commission: number;
  status: string;
  updatedAt: string;
  lastCheckedAt?: string;
};

export type ReportProduct = {
  id: string;
  name: string;
  status: ProductStatus;
  links: ReportLink[];
};

export type ReportActivity = {
  actorEmail: string;
  action: string;
  productName?: string;
  summary: string;
  createdAt: string;
};

export type ProductReport = {
  period: ReportPeriod;
  title: string;
  rangeLabel: string;
  text: string;
  metrics: Array<{ label: string; value: number; tone?: "normal" | "warning" | "danger" }>;
  changes: string[];
  alerts: string[];
  platformBreakdown: string[];
  teamBreakdown: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function validTime(value?: string) {
  const time = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

/** Link freshness is refreshed by either an actual link/commission update or a link check. */
export function staleLinkDays(link: Pick<ReportLink, "updatedAt" | "lastCheckedAt">, now = new Date()) {
  const freshness = Math.max(validTime(link.updatedAt), validTime(link.lastCheckedAt));
  if (!freshness) return 0;
  const days = Math.floor((now.getTime() - freshness) / DAY_MS);
  return days > 7 ? days : 0;
}

function periodStart(period: ReportPeriod, now: Date) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "weekly") {
    const day = start.getDay() || 7;
    start.setDate(start.getDate() - day + 1);
  }
  return start;
}

function shortDate(value: Date) {
  return value.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function countBy<T>(items: T[], keyOf: (item: T) => string) {
  const counts = new Map<string, number>();
  items.forEach((item) => {
    const key = keyOf(item) || "其他";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

export function buildProductReport(products: ReportProduct[], activity: ReportActivity[], period: ReportPeriod, now = new Date()): ProductReport {
  const start = periodStart(period, now);
  const recentActivity = activity.filter((item) => validTime(item.createdAt) >= start.getTime());
  const normal = products.filter((item) => item.status === "正常推广").length;
  const paused = products.filter((item) => item.status === "暂停推广").length;
  const offline = products.filter((item) => item.status === "已下架").length;
  const allLinks = products.flatMap((product) => product.links.map((link) => ({ product, link })));
  const problemLinks = allLinks.filter(({ link }) => link.status !== "有效");
  const staleLinks = allLinks.map((item) => ({ ...item, days: staleLinkDays(item.link, now) })).filter((item) => item.days > 7);
  const staleProducts = [...new Set(staleLinks.map((item) => item.product.id))].length;
  const lowCommissionProducts = [...new Set(allLinks.filter(({ link }) => Number.isFinite(link.commission) && link.commission < 30).map(({ product }) => product.id))].length;
  const actions = (name: string) => recentActivity.filter((item) => item.action === name).length;
  const changes = recentActivity.slice(0, 8).map((item) => `${item.productName || "团队资料"}：${item.summary}`);

  const staleNames = [...new Map(staleLinks.sort((left, right) => right.days - left.days).map((item) => [item.product.id, `${item.product.name}（最长 ${item.days} 天）`])).values()];
  const pausedNames = products.filter((item) => item.status === "暂停推广").map((item) => item.name);
  const offlineNames = products.filter((item) => item.status === "已下架").map((item) => item.name);
  const problemNames = [...new Set(problemLinks.map(({ product }) => product.name))];
  const alerts = [
    ...(staleNames.length ? [`超7天未更新：${staleNames.slice(0, 8).join("、")}${staleNames.length > 8 ? ` 等${staleNames.length}款` : ""}`] : []),
    ...(pausedNames.length ? [`暂停推广：${pausedNames.slice(0, 8).join("、")}${pausedNames.length > 8 ? ` 等${pausedNames.length}款` : ""}`] : []),
    ...(offlineNames.length ? [`已下架：${offlineNames.slice(0, 8).join("、")}${offlineNames.length > 8 ? ` 等${offlineNames.length}款` : ""}`] : []),
    ...(problemNames.length ? [`链接待处理：${problemNames.slice(0, 8).join("、")}${problemNames.length > 8 ? ` 等${problemNames.length}款` : ""}`] : []),
  ];

  const platformBreakdown = countBy(allLinks, ({ link }) => link.platform).map(([name, count]) => `${name} ${count}条`);
  const teamBreakdown = countBy(recentActivity, (item) => item.actorEmail).map(([name, count]) => `${name} ${count}次`);
  const rangeLabel = period === "daily" ? shortDate(now) : `${shortDate(start)}—${shortDate(now)}`;
  const title = `${period === "daily" ? "产品日报" : "产品周报"}｜${rangeLabel}`;
  const lines = [
    `【${title}】`,
    `产品概况：共${products.length}款，正常推广${normal}款，暂停推广${paused}款，已下架${offline}款。`,
    `本期变动：新增${actions("create")}款，更新${actions("update")}次，删除${actions("delete")}款，恢复${actions("restore")}款，共${recentActivity.length}次操作。`,
    `链接健康：共${allLinks.length}条，待复核/失效${problemLinks.length}条，超7天未更新${staleLinks.length}条（${staleProducts}款产品），低于30%佣金${lowCommissionProducts}款。`,
    ...(alerts.length ? ["重点提醒：", ...alerts.map((item) => `- ${item}`)] : ["重点提醒：暂无异常。"]),
    ...(changes.length ? ["最近变动：", ...changes.map((item) => `- ${item}`)] : ["最近变动：本期暂无操作。"]),
    ...(period === "weekly" ? [
      `平台分布：${platformBreakdown.join("、") || "暂无平台链接"}。`,
      `团队操作：${teamBreakdown.join("、") || "本周暂无操作"}。`,
    ] : []),
  ];

  return {
    period,
    title,
    rangeLabel,
    text: lines.join("\n"),
    metrics: [
      { label: "全部产品", value: products.length },
      { label: "正常推广", value: normal, tone: "normal" },
      { label: "暂停推广", value: paused, tone: "warning" },
      { label: "已下架", value: offline, tone: "danger" },
      { label: "超7天未更新", value: staleProducts, tone: staleProducts ? "warning" : "normal" },
      { label: "待复核/失效链接", value: problemLinks.length, tone: problemLinks.length ? "danger" : "normal" },
      { label: "低佣金产品", value: lowCommissionProducts, tone: lowCommissionProducts ? "warning" : "normal" },
      { label: "本期操作", value: recentActivity.length },
    ],
    changes,
    alerts,
    platformBreakdown,
    teamBreakdown,
  };
}
