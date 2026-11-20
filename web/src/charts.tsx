import { useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { SeriesResponse } from "./api";
import { eventLabels, formatCount, formatDayClock, formatRate, formatShortClock } from "./format";
import type { BucketPoint } from "./series";

const axis = { fontSize: 10, fill: "var(--faint)", fontFamily: "var(--mono)" };

function bucketLabel(start: number, bucketMinutes: number) {
  const end = start + bucketMinutes * 60_000;
  const format = bucketMinutes >= 360 ? formatDayClock : formatShortClock;
  return `${format(start)} – ${formatShortClock(end)}`;
}

function tick(start: number, range: SeriesResponse["range"]) {
  return range === "7d" ? formatDayClock(start).slice(0, 5) : formatShortClock(start);
}

interface TipProps {
  active?: boolean;
  payload?: readonly { payload?: unknown }[];
  bucketMinutes: number;
}

function PointTooltip({ active, payload, bucketMinutes }: TipProps) {
  const point = payload?.[0]?.payload as BucketPoint | undefined;
  if (!active || !point) return null;
  return (
    <div className="tip">
      <p className="tip-k">{bucketLabel(point.start, bucketMinutes)}</p>
      <p><i className="key ok" />成功 <b>{formatCount(point.successes)}</b></p>
      <p><i className="key err" />503 <b>{formatCount(point.errors)}</b></p>
      <p>错误率 <b>{point.rate === null ? "—" : formatRate(point.rate)}</b></p>
      <p>并发 <b>{point.concurrency === 0 ? "关闭" : point.concurrency}</b></p>
      {point.events.map((record, index) => (
        <p key={index} className="tip-event">{formatShortClock(record.ts)} {eventLabels[record.event]}</p>
      ))}
    </div>
  );
}

/** Tiny stacked bars for a card: no axes, hover shows the bucket. */
export function Sparkline({ points, bucketMinutes }: { points: BucketPoint[]; bucketMinutes: number }) {
  return (
    <ResponsiveContainer width="100%" height={56}>
      <BarChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap={1}>
        <XAxis dataKey="start" hide />
        <YAxis hide domain={[0, "dataMax"]} />
        <Tooltip
          content={({ active, payload }) => <PointTooltip active={active} payload={payload} bucketMinutes={bucketMinutes} />}
          cursor={{ fill: "var(--wash)" }}
          isAnimationActive={false}
          wrapperStyle={{ zIndex: 5 }}
        />
        <Bar dataKey="successes" stackId="t" fill="var(--ok)" isAnimationActive={false} />
        <Bar dataKey="errors" stackId="t" fill="var(--err)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

interface PanelProps {
  points: BucketPoint[];
  range: SeriesResponse["range"];
  bucketMinutes: number;
}

const margin = { top: 8, right: 8, bottom: 0, left: 0 };

function eventLines(points: BucketPoint[]) {
  return points.filter((point) => point.events.some((record) => record.event !== "manual" || record.field !== "loadFactor"))
    .map((point) => (
      <ReferenceLine key={point.start} x={point.start} stroke="var(--accent)" strokeDasharray="2 3" strokeWidth={1} />
    ));
}

/** Three panels on one time axis: requests, error rate, concurrency. Each has its own y-axis. */
export function DetailCharts({ points, range, bucketMinutes, errorRate }: PanelProps & { errorRate: number }) {
  // The panels share a cursor; only the panel under the pointer shows the tooltip box.
  const [hovered, setHovered] = useState<string | null>(null);
  const tooltip = (panel: string) => (
    <Tooltip
      content={({ active, payload }) => hovered === panel && <PointTooltip active={active} payload={payload} bucketMinutes={bucketMinutes} />}
      cursor={{ fill: "var(--wash)", stroke: "var(--rule-2)" }}
      isAnimationActive={false}
    />
  );
  const xAxis = (show: boolean) => (
    <XAxis
      dataKey="start"
      tick={show ? axis : false}
      tickFormatter={(value: number) => tick(value, range)}
      tickLine={false}
      axisLine={{ stroke: "var(--rule-2)" }}
      minTickGap={24}
      height={show ? 22 : 4}
    />
  );
  const grid = <CartesianGrid vertical={false} stroke="var(--rule)" />;
  const maxConcurrency = Math.max(1, ...points.map((point) => point.concurrency));
  const syncId = "detail";

  return (
    <div className="panels">
      <div className="panel" onMouseEnter={() => setHovered("requests")}>
        <p className="panel-k">请求数 <span className="legend"><i className="key ok" />成功 <i className="key err" />503</span></p>
        <ResponsiveContainer width="100%" height={150}>
          <BarChart data={points} margin={margin} syncId={syncId} barCategoryGap="18%">
            {grid}
            {xAxis(false)}
            <YAxis tick={axis} tickLine={false} axisLine={false} width={40} allowDecimals={false} />
            {tooltip("requests")}
            {eventLines(points)}
            <Bar dataKey="successes" stackId="t" fill="var(--ok)" isAnimationActive={false} />
            <Bar dataKey="errors" stackId="t" fill="var(--err)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="panel" onMouseEnter={() => setHovered("rate")}>
        <p className="panel-k">错误率 <span className="legend"><i className="key line" />阈值 {formatRate(errorRate)}</span></p>
        <ResponsiveContainer width="100%" height={110}>
          <LineChart data={points} margin={margin} syncId={syncId}>
            {grid}
            {xAxis(false)}
            <YAxis
              tick={axis}
              tickLine={false}
              axisLine={false}
              width={40}
              domain={[0, (max: number) => Math.max(max, errorRate * 1.5)]}
              tickFormatter={(value: number) => `${Math.round(value * 100)}%`}
            />
            {tooltip("rate")}
            {eventLines(points)}
            <ReferenceLine y={errorRate} stroke="var(--err)" strokeDasharray="4 3" strokeWidth={1} />
            <Line dataKey="rate" stroke="var(--ink-2)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="panel" onMouseEnter={() => setHovered("concurrency")}>
        <p className="panel-k">并发 <span className="legend">0 表示关闭调度</span></p>
        <ResponsiveContainer width="100%" height={110}>
          <LineChart data={points} margin={margin} syncId={syncId}>
            {grid}
            {xAxis(true)}
            <YAxis tick={axis} tickLine={false} axisLine={false} width={40} allowDecimals={false} domain={[0, maxConcurrency]} />
            {tooltip("concurrency")}
            {eventLines(points)}
            <Line dataKey="concurrency" type="stepAfter" stroke="var(--accent)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
