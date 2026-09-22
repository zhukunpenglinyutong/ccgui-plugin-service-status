import { useState } from "react";

import { getHostCtx } from "./host";

/** 宿主语言：activate 时注入的 ctx.host.locale（宿主当前没有语言切换事件，取一次即可）。 */
export function hostLocale(): string {
  try {
    return getHostCtx().host.locale || "zh-CN";
  } catch {
    return "zh-CN";
  }
}

export function useHostLocale(): string {
  const [locale] = useState(hostLocale);
  return locale;
}
