import type { PluginContext } from "./ccgui-plugin";

/**
 * 模块级宿主 ctx 持有（与官方 prompt-shield / usage-stats 同款模式）：
 * activate 时注入，卸载 disposer 里清空。所有 bridge/storage 封装从这里取。
 */
let hostCtx: PluginContext | null = null;

export function setHostCtx(ctx: PluginContext | null): void {
  hostCtx = ctx;
}

export function getHostCtx(): PluginContext {
  if (!hostCtx) throw new Error("service-status: host context not set（插件未激活）");
  return hostCtx;
}

export interface HttpResponse {
  status: number;
  body: string;
}

/**
 * `plugin_http_request`：url 限 http/https，host(+端口) 必须命中 manifest 的
 * `network:<host>` 授权。宿主侧请求超时为 30s（connect 10s），逐请求的软超时
 * 由 withTimeout 在 JS 侧施加——超时后宿主请求仍在后台跑完，只是结果不再使用。
 */
export function httpGet(url: string): Promise<HttpResponse> {
  return getHostCtx().bridge.invoke("plugin_http_request", {
    method: "GET",
    url,
    headers: { Accept: "application/json, text/plain, */*" },
    body: null,
  });
}

/** `plugin_exec_spawn`：bin 必须命中 `exec:<bin>` 授权；detached = 放生子进程。 */
function spawnDetached(bin: string, args: string[]): Promise<void> {
  return getHostCtx().bridge.invoke("plugin_exec_spawn", {
    bin,
    args,
    env: null,
    lifecycle: "detached",
  });
}

/** 逐请求软超时：宿主桥没有 AbortSignal，只能竞速丢弃晚到的结果。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type PlatformKind = "mac" | "win" | "linux";

export function platformKind(): PlatformKind {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/macintosh|mac os x/i.test(ua)) return "mac";
  if (/windows/i.test(ua)) return "win";
  return "linux";
}

/**
 * 在系统浏览器中打开状态页。
 *
 * 插件拿不到宿主的 `openExternal`（@tauri-apps/api 不对插件开放），因此经
 * `exec:` 授权调用各平台的系统打开器。**只接受我们的 provider 表里的 https
 * 地址**（调用方传常量，插件从不拼接用户输入），先做协议白名单再 spawn，
 * 避免授权被当成任意命令通道使用。
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!/^https:\/\/[a-z0-9.-]+(\/|$)/i.test(url)) {
    throw new Error(`service-status: refusing to open non-https url: ${url}`);
  }
  switch (platformKind()) {
    case "mac":
      await spawnDetached("open", [url]);
      return;
    case "win":
      // `start` 的第一个引号参数是窗口标题占位符，缺它会吞掉 URL。
      await spawnDetached("cmd", ["/c", "start", "", url]);
      return;
    default:
      await spawnDetached("xdg-open", [url]);
  }
}
