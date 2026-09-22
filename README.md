# 服务状态（CC GUI 插件）

在 CC GUI 中心页签里聚合各 AI 提供商**官方状态页**的实时事故状态：Claude、
OpenAI / Codex、Cursor、GitHub / Copilot、Gemini、Kimi / Moonshot、MiniMax、Zed。
每分钟自动刷新，也可手动刷新。

> 当你用的引擎突然「变慢 / 报错 / 数据变红」时，先看一眼这里——是厂商自己在出事故，
> 还是本机的问题。

## 来源与许可（请先读这一段）

本插件是 **[TokenTracker](https://github.com/xiufengsun/tokentracker)（MIT）** 中
「服务状态」页面的 **CC GUI 插件移植版**，不是 TokenTracker 官方出品，也与
TokenTracker 作者无隶属关系。

- 参考的是 TokenTracker **0.99.0**（commit `a726cd540607516a05b2f705e33a57751e845fb6`）
  的 `dashboard/src/pages/ServiceStatusPage.jsx` 与 `src/lib/provider-status.js`：
  提供商清单、三种探针（Statuspage.io / Instatus / Google incidents feed）、
  解析与严重度排序规则、8s 探针超时、60s 刷新间隔、状态文案。
- 上游采用 **MIT 许可证**（Copyright © 2026 xiufengsun）。按 MIT 要求，上游版权声明
  与许可证全文已完整收录在 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)，
  本仓库 `LICENSE` 中也指向该文件。
- 本插件自身的许可同样是 MIT（Copyright © 2026 zhukunpenglinyutong）。
- 与上游的**有意差异**只在传输层与展示层：网络请求改走宿主白名单代理
  `plugin_http_request`；卡片改为按钮 + 系统打开器；不复制厂商 logo（用首字母色块）。
  逐条对照见 `THIRD_PARTY_NOTICES.md`。
- 各厂商名称与商标（Claude、OpenAI、Cursor、GitHub、Gemini、Kimi/Moonshot、
  MiniMax、Zed）归各自所有者，这里只用于标识被监测的服务。

如果 TokenTracker 作者对移植方式有异议，欢迎开 issue，我们会调整或下架。

## 功能

- 中心页签一屏展示 8 家提供商的状态：每张卡片显示状态点、状态文案
  （运行正常 / 轻微事故 / 重大事故 / 严重故障 / 无法访问）与事故描述。
- 点击卡片用系统默认浏览器打开该家的官方状态页。
- 每分钟自动刷新；页头「刷新」按钮可立即重探（转圈 → 对号反馈），并显示上次检查时间。
- 探针失败（超时 / 网络不通 / 载荷异常）一律显示「无法访问」，不会冒充任何一种事故等级，
  也不会影响其它卡片。
- 简体中文 / English 文案跟随宿主语言。

## 权限与网络

`manifest.json` 只声明实际使用的权限：

| 权限 | 用途 |
|---|---|
| `ui:center-tab` | 注册中心页签（页面本体） |
| `ui:sidebar-entry` | 首页侧栏入口 |
| `ui:command` | 命令面板「打开服务状态」 |
| `exec:open` / `exec:xdg-open` / `exec:cmd` | 点击卡片时调用系统打开器（macOS / Linux / Windows） |
| `network:status.claude.com`、`network:status.openai.com`、`network:status.cursor.com`、`network:www.githubstatus.com`、`network:www.google.com`、`network:status.moonshot.cn`、`network:status.minimaxi.com`、`network:status.zed.dev` | 只读拉取各厂商公开状态页 JSON |

关于 `exec:` 的三条授权：插件拿不到宿主的「打开外链」能力，只能用系统打开器
（`open` / `xdg-open` / `cmd /c start`）。代码里 URL 只来自 `src/providers.ts` 的常量表
（非 https 直接拒绝，插件从不拼接用户输入），不存在把它当命令通道使用的路径。

## 数据去向与隐私

- 出网只有一类请求：`GET` 上述 8 家的公开状态页 JSON，**不带任何参数、cookie 或请求体**。
- 不读取、不上传会话内容、文件路径、API key 或用量数据；插件不需要 `storage` 权限，本地不落任何数据。
- 不加载任何远程图片 / 脚本；样式与图标全部内置。

## 安装

- **市场**：CC GUI → 插件 → 市场 → 搜索「服务状态」。
- **本地目录**：CC GUI → 插件 → **从本地目录安装**，选择本仓库根目录
  （`manifest.json` / `main.js` / `styles.css` 同级，Obsidian 式布局）。
  首次需先 `pnpm install && pnpm build` 生成 `main.js` 与 `styles.css`。

## 开发

```bash
pnpm install
pnpm validate   # 校验 manifest.json（镜像宿主安装期规则）
pnpm test       # 探针解析 / 探针失败 / 页面渲染回归
pnpm typecheck
pnpm build      # 产出仓库根的 main.js + styles.css
```

代码结构：

| 文件 | 职责 |
|---|---|
| `src/providers.ts` | 提供商表 + 三种探针的解析与严重度排序（纯函数，可单测） |
| `src/host.ts` | 宿主 ctx 持有、`plugin_http_request` / `plugin_exec_spawn` 封装、非 https 拒绝 |
| `src/StatusPage.tsx` | 页面 UI（卡片、状态点、刷新反馈） |
| `src/copy.ts` | zh-CN / en 文案 |
| `src/main.tsx` | `activate`：注册中心页签、侧栏入口、命令 |

## 发版

1. `manifest.json` 的 `version` +1（semver）。
2. `git tag <version> && git push origin <version>`（tag 必须等于 version，无 `v` 前缀）。
3. `.github/workflows/release.yml` 会校验 manifest、比对 tag、构建三件套并附加到 Release。

## 已知限制

- 只覆盖 TokenTracker 选定的 8 家：Grok / DeepSeek 的状态页有 bot 校验（接口返回 403 / HTML），
  z.ai / Kiro / Qoder / OpenCode 没有公开状态 API，因此不在表内。这不是通用状态聚合器，
  而是回答「我用的这家是不是在出事故」。
- 状态来自厂商公开 API，本身有几分钟延迟；插件不做本地缓存，每次都重新探测。
- 卡片打开浏览器依赖系统打开器；若被权限拒绝，卡片下方会给出提示（权限清单可在插件页查看）。
- 极少数网络环境下某些状态页不可达（例如国内访问 Google），此时显示「无法访问」而非猜测。

## License

MIT（见 [`LICENSE`](./LICENSE)）。移植自 TokenTracker 的部分另见
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

---

## English summary

A CC GUI plugin that shows live incident state from the official status pages of
Claude, OpenAI/Codex, Cursor, GitHub/Copilot, Gemini, Kimi/Moonshot, MiniMax and
Zed in a center tab, refreshing every minute.

It is a **port of TokenTracker's service-status page (MIT, © 2026 xiufengsun)**
— see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for the full upstream
notice, the exact files ported, and every deliberate difference. Not an official
TokenTracker release and not affiliated with TokenTracker or the vendors shown.
