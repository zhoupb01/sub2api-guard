import { useEffect, useState } from "react";
import { api, Unauthorized, type ManualChange, type Range, type RecordedAccount, type StatusSnapshot } from "./api";
import { CapacityBlocks, Priority, RateMeter, StateTag } from "./bits";
import { DetailCharts } from "./charts";
import { DecisionTable } from "./Decisions";
import { fieldLabels, formatCount, formatRate } from "./format";
import { usePoll } from "./hooks";
import { bucketPoints, totals } from "./series";

const ranges: { key: Range; label: string }[] = [
  { key: "1h", label: "1 小时" },
  { key: "24h", label: "24 小时" },
  { key: "7d", label: "7 天" },
];

type NumberField = "concurrency" | "priority" | "loadFactor";
const numberFields: NumberField[] = ["concurrency", "priority", "loadFactor"];

function toInput(value: number | null) {
  return value === null ? "" : String(value);
}

function Editor({ account, enabled, onChanged, onUnauthorized }: {
  account: RecordedAccount;
  enabled: boolean;
  onChanged: () => Promise<void>;
  onUnauthorized: () => void;
}) {
  const [values, setValues] = useState(() => Object.fromEntries(numberFields.map((field) => [field, toInput(account[field])])) as Record<NumberField, string>);
  const [message, setMessage] = useState<{ text: string; kind?: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  const { concurrency, priority, loadFactor } = account;
  useEffect(() => {
    setValues({ concurrency: toInput(concurrency), priority: toInput(priority), loadFactor: toInput(loadFactor) });
  }, [concurrency, priority, loadFactor]);

  if (!enabled) return <p className="quiet">没有设置 ADMIN_API_KEY，不能手动调整。</p>;

  async function apply(changes: ManualChange[]) {
    setBusy(true);
    setMessage({ text: "正在保存…" });
    try {
      for (const change of changes) {
        const field = Object.keys(change)[0] as keyof typeof fieldLabels;
        try {
          await api.changeAccount(account.id, change);
        } catch (failure) {
          if (failure instanceof Unauthorized) throw failure;
          throw new Error(`${fieldLabels[field]}：${failure instanceof Error ? failure.message : failure}`);
        }
      }
      setMessage({ text: "已保存", kind: "ok" });
      await onChanged();
    } catch (failure) {
      if (failure instanceof Unauthorized) onUnauthorized();
      else setMessage({ text: failure instanceof Error ? failure.message : String(failure), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const changes: ManualChange[] = [];
    for (const field of numberFields) {
      const raw = values[field].trim();
      const value = field === "loadFactor" && raw === "" ? null : Number(raw);
      if (value === account[field]) continue;
      if (value !== null && !Number.isInteger(value)) {
        setMessage({ text: `${fieldLabels[field]}要填整数`, kind: "error" });
        return;
      }
      changes.push({ [field]: value } as ManualChange);
    }
    if (!changes.length) setMessage({ text: "没有改动" });
    else void apply(changes);
  }

  function toggle() {
    if (!account.closed && !confirm(`关闭 #${account.id} ${account.name} 的调度？手动关闭后不会自动恢复。`)) return;
    void apply([{ schedulable: account.closed }]);
  }

  return (
    <div className="editor-box">
      {numberFields.map((field) => (
        <label key={field} className="field">
          <span className="field-k">{fieldLabels[field]}</span>
          <input
            type="number"
            inputMode="numeric"
            step={1}
            min={field === "priority" ? 0 : 1}
            max={field === "loadFactor" ? 10000 : undefined}
            placeholder={field === "loadFactor" ? "默认" : undefined}
            value={values[field]}
            onChange={(event) => setValues({ ...values, [field]: event.target.value })}
          />
        </label>
      ))}
      <div className="editor-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={save}>保存</button>
        <i className="editor-split" />
        <button type="button" className="btn" disabled={busy} onClick={toggle}>{account.closed ? "开启调度" : "关闭调度"}</button>
      </div>
      <p className="msg" data-kind={message?.kind}>{message?.text}</p>
      <p className="hint">改优先级后，守护加上去的部分清零，你填的数就是新的基准。数字越小越先接请求。</p>
    </div>
  );
}

export function AccountDetail({ status, account, onClose, onChanged, onUnauthorized }: {
  status: StatusSnapshot;
  account: RecordedAccount;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onUnauthorized: () => void;
}) {
  const [range, setRange] = useState<Range>("24h");
  const series = usePoll(() => api.series(range), 60_000, onUnauthorized);
  useEffect(() => { void series.refresh(); }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    document.body.classList.add("no-scroll");
    return () => { removeEventListener("keydown", onKey); document.body.classList.remove("no-scroll"); };
  }, [onClose]);

  const now = Date.parse(status.now);
  const data = series.data?.range === range ? series.data : null;
  const entry = data?.accounts.find((item) => item.id === account.id);
  const points = data && entry ? bucketPoints(data, entry, account) : null;
  const sum = totals(entry);
  const records = status.decisions.filter((record) => record.id === account.id);

  return (
    <div className="overlay" onClick={onClose}>
      <aside className="drawer frame" role="dialog" aria-modal="true" aria-label={`账号 ${account.name}`} onClick={(event) => event.stopPropagation()}>
        <header className="plate">
          <span className="mark">#{account.id}<span>{account.name}</span></span>
          <StateTag account={account} settings={status.settings} now={now} />
          <button type="button" className="btn logout" onClick={onClose}>关闭</button>
        </header>
        <div className="drawer-body">
          <div className="detail-top">
            <div className="segmented" role="group" aria-label="时间范围">
              {ranges.map((item) => (
                <button key={item.key} type="button" className="btn" aria-pressed={range === item.key} onClick={() => setRange(item.key)}>{item.label}</button>
              ))}
            </div>
            <div className="card-figures">
              <div><p className="fig-k">请求</p><p className="fig-v">{entry ? formatCount(sum.total) : "—"}</p></div>
              <div><p className="fig-k">503</p><p className={sum.errors ? "fig-v err" : "fig-v"}>{entry ? formatCount(sum.errors) : "—"}</p></div>
              <div><p className="fig-k">错误率</p><p className="fig-v">{entry ? formatRate(sum.rate) : "—"}</p></div>
            </div>
          </div>
          {points && data ? (
            <DetailCharts points={points} range={range} bucketMinutes={data.bucketMinutes} errorRate={status.settings.errorRate} />
          ) : (
            <div className="chart-empty tall">{series.error ? `加载失败：${series.error}` : "正在加载…"}</div>
          )}
          <p className="hint">虚线是守护或手动做了调整的时间。错误率按每根柱子的时间段算，守护判断用的是近 {status.settings.windowMinutes} 分钟。</p>

          <h3>现在</h3>
          <dl className="card-facts">
            <div><dt>并发</dt><dd><CapacityBlocks account={account} /></dd></div>
            <div><dt>优先级</dt><dd><Priority account={account} /></dd></div>
            <div><dt>负载因子</dt><dd className="of">{account.loadFactor === null ? "默认" : <b className="figure">{account.loadFactor}</b>}</dd></div>
            <div className="wide"><dt>近 {status.settings.windowMinutes} 分钟</dt><dd><RateMeter account={account} settings={status.settings} /></dd></div>
          </dl>

          <h3>手动调整</h3>
          <Editor account={account} enabled={status.manualEnabled} onChanged={onChanged} onUnauthorized={onUnauthorized} />
          {status.dryRun && status.manualEnabled && <p className="hint">演练模式下，手动调整也会真的改 sub2api。</p>}

          <h3>这个账号的决策</h3>
          <DecisionTable records={records} showAccount={false} />
        </div>
      </aside>
    </div>
  );
}
