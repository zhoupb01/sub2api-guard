import { useState } from "react";
import type { DecisionRecord, StatusSnapshot } from "./api";
import { SectionTitle } from "./bits";
import { attentionEvents, decisionChange, eventLabels, formatDayClock, formatRate } from "./format";

export function DecisionTable({ records, showAccount = true }: { records: DecisionRecord[]; showAccount?: boolean }) {
  if (!records.length) return <p className="empty">暂无决策</p>;
  return (
    <table className="table decisions">
      <thead>
        <tr>
          <th>时间</th>
          <th>事件</th>
          {showAccount && <th>账号</th>}
          <th>变化</th>
          <th className="th-num">错误率</th>
        </tr>
      </thead>
      <tbody>
        {records.map((record, index) => {
          const change = decisionChange(record);
          return (
            <tr key={`${record.ts}-${record.id}-${index}`} data-attention={attentionEvents.has(record.event)}>
              <td className="c-time"><time dateTime={record.ts}>{formatDayClock(record.ts)}</time></td>
              <td className="c-event">{eventLabels[record.event]}</td>
              {showAccount && (
                <td className="c-account"><span className="account-id">#{record.id}</span><span className="account-name">{record.name}</span></td>
              )}
              <td className="c-change">{change.prefix}<b className="figure">{change.from}</b><span className="arrow">→</span>{change.to}</td>
              <td className="c-rate">{"rate" in record ? formatRate(record.rate) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Decisions({ status }: { status: StatusSnapshot }) {
  const [accountId, setAccountId] = useState("");
  const [event, setEvent] = useState("");
  const records = status.decisions.filter((record) =>
    (accountId === "" || record.id === Number(accountId)) && (event === "" || record.event === event));
  const accountIds = [...new Set(status.decisions.map((record) => record.id))].sort((left, right) => left - right);
  return (
    <section className="section">
      <SectionTitle title="决策" note={`最近 ${status.decisions.length} 条`} />
      <div className="filters">
        <label className="field">
          <span className="field-k">账号</span>
          <select value={accountId} onChange={(change) => setAccountId(change.target.value)}>
            <option value="">全部</option>
            {accountIds.map((id) => <option key={id} value={id}>#{id} {status.decisions.find((record) => record.id === id)?.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-k">事件</span>
          <select value={event} onChange={(change) => setEvent(change.target.value)}>
            <option value="">全部</option>
            {Object.entries(eventLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
      </div>
      <DecisionTable records={records} />
    </section>
  );
}
