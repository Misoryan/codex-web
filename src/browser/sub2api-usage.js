// The adapter supplies the existing profile menu components.
export function createSub2ApiUsage(React, Menu, Disclosure, UsageIcon) {
  const h = React.createElement;
  const locale =
    typeof navigator === "undefined" ? "en" : navigator.language || "en";
  const chinese = locale.toLowerCase().startsWith("zh");
  const text = {
    usage: chinese ? "用量剩余" : "Usage remaining",
    weekly: chinese ? "周额度" : "Weekly",
    todayCost: chinese ? "今日消费" : "Spent today",
    monthCost: chinese ? "本月消费" : "Spent this month",
    dailyRank: chinese ? "日排行" : "Daily Rank",
    weeklyRank: chinese ? "周排行" : "Weekly Rank",
    monthlyRank: chinese ? "月排行" : "Monthly Rank",
    noUsage: chinese ? "本期暂无用量" : "No usage this period",
    loading: chinese ? "正在加载统计…" : "Loading usage…",
    refreshFailed: chinese
      ? "刷新失败，稍后重试；已有数据继续保留"
      : "Refresh failed; keeping the last successful data",
    capacityTitle: chinese
      ? "100% = 1 个 20x 账号的完整周额度"
      : "100% = one full 20x account for the week",
  };
  const ranges = {
    today: text.dailyRank,
    week: text.weeklyRank,
    month: text.monthlyRank,
  };
  const cache = {},
    pending = {},
    failures = {};
  async function read(range) {
    if (pending[range]) return pending[range];
    pending[range] = (async () => {
      try {
        const response = await fetch(
          `/__backend/sub2api/usage?range=${range}`,
          {
            cache: "no-store",
            credentials: "same-origin",
            signal: AbortSignal.timeout(35000),
          },
        );
        if (!response.ok) throw Error("Unavailable");
        const data = await response.json();
        if (
          typeof data.enabled !== "boolean" ||
          (data.report &&
            (data.report.range !== range ||
              data.report.shareBasis !== "actual_cost"))
        )
          throw Error("Invalid response");
        cache[range] = {
          ...data,
          report: data.report || cache[range]?.report,
          capacity: data.capacity?.report
            ? data.capacity
            : cache[range]?.capacity,
        };
        failures[range] = 0;
      } catch {
        failures[range] = (failures[range] || 0) + 1;
        cache[range] = {
          ...cache[range],
          enabled: true,
          stale: true,
          activity: null,
          networkFailure: true,
          nextRefreshAt: new Date(
            Date.now() + Math.min(60000, 5000 * 2 ** Math.min(failures[range] - 1, 4)),
          ).toISOString(),
        };
      }
      return cache[range];
    })().finally(() => {
      delete pending[range];
    });
    return pending[range];
  }
  const due = (data) =>
    data?.networkFailure ? Date.parse(data.nextRefreshAt) : Math.min(
      Date.parse(data?.nextRefreshAt) || 0,
      Date.parse(data?.capacity?.nextRefreshAt || data?.nextRefreshAt) || 0,
    );
  function ActivityBadge({activity, userId}) {
    const [now, setNow] = React.useState(Date.now);
    React.useEffect(() => {
      setNow(Date.now());
      if (!activity) return;
      const timer = setTimeout(() => setNow(Date.now()), Math.max(0, Date.parse(activity.expiresAt) - Date.now()) + 10);
      return () => clearTimeout(timer);
    }, [activity]);
    const count = activity?.counts?.[userId];
    if (!Number.isSafeInteger(count) || count <= 0 || Date.parse(activity.expiresAt) <= Math.max(now,Date.now())) return null;
    const label = chinese ? `${count} 个 API 请求进行中（最近刷新时）` : `${count} API requests in progress at last refresh`;
    return h("span", {"data-sub2api-active": userId, role:"img", "aria-label":label, title:label,
      style:{display:"inline-flex",alignItems:"center",gap:3,flexShrink:0,color:"#15803d",background:"rgba(34,197,94,.12)",borderRadius:8,padding:"0 4px",fontSize:10,lineHeight:"16px",fontVariantNumeric:"tabular-nums"}},
      h("span", {"aria-hidden":true,style:{width:4,height:4,borderRadius:"50%",background:"#22c55e"}}), count);
  }
  function RankDisclosure({ open, onOpenChange, trigger, children }) {
    return h(React.Fragment, null,
      React.cloneElement(trigger, {
        onSelect(event) {
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(!open);
        },
        rightIcon: h("svg", {width:16,height:16,viewBox:"0 0 16 16",fill:"none","aria-hidden":true,style:{transform:open?"rotate(90deg)":undefined}},
          h("path", {d:"m6 4 4 4-4 4",stroke:"currentColor",strokeWidth:1.5,strokeLinecap:"round",strokeLinejoin:"round"})),
      }),
      open ? children : null,
    );
  }
  function Rank({ range, data, activity, open, onOpenChange }) {
    const report = data?.report;
    const id = React.useId();
    return h(
      RankDisclosure,
      {
        open,
        onOpenChange,
        trigger: h(
          Menu.Item,
          {
            "data-sub2api-rank": range,
            "aria-label": ranges[range],
            "aria-expanded": open,
            "aria-controls": id,
            className:
              "ps-[calc(var(--padding-row-x)+1.25rem)] pe-[var(--padding-row-x)]",
          },
          h(
            "span",
            {
              className:
                "flex w-full min-w-0 items-center justify-between gap-2",
            },
            h("span", null, ranges[range]),
            h(
              "span",
              {
                className: "whitespace-nowrap text-xs text-codex-description",
                style: { fontVariantNumeric: "tabular-nums" },
              },
              report
                ? `${report.self.share.toFixed(1)}% ${report.self.rank ? `#${report.self.rank}` : "未上榜"}`
                : "—",
            ),
          ),
        ),
      },
      h(
        "div",
        {
          id,
          "data-sub2api-ranking": range,
          style: {
            paddingLeft: 20,
            paddingTop: 4,
            paddingBottom: 4,
            maxHeight: 280,
            overflowY: "auto",
          },
        },
        ...(report?.ranking || []).map((row) =>
          h(
            Menu.Item,
            {
              key: row.userId,
              disabled: true,
              className: `opacity-100 text-xs ${row.userId === report.self.userId ? "bg-primary-ghost-hover" : ""}`,
            },
            h(
              "span",
              {
                style: {
                  display: "grid",
                  gridTemplateColumns: "18px minmax(0,1fr) auto",
                  gap: 6,
                  width: "100%",
                },
              },
              h("span", { className: "text-codex-description" }, row.rank),
              h(
                "span",
                { className: "flex min-w-0 items-center gap-1", title: row.name },
                h("span", { className: "truncate" }, `${row.name}${row.userId === report.self.userId ? (chinese ? "（我）" : " (me)") : ""}`),
                h(ActivityBadge, {activity, userId: row.userId}),
              ),
              h(
                "span",
                { className: "text-codex-description" },
                `${row.share.toFixed(1)}%`,
              ),
            ),
          ),
        ),
        report && !report.ranking.length
          ? h(
              "div",
              { className: "px-2 py-1 text-xs text-codex-description" },
              text.noUsage,
            )
          : null,
      ),
    );
  }
  return function Sub2ApiUsage() {
    const [state, setState] = React.useState(() => ({ ...cache }));
    const [open, setOpen] = React.useState(true);
    const [openRank, setOpenRank] = React.useState(null);
    const weeklyId = React.useId();
    React.useEffect(() => {
      let disposed = false;
      const timers = {}, running = new Set();
      // The menu may have closed while a shared request completed.
      setState({ ...cache });
      const refresh = async (range, online = false) => {
        clearTimeout(timers[range]);
        if (disposed || document.hidden) return;
        if (running.has(range)) return;
        running.add(range);
        if (due(cache[range]) <= Date.now() || (online && cache[range]?.networkFailure))
          await read(range);
        running.delete(range);
        if (disposed) return;
        // Publish each response immediately; a slow month must not hide today.
        setState({ ...cache });
        timers[range] = setTimeout(
          () => refresh(range),
          Math.max(cache[range]?.networkFailure ? 5000 : 60000, due(cache[range]) - Date.now()),
        );
      };
      const visibility = () => {
        if (document.hidden) Object.values(timers).forEach(clearTimeout);
        else Object.keys(ranges).forEach(range => refresh(range));
      };
      const online = () => Object.keys(ranges).forEach(range => refresh(range, true));
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener("online", online);
      Object.keys(ranges).forEach(range => refresh(range));
      return () => {
        disposed = true;
        Object.values(timers).forEach(clearTimeout);
        document.removeEventListener("visibilitychange", visibility);
        window.removeEventListener("online", online);
      };
    }, []);
    if (Object.values(state).some((data) => data.enabled === false))
      return null;
    const capacity = Object.values(state)
      .map((data) => data.capacity?.report)
      .filter(Boolean)
      .sort(
        (a, b) =>
          Date.parse(b.generatedAt || 0) - Date.parse(a.generatedAt || 0),
      )[0];
    const activity = Object.values(state).map(data => data.activity).filter(Boolean).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0];
    const reset = capacity?.nextReset;
    const resetHours = reset ? Math.max(0, Math.floor((Date.parse(reset.from) - Date.now()) / 3600000)) : 0;
    const failed = Object.values(state).some(
      (data) => data.stale || data.capacity?.stale,
    );
    return h(
      React.Fragment,
      null,
      h(
        "div",
        { "data-sub2api-usage": "menu" },
        h(
          Disclosure,
          {
            isDefaultOpen: true,
            onOpenChange: setOpen,
            trigger: h(
              Menu.Item,
              {
                LeftIcon: UsageIcon,
                "aria-expanded": open,
                "aria-controls": weeklyId,
              },
              text.usage,
            ),
          },
          h(
            "div",
            {
              id: weeklyId,
              "data-sub2api-weekly": true,
              className:
                "grid w-full items-center gap-y-1.5 grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-1 ps-[calc(var(--padding-row-x)+1.25rem)] pe-[var(--padding-row-x)] text-sm",
            },
            h("span", { className: "text-default font-medium" }, text.weekly),
            h(
              "span",
              {
                className:
                  "text-codex-description flex items-center justify-end gap-1 whitespace-nowrap",
              },
              h(
                "span",
                {
                  "data-sub2api-remaining": true,
                  title: text.capacityTitle,
                },
                capacity?.remainingPercent == null
                  ? "—"
                  : `${Math.round(capacity.remainingPercent)}%`,
              ),
              reset
                ? h("span", {
                    "data-sub2api-reset": true,
                    style: { marginLeft: 4 },
                    title: chinese
                      ? `${new Date(reset.from).toLocaleString("zh-CN")} 起 ${reset.count} 个账号陆续重置`
                      : `${new Date(reset.from).toLocaleString()}; ${reset.count} accounts reset`,
                  }, resetHours < 24 ? `${resetHours}h` : `${Math.floor(resetHours / 24)}d${resetHours % 24}h`)
                : null,
            ),
            ...["today", "month"].flatMap((range) => {
              const report = state[range]?.report;
              const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
              const current = range === "today" ? report?.startDate === date : report?.startDate === date.slice(0, 7) + "-01";
              const cost = report?.self.actualCost;
              return [
                h("span", { key: range + "-label", className: "text-default font-medium" }, range === "today" ? text.todayCost : text.monthCost),
                h("span", {
                  key: range + "-cost",
                  "data-sub2api-cost": range,
                  className: "text-codex-description text-end whitespace-nowrap",
                  style: { fontVariantNumeric: "tabular-nums" },
                  title: chinese ? "当前账户实际消费 · USD · UTC+8" : "Current account actual cost · USD · UTC+8",
                }, current && typeof cost === "number" && Number.isFinite(cost) && cost >= 0
                  ? new Intl.NumberFormat(chinese ? "zh-CN" : "en-US", { style: "currency", currency: "USD", currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cost)
                  : "—"),
              ];
            }),
          ),
        ),
        ...Object.keys(ranges).map((range) =>
          h(Rank, { key: range, range, data: state[range], activity, open: openRank === range, onOpenChange: (next) => setOpenRank(next ? range : null) }),
        ),
        Object.keys(ranges).some(range => !state[range])
          ? h("div", { role: "status", className: "px-row-x py-1 text-xs text-codex-description" }, text.loading)
          : null,
        failed
          ? h(
              "div",
              {
                role: "status",
                className: "px-row-x py-1 text-xs text-codex-description",
              },
              text.refreshFailed,
            )
          : null,
      ),
      h(Menu.Separator),
    );
  };
}
