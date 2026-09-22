#!/usr/bin/env node
/**
 * manifest.json 校验器：镜像宿主安装期的校验规则，让插件作者在
 * 本地/CI 提前发现问题。规则真源在宿主
 * desktop-cc-gui/packages/plugin-sdk/src/index.ts（KNOWN_PERMISSIONS /
 * isKnownPermission / satisfiesSdkRange），宿主升级白名单时此处需同步。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** 宿主已知的基座权限（15 项；未知权限 = 安装拒绝）。 */
const KNOWN_PERMISSIONS = new Set([
  "storage",
  "ui:settings-section",
  "ui:add-menu",
  "ui:composer",
  "ui:panel-tab",
  "ui:status-bar",
  "ui:command",
  "ui:markdown",
  "ui:page",
  "ui:timeline-row",
  "ui:session-menu",
  "ui:sidebar-entry",
  "ui:center-tab",
  "agent",
  "theme",
  "i18n",
  "events",
  "network:none",
  "composer:draft",
]);

/** network: 授权体：<host>（任意端口）/ <host>:<port> / <host>:<a>-<b>（含端点）。 */
const NETWORK_GRANT_RE = /^([A-Za-z0-9.-]+)(?::(\d+)(?:-(\d+))?)?$/;

/** exec: 授权的二进制名：裸名，禁路径分隔符。 */
const EXEC_BIN_RE = /^[A-Za-z0-9._-]+$/;

/** 镜像宿主 isKnownPermission：基座 15 项，或形状合法的 network:/exec: 授权。 */
function isKnownPermission(p) {
  if (KNOWN_PERMISSIONS.has(p)) return true;
  if (p.startsWith("network:")) {
    const m = NETWORK_GRANT_RE.exec(p.slice("network:".length));
    if (!m) return false;
    if (m[2] === undefined) return true;
    const from = Number(m[2]);
    const to = m[3] === undefined ? from : Number(m[3]);
    return from >= 1 && to <= 65535 && from <= to;
  }
  if (p.startsWith("exec:")) return EXEC_BIN_RE.test(p.slice("exec:".length));
  return false;
}

const TIERS = new Set(["declarative", "js"]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "manifest.json");

/** @returns {string[]} 问题列表；空数组 = 合法。 */
function validate(manifest) {
  const problems = [];
  if (typeof manifest.id !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.id)) {
    problems.push(`id "${manifest.id}" 不合法：需匹配 ^[a-z0-9][a-z0-9-]{1,63}$（小写字母/数字/连字符，2~64 字符）`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    problems.push("name 不能为空");
  }
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    problems.push(`version "${manifest.version}" 不合法：需为 semver 三段数字（如 1.2.0）`);
  }
  if (!TIERS.has(manifest.tier)) {
    problems.push(`tier "${manifest.tier}" 不合法：只能是 "declarative"（Tier-0 零 JS）或 "js"`);
  }
  if (manifest.minAppVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion)) {
    problems.push(`minAppVersion "${manifest.minAppVersion}" 不合法：需为 semver 三段数字`);
  }
  if (manifest.sdkVersion !== undefined) {
    // 与宿主 satisfiesSdkRange 支持的写法一致："*" / 精确三段 / ^ / ~ / >=
    if (!/^(\^|~|>=)?\d+\.\d+(\.\d+)?$|^\*$/.test(manifest.sdkVersion)) {
      problems.push(`sdkVersion "${manifest.sdkVersion}" 不合法：支持 "*"、精确三段、"^x.y(.z)"、"~x.y.z"、">=x.y.z"`);
    }
  }
  const permissions = manifest.permissions ?? [];
  if (!Array.isArray(permissions)) {
    problems.push("permissions 必须是字符串数组");
  } else {
    for (const p of permissions) {
      if (typeof p !== "string") {
        problems.push(`permission ${JSON.stringify(p)} 不是字符串`);
      } else if (!isKnownPermission(p)) {
        problems.push(`未知权限 "${p}"（已知权限见 README《SDK API 全表》；network:/exec: 授权语法：network:<host>[:<port>|<a>-<b>]、exec:<bin>）`);
      }
    }
  }
  return problems;
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.error(`✗ 无法读取/解析 manifest.json：${err.message}`);
  process.exit(1);
}

const problems = validate(manifest);
if (problems.length) {
  console.error(`✗ manifest.json 校验未通过（${problems.length} 项）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ manifest.json 校验通过：${manifest.id}@${manifest.version}（${manifest.tier}，${(manifest.permissions ?? []).length} 项权限）`);
