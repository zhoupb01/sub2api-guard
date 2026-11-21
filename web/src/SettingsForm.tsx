import { useState, type FormEvent } from "react";
import { api, Unauthorized, type Settings, type StatusSnapshot } from "./api";
import { SectionTitle } from "./bits";
import { formatDayClock } from "./format";
import { KeysForm } from "./KeysForm";

type NumberKey = Exclude<keyof Settings & string, "maxOverrides" | "errorPatterns" | "barkUrl" | "probeGroupName">;

interface FieldSpec {
  key: NumberKey;
  label: string;
  unit: string;
  hint: string;
  percent?: boolean;
  min: number;
  max?: number;
}

const groups: { title: string; fields: FieldSpec[] }[] = [
  {
    title: "检查",
    fields: [
      { key: "tickSeconds", label: "检查间隔", unit: "秒", hint: "多久检查一次账号；10 到 3600 秒。保存后马上按新间隔走", min: 10, max: 3600 },
    ],
  },
  {
    title: "降并发",
    fields: [
      { key: "windowMinutes", label: "统计窗口", unit: "分钟", hint: "看最近多久的请求", min: 1 },
      { key: "minRequests", label: "最少请求", unit: "次", hint: "窗口里请求少于这个数就不降；被守护调低优先级的账号，在健康时长内也要有这么多请求才算恢复", min: 1 },
      { key: "errorRate", label: "错误率阈值", unit: "%", hint: "达到就把并发降 1", percent: true, min: 0.1 },
      { key: "cooldownMinutes", label: "冷却", unit: "分钟", hint: "调整后至少等这么久才再降", min: 1 },
      { key: "priorityStep", label: "优先级步长", unit: "", hint: "每降 1 并发，优先级数字加多少；0 表示不动优先级", min: 0 },
    ],
  },
  {
    title: "升并发",
    fields: [
      { key: "healthyMinutes", label: "健康时长", unit: "分钟", hint: "距上次调整至少这么久", min: 1 },
      { key: "healthyRate", label: "健康错误率", unit: "%", hint: "低于这个才算健康", percent: true, min: 0.1 },
      { key: "maxConcurrency", label: "并发上限", unit: "", hint: "升到这里就不再升", min: 1 },
    ],
  },
  {
    title: "关闭与恢复",
    fields: [
      { key: "minSchedulable", label: "保底账号", unit: "个", hint: "关闭后至少还要剩这么多可用账号", min: 0 },
      { key: "reopenMinutes", label: "自动恢复", unit: "分钟", hint: "守护关闭的账号过这么久自动打开", min: 1 },
    ],
  },
];

function toDraft(settings: Settings) {
  const numbers = {} as Record<NumberKey, string>;
  for (const group of groups) {
    for (const field of group.fields) {
      const value = settings[field.key];
      numbers[field.key] = field.percent ? String(Math.round(value * 100 * 1000) / 1000) : String(value);
    }
  }
  return {
    numbers,
    overrides: Object.fromEntries(Object.entries(settings.maxOverrides).map(([id, max]) => [id, String(max)])) as Record<string, string>,
    patterns: settings.errorPatterns.join("\n"),
    barkUrl: settings.barkUrl,
    probeGroupName: settings.probeGroupName,
  };
}

