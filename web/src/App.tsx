import { useCallback, useState } from "react";
import { api, type Range } from "./api";
import { AccountDetail } from "./AccountDetail";
import { Accounts } from "./Accounts";
import { Decisions } from "./Decisions";
import { formatClock } from "./format";
import { useHash, usePoll } from "./hooks";
import { Login } from "./Login";
import { ProbePanel } from "./ProbePanel";
import { SettingsForm } from "./SettingsForm";

const views = [
  { key: "accounts", label: "账号" },
  { key: "decisions", label: "决策" },
  { key: "settings", label: "设置" },
  { key: "probe", label: "提示词测试" },
] as const;
type View = (typeof views)[number]["key"];

function parseHash(hash: string): { view: View; accountId: number | null } {
  const account = hash.match(/^#\/account\/(\d+)$/);
  if (account) return { view: "accounts", accountId: Number(account[1]) };
  const view = views.find((item) => hash === `#/${item.key}`)?.key ?? "accounts";
  return { view, accountId: null };
}

const cardRange: Range = "24h";

export function App() {
  const [signedIn, setSignedIn] = useState(true);
  const signOut = useCallback(() => setSignedIn(false), []);
  const status = usePoll(api.status, 15_000, signOut, signedIn);
  const series = usePoll(() => api.series(cardRange), 60_000, signOut, signedIn);
  const { view, accountId } = parseHash(useHash());

  if (!signedIn) {
    return <Login onSignedIn={() => { setSignedIn(true); void status.refresh(); void series.refresh(); }} />;
  }

  const data = status.data;
  const refreshAll = async () => { await Promise.all([status.refresh(), series.refresh()]); };
  const account = accountId === null ? undefined : data?.accounts.find((item) => item.id === accountId);

  return (
    <div className="sheet">
      <div className="frame">
        <header className="plate">
          <span className="mark">SUB2API-GUARD<span>第 <b>{data?.groupId ?? "—"}</b> 组</span></span>
          <div className="info">
            <span className="info-item">
              <span className="info-k">模式</span>
              <span className={data?.dryRun ? "info-v mode-dry" : "info-v"}>{data ? (data.dryRun ? "演练" : "实跑") : "—"}</span>
            </span>
            <span className="info-item">
              <span className="info-k">上次检查</span>
              <span className="info-v" title={data?.lastTickAt ?? ""}>{data ? (data.lastTickAt ? formatClock(data.lastTickAt) : "尚未完成") : "—"}</span>
            </span>
            <span className="info-item">
              <span className="info-k">更新</span>
              <span className="info-v">
                {status.error ? `刷新失败，稍后重试 · ${status.error}` : status.updatedAt ? formatClock(status.updatedAt) : "正在加载…"}
              </span>
            </span>
          </div>
          <button type="button" className="btn logout" onClick={async () => { await api.logout(); signOut(); }}>退出</button>
        </header>
        <nav className="tabs" aria-label="页面">
          {views.map((item) => (
            <a key={item.key} href={`#/${item.key}`} className="tab" aria-current={view === item.key ? "page" : undefined}>{item.label}</a>
          ))}
        </nav>
        <main className="doc">
          {data?.lastError && (
            <div className="note">
              <p className="note-k">检查异常</p>
              <p className="note-body"><b>{formatClock(data.lastError.ts)} 检查失败</b><span>{data.lastError.message}</span></p>
            </div>
          )}
          {!data ? (
            <p className="loading">{status.error ? `加载失败：${status.error}` : "正在加载…"}</p>
          ) : view === "accounts" ? (
            <Accounts status={data} series={series.data} />
          ) : view === "decisions" ? (
            <Decisions status={data} />
          ) : view === "settings" ? (
            <SettingsForm status={data} onSaved={status.refresh} onUnauthorized={signOut} />
          ) : (
            <ProbePanel status={data} onUnauthorized={signOut} />
          )}
        </main>
      </div>
      {data && account && (
        <AccountDetail
          key={account.id}
          status={data}
          account={account}
          onClose={() => { location.hash = "#/accounts"; }}
          onChanged={refreshAll}
          onUnauthorized={signOut}
        />
      )}
    </div>
  );
}
