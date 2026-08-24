import assert from "node:assert/strict";
import test from "node:test";
import { buildProductReport, staleLinkDays } from "../app/reporting.ts";

const now = new Date("2026-08-24T12:00:00.000Z");

test("stale reminder starts only after seven complete days and respects a recent check", () => {
  assert.equal(staleLinkDays({ updatedAt: "2026-08-17T12:00:00.000Z" }, now), 0);
  assert.equal(staleLinkDays({ updatedAt: "2026-08-16T11:00:00.000Z" }, now), 8);
  assert.equal(staleLinkDays({ updatedAt: "2026-08-01T12:00:00.000Z", lastCheckedAt: "2026-08-23T12:00:00.000Z" }, now), 0);
});

test("daily report includes status, stale links and low commission alerts", () => {
  const report = buildProductReport([
    { id: "p1", name: "面膜", status: "暂停推广", commission: 25, links: [{ platform: "抖音", status: "有效", updatedAt: "2026-08-10T12:00:00.000Z" }] },
    { id: "p2", name: "雨伞", status: "已下架", commission: 35, links: [{ platform: "视频号", status: "待复核", updatedAt: "2026-08-24T08:00:00.000Z" }] },
  ], [{ actorEmail: "admin@example.com", action: "update", productName: "面膜", summary: "将产品状态从正常推广改为暂停推广", createdAt: "2026-08-24T09:00:00.000Z" }], "daily", now);
  assert.match(report.text, /暂停推广1款，已下架1款/);
  assert.match(report.text, /超7天未更新1条/);
  assert.match(report.text, /低于30%佣金1款/);
  assert.match(report.text, /面膜（最长 14 天）/);
});