export function SettingsForm({ status, onSaved, onUnauthorized }: { status: StatusSnapshot; onSaved: () => Promise<void>; onUnauthorized: () => void }) {
  const [draft, setDraft] = useState(() => toDraft(status.settings));
  const [message, setMessage] = useState<{ text: string; kind?: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const numbers = {} as Record<NumberKey, number>;
    for (const group of groups) {
      for (const field of group.fields) {
        const value = Number(draft.numbers[field.key]);
        numbers[field.key] = field.percent ? value / 100 : value;
      }
    }
    const settings: Settings = {
      ...status.settings, ...numbers, barkUrl: draft.barkUrl.trim(), probeGroupName: draft.probeGroupName.trim(),
    };
    settings.maxOverrides = Object.fromEntries(Object.entries(draft.overrides)
      .filter(([, value]) => value.trim() !== "")
      .map(([id, value]) => [id, Number(value)]));
    settings.errorPatterns = draft.patterns.split("\n").map((line) => line.trim()).filter(Boolean);
    setBusy(true);
    setMessage({ text: "正在保存…" });
    try {
      await api.saveSettings(settings);
      setMessage({ text: "已保存，下一轮检查开始生效", kind: "ok" });
      await onSaved();
    } catch (failure) {
      if (failure instanceof Unauthorized) onUnauthorized();
      else setMessage({ text: failure instanceof Error ? failure.message : String(failure), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  const setNumber = (key: NumberKey, value: string) => setDraft({ ...draft, numbers: { ...draft.numbers, [key]: value } });

  return (
    <>
    <section className="section">
      <SectionTitle title="API Key" />
      <KeysForm status={status} onSaved={onSaved} onUnauthorized={onUnauthorized} />
    </section>
    <form className="section settings" onSubmit={submit}>
      <SectionTitle title="守护规则" note={status.settingsUpdatedAt ? `上次保存 ${formatDayClock(status.settingsUpdatedAt)}` : "还是默认值"} />
      {groups.map((group) => (
        <fieldset key={group.title} className="setting-group">
          <legend>{group.title}</legend>
          {group.fields.map((field) => (
            <label key={field.key} className="setting">
              <span className="setting-k">{field.label}</span>
              <span className="setting-input">
                <input
                  type="number"
                  required
                  min={field.min}
                  max={field.percent ? 100 : field.max}
                  step={field.percent ? 0.1 : 1}
                  value={draft.numbers[field.key]}
                  onChange={(event) => setNumber(field.key, event.target.value)}
                />
                {field.unit && <span className="unit">{field.unit}</span>}
              </span>
              <span className="setting-hint">{field.hint}</span>
            </label>
          ))}
        </fieldset>
      ))}

      <fieldset className="setting-group">
        <legend>单个账号的并发上限</legend>
        <p className="setting-hint">留空就用上面的并发上限 {status.settings.maxConcurrency}。</p>
        <div className="overrides">
          {status.accounts.map((account) => (
            <label key={account.id} className="override">
              <span><span className="account-id">#{account.id}</span> <span className="account-name">{account.name}</span></span>
              <input
                type="number"
                min={1}
                step={1}
                placeholder="默认"
                value={draft.overrides[account.id] ?? ""}
                onChange={(event) => setDraft({ ...draft, overrides: { ...draft.overrides, [account.id]: event.target.value } })}
              />
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="setting-group">
        <legend>通知与测试</legend>
        <label className="setting text-setting">
          <span className="setting-k">Bark 推送地址</span>
          <input type="url" spellCheck={false} placeholder="留空就不推送" value={draft.barkUrl} onChange={(event) => setDraft({ ...draft, barkUrl: event.target.value })} />
          <span className="setting-hint">关闭调度、恢复调度、保底拦截时推到手机。演练模式不推送。</span>
        </label>
        <label className="setting text-setting">
          <span className="setting-k">测试分组名</span>
          <input required spellCheck={false} value={draft.probeGroupName} onChange={(event) => setDraft({ ...draft, probeGroupName: event.target.value })} />
          <span className="setting-hint">提示词测试会把账号临时加入这个分组，测完移出。没有就自动建；要是已有，必须是测试专用的。</span>
        </label>
      </fieldset>

      <fieldset className="setting-group">
        <legend>错误关键词</legend>
        <p className="setting-hint">一行一个。上游错误信息里含有任意一个（不分大小写），就算一次 503。</p>
        <textarea rows={4} required value={draft.patterns} onChange={(event) => setDraft({ ...draft, patterns: event.target.value })} />
      </fieldset>

      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>保存设置</button>
        <button type="button" className="btn" disabled={busy} onClick={() => { setDraft(toDraft(status.settings)); setMessage(null); }}>还原</button>
        <p className="msg" data-kind={message?.kind}>{message?.text}</p>
      </div>
    </form>
    </>
  );
}
