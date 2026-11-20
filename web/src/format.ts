import type { DecisionRecord, RecordedAccount, Settings } from "./api";

const zone = "Asia/Shanghai";
const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: zone, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayClock = new Intl.DateTimeFormat("zh-CN", { timeZone: zone, hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const shortClock = new Intl.DateTimeFormat("zh-CN", { timeZone: zone, hour12: false, hour: "2-digit", minute: "2-digit" });

export const formatClock = (value: string | number) => clock.format(new Date(value));
export const formatDayClock = (value: string | number) => dayClock.format(new Date(value));
export const formatShortClock = (value: string | number) => shortClock.format(new Date(value));
export const formatRate = (rate: number) => `${(rate * 100).toFixed(1)}%`;
export const formatCount = (value: number) => value.toLocaleString("zh-CN");
export const formatHours = (minutes: number) => String(Math.round((minutes / 60) * 10) / 10);

export function rateOf(errors: number, successes: number) {
  const total = errors + successes;
  return total === 0 ? 0 : errors / total;
}

export function relativeTime(value: string | null, now: number) {
  if (!value) return "从未";
  const minutes = Math.round((now - Date.parse(value)) / 60000);
  if (minutes <= 0) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export const eventLabels: Record<DecisionRecord["event"], string> = {
  decrease: "降容量",
  increase: "升容量",
  restore_priority: "恢复优先级",
  close: "关闭调度",
  floor_blocked: "保底拦截",
  reopen: "恢复调度",
  manual: "手动调整",
};

export const attentionEvents = new Set<DecisionRecord["event"]>(["decrease", "close", "floor_blocked"]);

export const fieldLabels = {
  concurrency: "并发数",
  priority: "优先级",
  loadFactor: "负载因子",
  schedulable: "调度",
} as const;

export function formatFieldValue(field: keyof typeof fieldLabels, value: number | boolean | null) {
  if (field === "schedulable") return value ? "开" : "关";
  if (field === "loadFactor" && value === null) return "默认";
  return String(value);
}

export type StateKind = "ok" | "cooldown" | "unusable" | "closed";

export function accountState(account: RecordedAccount, settings: Settings, now: number): { label: string; kind: StateKind } {
  if (account.closed) {
    if (!account.reopenAt) return { label: "手动关闭", kind: "closed" };
    const minutes = Math.round((Date.parse(account.reopenAt) - now) / 60000);
    if (minutes <= 0) return { label: "已关闭 · 即将恢复", kind: "closed" };
    if (minutes >= 60) return { label: `已关闭 · ${Math.round(minutes / 60)} 小时后恢复`, kind: "closed" };
    return { label: `已关闭 · ${minutes} 分钟后恢复`, kind: "closed" };
  }
  if (!account.usable) return { label: "暂不可用", kind: "unusable" };
  const changedAt = account.lastChangeAt ? Date.parse(account.lastChangeAt) : 0;
  if (now - changedAt < settings.cooldownMinutes * 60000) return { label: "冷却中", kind: "cooldown" };
  return { label: "可调度", kind: "ok" };
}

/** What a decision changed, as "from → to" text. */
export function decisionChange(record: DecisionRecord): { prefix?: string; from: string; to: string } {
  switch (record.event) {
    case "manual":
      return { prefix: `${fieldLabels[record.field]} `, from: formatFieldValue(record.field, record.from), to: formatFieldValue(record.field, record.to) };
    case "reopen":
      return { from: "关闭", to: String(record.concurrency) };
    case "close":
      return { from: String(record.concurrency), to: "关闭" };
    case "floor_blocked":
      return { from: String(record.concurrency), to: "保留" };
    case "restore_priority":
      return { prefix: "优先级 ", from: String(record.priority), to: String(record.nextPriority) };
    default: {
      const priority = record.priority !== record.nextPriority ? ` · 优先级 ${record.priority}→${record.nextPriority}` : "";
      return { from: String(record.concurrency), to: `${record.nextConcurrency}${priority}` };
    }
  }
}
