import { useEffect, useState, type FormEvent } from "react";
import { api, Unauthorized, type ProbeRun, type StatusSnapshot } from "./api";
import { SectionTitle } from "./bits";
import { formatClock } from "./format";
import { usePoll } from "./hooks";

const modelKey = "probe-model";

function readModel() {
  try {
    return localStorage.getItem(modelKey) ?? "";
  } catch {
    return "";
  }
}

function saveModel(model: string) {
  try {
    localStorage.setItem(modelKey, model);
  } catch {
    // Remembering the model is only a convenience.
  }
}

const seconds = (value: number | undefined) => (value === undefined ? "—" : `${value.toFixed(2)} 秒`);

function RunView({ run }: { run: ProbeRun }) {
  const running = run.finishedAt === null;
  const planned = run.request.accountIds.length * run.request.repeat;
  return (
    <div className="run">
      <p className="run-head">
        <b>第 {run.id} 次测试</b>
        <span>{formatClock(run.startedAt)} 开始</span>
        <span className="state" data-kind={running ? "cooldown" : run.exitCode === 0 ? "ok" : "closed"}>
          <i />
          {running ? `进行中 · ${run.results.length} / ${planned}` : run.cancelled ? "已取消" : run.exitCode === 0 ? "全部成功" : "有失败"}
        </span>
      </p>
      <p className="quiet">模型 {run.request.model} · 每个账号 {run.request.repeat} 次 · 账号 {run.request.accountIds.map((id) => `#${id}`).join(" ")}</p>
      {run.error && <p className="msg" data-kind="error">{run.error}</p>}
      {run.results.length > 0 && (
        <table className="table probe-results">
          <thead>
            <tr><th>账号</th><th>第几次</th><th>HTTP</th><th className="th-num">首字</th><th className="th-num">总耗时</th><th>输出 / 错误</th></tr>
          </thead>
          <tbody>
            {run.results.map((result, index) => (
              <tr key={index} data-attention={result.error !== undefined}>
                <td><span className="account-id">#{result.accountId}</span> <span className="account-name">{result.name}</span></td>
                <td>{result.requestNumber}</td>
                <td className={result.error !== undefined ? "err" : undefined}>{result.status ?? "—"}</td>
                <td className="c-num">{seconds(result.firstTokenSeconds)}</td>
                <td className="c-num">{seconds(result.totalSeconds)}</td>
                <td className="c-output">
                  {result.error !== undefined ? <span className="err">{result.error}</span> : (
                    <details><summary>{[...result.output].slice(0, 60).join("") || "（空）"}</summary><pre>{result.output}</pre></details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details className="logs" open={running}>
        <summary>过程日志（{run.logs.length} 条）</summary>
        <ol>
          {run.logs.map((entry, index) => <li key={index}><time>{formatClock(entry.ts)}</time> {entry.message.replace(/^Account (\d+)/, "#$1")}</li>)}
        </ol>
      </details>
    </div>
  );
}

export function ProbePanel({ status, onUnauthorized }: { status: StatusSnapshot; onUnauthorized: () => void }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [model, setModel] = useState(readModel);
  const [prompt, setPrompt] = useState("你好，请介绍一下自己");
  const [repeat, setRepeat] = useState("1");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const probe = usePoll(api.probe, 1_500, onUnauthorized, status.probeEnabled);
  const run = probe.data?.run ?? null;
  const running = run !== null && run.finishedAt === null;

  useEffect(() => { setMessage(probe.error); }, [probe.error]);

  if (!status.probeEnabled) {
    return (
      <section className="section">
        <SectionTitle title="提示词测试" />
        <p className="quiet">没有设置 ADMIN_API_KEY 或 PROBE_API_KEY，不能测试。在服务器的 .env 里填上后重启容器。</p>
      </section>
    );
  }

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      await probe.refresh();
    } catch (failure) {
      if (failure instanceof Unauthorized) onUnauthorized();
      else setMessage(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected.size) {
      setMessage("至少选一个账号");
      return;
    }
    saveModel(model.trim());
    void act(() => api.startProbe({
      accountIds: status.accounts.map((account) => account.id).filter((id) => selected.has(id)),
      model: model.trim(),
      prompt,
      repeat: Number(repeat),
    }));
  }

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  return (
    <section className="section">
      <SectionTitle title="提示词测试" note="一次只能跑一个" />
      <p className="hint">按顺序把每个账号单独挪进测试分组，用你的提示词发请求，测完放回原来的分组和调度状态。测试期间这个账号不接正常请求。</p>
      <form className="probe-form" onSubmit={submit}>
        <fieldset className="setting-group">
          <legend>账号</legend>
          <div className="pick">
            {status.accounts.map((account) => (
              <label key={account.id} className="pick-item">
                <input type="checkbox" checked={selected.has(account.id)} onChange={() => toggle(account.id)} disabled={running} />
                <span className="account-id">#{account.id}</span> <span className="account-name">{account.name}</span>
                {account.closed && <span className="quiet"> · 已关闭</span>}
              </label>
            ))}
          </div>
          <div className="pick-actions">
            <button type="button" className="btn" disabled={running} onClick={() => setSelected(new Set(status.accounts.map((account) => account.id)))}>全选</button>
            <button type="button" className="btn" disabled={running} onClick={() => setSelected(new Set())}>清空</button>
          </div>
        </fieldset>
        <div className="probe-fields">
          <label className="field">
            <span className="field-k">模型</span>
            <input className="wide-input" required value={model} placeholder="例如 gpt-6.1-sol" onChange={(event) => setModel(event.target.value)} disabled={running} />
          </label>
          <label className="field">
            <span className="field-k">每个账号几次</span>
            <input type="number" min={1} max={10} step={1} required value={repeat} onChange={(event) => setRepeat(event.target.value)} disabled={running} />
          </label>
        </div>
        <label className="field">
          <span className="field-k">提示词</span>
          <textarea rows={5} required value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={running} />
        </label>
        <div className="form-actions">
          {running ? (
            <button type="button" className="btn" disabled={busy} onClick={() => act(api.cancelProbe)}>取消测试</button>
          ) : (
            <button type="submit" className="btn primary" disabled={busy}>开始测试</button>
          )}
          {message && <p className="msg" data-kind="error">{message}</p>}
        </div>
      </form>
      {run && <RunView run={run} />}
    </section>
  );
}
