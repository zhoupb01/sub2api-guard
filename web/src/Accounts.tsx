import type { RecordedAccount, SeriesResponse, StatusSnapshot } from "./api";
import { CapacityBlocks, Priority, RateMeter, SectionTitle, StateTag } from "./bits";
import { Sparkline } from "./charts";
import { formatCount, formatRate, relativeTime } from "./format";
import { bucketPoints, totals } from "./series";

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "err" | "warn" }) {
  return (
    <div className="kpi" data-tone={tone}>
      <p className="kpi-k">{label}</p>
      <p className="kpi-v">{value}</p>
      {sub && <p className="kpi-sub">{sub}</p>}
    </div>
  );
}

function Overview({ status, series }: { status: StatusSnapshot; series: SeriesResponse | null }) {
  const { settings, accounts } = status;
  const usable = accounts.filter((account) => !account.closed && account.usable).length;
  const closed = accounts.filter((account) => account.closed).length;
  const degraded = accounts.filter((account) => !account.closed && account.concurrency < account.maxConcurrency).length;
  let successes = 0;
  let errors = 0;
  for (const entry of series?.accounts ?? []) {
    const sum = totals(entry);
    successes += sum.successes;
    errors += sum.errors;
  }
  const total = successes + errors;
  return (
    <div className="kpis">
      <Kpi label="可用账号" value={`${usable} / ${accounts.length}`} sub={`保底 ${settings.minSchedulable} 个`} tone={usable <= settings.minSchedulable ? "warn" : undefined} />
      <Kpi label="24 小时请求" value={series ? formatCount(total) : "—"} />
      <Kpi label="24 小时 503" value={series ? formatCount(errors) : "—"} sub={series ? `错误率 ${formatRate(total ? errors / total : 0)}` : undefined} tone={errors ? "err" : undefined} />
      <Kpi label="降了并发" value={String(degraded)} sub={`已关闭 ${closed} 个`} />
    </div>
  );
}

function AccountCard({ account, status, series }: { account: RecordedAccount; status: StatusSnapshot; series: SeriesResponse | null }) {
  const now = Date.parse(status.now);
  const entry = series?.accounts.find((item) => item.id === account.id);
  const sum = totals(entry);
  const points = series && entry ? bucketPoints(series, entry, account) : null;
  return (
    <a className={account.closed ? "card is-closed" : "card"} href={`#/account/${account.id}`}>
      <div className="card-head">
        <span className="account-name">{account.name}</span>
        <span className="account-id">#{account.id}</span>
        <StateTag account={account} settings={status.settings} now={now} />
      </div>
      <div className="card-figures">
        <div><p className="fig-k">24h 请求</p><p className="fig-v">{entry ? formatCount(sum.total) : "—"}</p></div>
        <div><p className="fig-k">503</p><p className={sum.errors ? "fig-v err" : "fig-v"}>{entry ? formatCount(sum.errors) : "—"}</p></div>
        <div><p className="fig-k">错误率</p><p className="fig-v">{entry ? formatRate(sum.rate) : "—"}</p></div>
      </div>
      <div className="card-chart">
        {points ? <Sparkline points={points} bucketMinutes={series!.bucketMinutes} /> : <div className="chart-empty">正在加载…</div>}
      </div>
      <dl className="card-facts">
        <div><dt>并发</dt><dd><CapacityBlocks account={account} /></dd></div>
        <div><dt>优先级</dt><dd><Priority account={account} /></dd></div>
        <div className="wide"><dt>近 {status.settings.windowMinutes} 分钟</dt><dd><RateMeter account={account} settings={status.settings} /></dd></div>
        <div className="wide"><dt>上次调整</dt><dd className="quiet">{relativeTime(account.lastChangeAt, now)}</dd></div>
      </dl>
    </a>
  );
}

export function Accounts({ status, series }: { status: StatusSnapshot; series: SeriesResponse | null }) {
  return (
    <>
      <section className="section">
        <SectionTitle title="总览" note="503 按守护的错误关键词统计" />
        <Overview status={status} series={series} />
      </section>
      <section className="section">
        <SectionTitle title="账号" note={`${status.accounts.length} 个 · 小图是近 24 小时，每根一小时`} />
        {status.accounts.length ? (
          <div className="cards">
            {status.accounts.map((account) => <AccountCard key={account.id} account={account} status={status} series={series} />)}
          </div>
        ) : <p className="empty">暂无账号数据</p>}
      </section>
    </>
  );
}
