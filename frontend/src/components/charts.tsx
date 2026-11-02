import { BarChart3, Download, Table2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useTheme } from "../lib/theme";
import { Card } from "./ui";

/** Validated categorical palette slots (see index.css). Assigned in fixed order, never cycled. */
export const SERIES = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5", "--series-6", "--series-7", "--series-8"];

/** Resolve CSS custom properties to concrete colors (SVG attributes need real values); re-resolves on theme change. */
export function useChartColors() {
  const { dark } = useTheme();
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim() || "#888";
    return {
      series: SERIES.map(v),
      grid: v("--chart-grid"),
      axis: v("--chart-axis"),
      neutral: v("--chart-neutral"),
      surface: v("--surface"),
      fg: v("--fg"),
      muted: v("--muted"),
      dark,
    };
  }, [dark]);
}

export function useAxisProps() {
  const c = useChartColors();
  return {
    tick: { fill: c.axis, fontSize: 11 },
    axisLine: false as const,
    tickLine: false as const,
    stroke: c.axis,
  };
}

/** Shared tooltip: surface background, text in ink tokens, a colored swatch per series. */
export function ChartTooltip({ active, payload, label, format }: {
  active?: boolean;
  payload?: { name?: string; value?: number | string | null; color?: string; dataKey?: string | number }[];
  label?: string | number;
  format?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border bg-surface px-3 py-2 text-xs shadow-lg">
      {label !== undefined && <p className="mb-1 font-semibold text-fg">{label}</p>}
      {payload.filter((p) => p.value !== null && p.value !== undefined).map((p) => (
        <p key={String(p.dataKey ?? p.name)} className="flex items-center gap-2 text-muted">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="ml-auto pl-3 font-semibold tabular-nums text-fg">
            {typeof p.value === "number" && format ? format(p.value) : p.value}
          </span>
        </p>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-xs text-muted">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4" style={{ background: i.dashed ? `repeating-linear-gradient(90deg, ${i.color} 0 4px, transparent 4px 7px)` : i.color, height: i.dashed ? 2 : 8, borderRadius: 2 }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export interface TableColumn<T> {
  key: keyof T & string;
  label: string;
  format?: (v: T[keyof T], row: T) => ReactNode;
}

/** Card with a Chart / Table toggle — every chart has an accessible table view of the same rows. */
export function ChartCard<T extends Record<string, unknown>>({
  title,
  rows,
  columns,
  children,
  actions,
  onExport,
  empty,
}: {
  title: ReactNode;
  rows: T[];
  columns: TableColumn<T>[];
  children: ReactNode;
  actions?: ReactNode;
  onExport?: () => void;
  empty?: ReactNode;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <Card title={title} actions={
      <div className="flex items-center gap-1">
        {actions}
        <div className="flex rounded-md border p-0.5" role="group" aria-label="View">
          <button aria-pressed={view === "chart"} onClick={() => setView("chart")} title="Chart view"
            className={`rounded p-1 ${view === "chart" ? "bg-surface-3 text-fg" : "text-muted"}`}><BarChart3 size={14} /></button>
          <button aria-pressed={view === "table"} onClick={() => setView("table")} title="Table view"
            className={`rounded p-1 ${view === "table" ? "bg-surface-3 text-fg" : "text-muted"}`}><Table2 size={14} /></button>
        </div>
        {onExport && <button onClick={onExport} title="Export CSV" aria-label="Export CSV" className="rounded p-1.5 text-muted hover:bg-surface-2"><Download size={14} /></button>}
      </div>
    }>
      {rows.length === 0 && empty ? empty : view === "chart" ? children : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
              <tr>{columns.map((c) => <th key={c.key} className="px-3 py-1.5 font-semibold">{c.label}</th>)}</tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r, i) => (
                <tr key={i}>{columns.map((c) => <td key={c.key} className="px-3 py-1.5 tabular-nums">{c.format ? c.format(r[c.key], r) : String(r[c.key] ?? "—")}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
