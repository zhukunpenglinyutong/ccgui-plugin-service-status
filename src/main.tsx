import "./styles.css";

import { createRoot } from "react-dom/client";

import type { PluginActivate, PluginContext } from "./ccgui-plugin";
import { copy } from "./copy";
import { setHostCtx } from "./host";
import StatusPage from "./StatusPage";

/** 中心页签 / 侧栏入口图标（服务状态：脉冲线）。宿主用 ctx.react 渲染它。 */
function makeIcon(h: PluginContext["react"]) {
  return function StatusIcon({ className }: { className?: string }) {
    return h.createElement(
      "svg",
      {
        className,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
      },
      h.createElement("path", { d: "M3 12h3l2.5-6 4 12 2.5-6h6" }),
    );
  };
}

/**
 * 插件入口（ADR-5）。双段挂载：宿主 React 树只渲染容器，页面内容用插件自带
 * React 的 createRoot 挂进容器（两份 React 永不在同一棵树交错）。
 */
const activate: PluginActivate = (ctx) => {
  setHostCtx(ctx);
  const h = ctx.react;
  const locale = ctx.host.locale;
  const t = copy(locale);
  const Icon = makeIcon(h);

  function PageContainer() {
    const ref = h.useRef<HTMLDivElement | null>(null);
    h.useEffect(() => {
      if (!ref.current) return undefined;
      const root = createRoot(ref.current);
      root.render(<StatusPage />);
      return () => root.unmount();
    }, []);
    return h.createElement("div", { ref, className: "ss-mount" });
  }

  ctx.ui.registerCenterTab({
    key: "status",
    title: () => t.title,
    icon: Icon,
    component: PageContainer,
  });

  ctx.ui.registerSidebarNav({
    key: "status",
    label: () => t.title,
    icon: Icon,
    order: 20,
    onOpen: () => ctx.ui.openCenterTab("status"),
  });

  ctx.ui.registerCommand({
    key: "status.open",
    title: () => t.commandTitle,
    keywords: () => t.commandKeywords,
    run: () => ctx.ui.openCenterTab("status"),
  });

  // 各注册项的清理由宿主 disposer 栈兜底；这里只需松开模块级 ctx。
  return () => setHostCtx(null);
};

export default activate;
