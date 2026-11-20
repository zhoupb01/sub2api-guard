import type { RecordedAccount, Settings } from "./api";
import { accountState, formatRate } from "./format";

export function SectionTitle({ title, note }: { title: string; note?: string }) {
  return (
    <h2><span className="t">{title}</span><i className="dim" aria-hidden="true" />{note && <span className="h2-note">{note}</span>}</h2>
  );
}

export function StateTag({ account, settings, now }: { account: RecordedAccount; settings: Settings; now: number }) {
  const state = accountState(account, settings, now);
  return <span className="state" data-kind={state.kind}><i />{state.label}</span>;
}

export function CapacityBlocks({ account }: { account: RecordedAccount }) {
  const count = Math.max(account.maxConcurrency, account.concurrency);
  return (
    <span className="capacity">
      <span className="blocks">
        {Array.from({ length: count }, (_, index) => <i key={index} className={index < account.concurrency ? "block on" : "block"} />)}
      </span>
      <span className="of"><b className="figure">{account.concurrency}</b> / {account.maxConcurrency}</span>
    </span>
  );
}

/** Recent error rate against the guard's threshold; the track spans three times the threshold. */
export function RateMeter({ account, settings }: { account: RecordedAccount; settings: Settings }) {
  const { rate, errors, total } = account.recent;
  const scale = Math.max(settings.errorRate * 3, 0.03);
  const over = rate >= settings.errorRate;
  return (
    <span className="rate">
      <b className={over ? "figure over" : "figure"}>{formatRate(rate)}</b>
      <span className={over ? "meter over" : "meter"}>
        <i style={{ width: `${Math.min(rate / scale, 1) * 100}%` }} />
        <b style={{ left: `${Math.min(settings.errorRate / scale, 1) * 100}%` }} />
      </span>
      <span className="quiet">{errors} / {total}</span>
    </span>
  );
}

export function Priority({ account }: { account: RecordedAccount }) {
  return (
    <span className="of">
      <b className="figure">{account.priority}</b>
      {account.priorityBump > 0 && <span className="bump" title="守护加上去的，账号恢复后会减回来"> 守护 +{account.priorityBump}</span>}
    </span>
  );
}
