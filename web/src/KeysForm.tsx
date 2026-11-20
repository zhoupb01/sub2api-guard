import { useState, type FormEvent } from "react";
import { api, Unauthorized, type StatusSnapshot } from "./api";
import { formatDayClock } from "./format";

type KeyName = "admin" | "probe";

const keys: { name: KeyName; label: string; hint: string; placeholder: string }[] = [
  {
    name: "admin",
    label: "Admin API Key",
    hint: "在 sub2api 管理后台 → 设置 → Admin API Key 获取。实跑调整、手动调整和测试都要用。",
    placeholder: "粘贴新的 Admin API Key",
  },
  {
    name: "probe",
    label: "Probe API Key",
    hint: "测试专用的普通用户密钥（sk-…），测试时会被绑到测试分组。",
    placeholder: "sk-…",
  },
];

/** Keys can be set or cleared here; the server never sends them back. */
export function KeysForm({ status, onSaved, onUnauthorized }: { status: StatusSnapshot; onSaved: () => Promise<void>; onUnauthorized: () => void }) {
  const [values, setValues] = useState<Record<KeyName, string>>({ admin: "", probe: "" });
  const [message, setMessage] = useState<{ text: string; kind?: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(change: { admin?: string | null; probe?: string | null }, done: string) {
    setBusy(true);
    setMessage({ text: "正在保存…" });
    try {
      await api.saveKeys(change);
      setValues({ admin: "", probe: "" });
      setMessage({ text: done, kind: "ok" });
      await onSaved();
    } catch (failure) {
      if (failure instanceof Unauthorized) onUnauthorized();
      else setMessage({ text: failure instanceof Error ? failure.message : String(failure), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const change: { admin?: string; probe?: string } = {};
    for (const { name } of keys) {
      const value = values[name].trim();
      if (value) change[name] = value;
    }
    if (!Object.keys(change).length) {
      setMessage({ text: "没有填新的 key" });
      return;
    }
    void save(change, "已保存，马上生效");
  }

  function clear(name: KeyName, label: string) {
    if (!confirm(`清除 ${label}？清除后${name === "admin" ? "实跑模式不会再调整账号，也不能手动调整" : "不能再测试"}。`)) return;
    void save({ [name]: null }, `已清除 ${label}`);
  }

  return (
    <form onSubmit={submit} autoComplete="off">
      <div className="setting-group keys">
      <p className="setting-hint">只能填、不能看。保存后马上生效，不用重启。{status.apiKeys.updatedAt && `上次修改 ${formatDayClock(status.apiKeys.updatedAt)}。`}</p>
      {status.dryRun === false && !status.apiKeys.admin && (
        <p className="msg" data-kind="error">实跑模式下，没填 Admin API Key 守护什么都不会做。</p>
      )}
      {keys.map(({ name, label, hint, placeholder }) => {
        const set = status.apiKeys[name];
        return (
          <div key={name} className="key-row">
            <label className="setting-k" htmlFor={`key-${name}`}>{label}</label>
            <span className="state" data-kind={set ? "ok" : "closed"}><i />{set ? "已设置" : "未设置"}</span>
            <input
              id={`key-${name}`}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={set ? "填新的会替换旧的" : placeholder}
              value={values[name]}
              onChange={(event) => setValues({ ...values, [name]: event.target.value })}
            />
            {set && <button type="button" className="btn" disabled={busy} onClick={() => clear(name, label)}>清除</button>}
            <span className="setting-hint">{hint}</span>
          </div>
        );
      })}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={busy}>保存 key</button>
        <p className="msg" data-kind={message?.kind}>{message?.text}</p>
      </div>
      </div>
    </form>
  );
}
