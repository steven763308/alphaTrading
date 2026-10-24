"use client";

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Bar } from "@/lib/engine/types";
import { decimalsOf, roundToStep } from "@/lib/engine/math";
import { fmtTime } from "@/lib/client/format";

export interface ChartLine {
  id: string;
  price: number;
  color: string;
  title: string;
  style?: "solid" | "dashed" | "dotted";
  draggable?: boolean;
}

export interface ChartMarker {
  time: number;
  position: "aboveBar" | "belowBar" | "inBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  text?: string;
}

export interface ChartClick {
  price: number;
  time: number | null;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
}

export interface CandleChartHandle {
  setData(bars: Bar[], opts?: { keepView?: boolean }): void;
  update(bar: Bar): void;
  prepend(bars: Bar[]): void;
  oldestTime(): number | null;
  scrollToEnd(): void;
}

interface Props {
  tickSize: number;
  timeZone: string;
  lines?: ChartLine[];
  markers?: ChartMarker[];
  onLineDrag?: (id: string, price: number) => void;
  onLineDragEnd?: (id: string, price: number) => void;
  onChartClick?: (c: ChartClick) => void;
  /** Called when the user scrolls near the oldest loaded bar. */
  onNeedHistory?: (oldest: number) => void;
}

const toSec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted };
const GRAB_PX = 6;

export const CandleChart = forwardRef<CandleChartHandle, Props>(function CandleChart(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const barsRef = useRef<Bar[]>([]);
  const linesRef = useRef(new Map<string, { line: IPriceLine; spec: ChartLine }>());
  const dragRef = useRef<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current!;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0b0e13" }, textColor: "#8a94a3", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "#151a23" }, horzLines: { color: "#151a23" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#1f2632" },
      timeScale: { borderColor: "#1f2632", timeVisible: true, secondsVisible: false, rightOffset: 8 },
      localization: { timeFormatter: (t: Time) => fmtTime((t as number) * 1000, propsRef.current.timeZone) },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);

    chart.subscribeCrosshairMove((param) => {
      const legend = legendRef.current;
      if (!legend) return;
      const d = param.time ? (param.seriesData.get(series) as { open: number; high: number; low: number; close: number } | undefined) : undefined;
      const bar = d ?? barsRef.current[barsRef.current.length - 1];
      if (!bar) {
        legend.textContent = "";
        return;
      }
      const dec = decimalsOf(propsRef.current.tickSize);
      const f = (v: number) => v.toFixed(dec);
      const chg = ((bar.close - bar.open) / bar.open) * 100;
      legend.innerHTML = `O <b>${f(bar.open)}</b> H <b>${f(bar.high)}</b> L <b>${f(bar.low)}</b> C <b>${f(bar.close)}</b> <span style="color:${chg >= 0 ? "#26a69a" : "#ef5350"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span>`;
    });

    chart.subscribeClick((param) => {
      const cb = propsRef.current.onChartClick;
      if (!cb || !param.point) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price == null) return;
      const e = param.sourceEvent;
      cb({
        price: roundToStep(price, propsRef.current.tickSize),
        time: param.time ? (param.time as number) * 1000 : null,
        alt: !!e?.altKey,
        shift: !!e?.shiftKey,
        ctrl: !!(e?.ctrlKey || e?.metaKey),
      });
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      const cb = propsRef.current.onNeedHistory;
      if (!cb || !range || barsRef.current.length === 0) return;
      if (range.from < 30) cb(barsRef.current[0].time);
    });

    // Dragging price lines: intercept pointerdown before the chart starts panning.
    const nearestLine = (y: number) => {
      let best: { id: string; dist: number } | null = null;
      for (const [id, { spec }] of linesRef.current) {
        if (!spec.draggable) continue;
        const cy = series.priceToCoordinate(spec.price);
        if (cy == null) continue;
        const dist = Math.abs(cy - y);
        if (dist <= GRAB_PX && (!best || dist < best.dist)) best = { id, dist };
      }
      return best?.id ?? null;
    };
    const localY = (e: PointerEvent) => e.clientY - el.getBoundingClientRect().top;
    const priceAt = (e: PointerEvent) => {
      const p = series.coordinateToPrice(localY(e));
      return p == null ? null : roundToStep(p, propsRef.current.tickSize);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const id = nearestLine(localY(e));
      if (!id) return;
      dragRef.current = id;
      chart.applyOptions({ handleScroll: false, handleScale: false });
      e.stopPropagation();
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      const id = dragRef.current;
      if (!id) {
        if (e.target instanceof Node && el.contains(e.target)) el.style.cursor = nearestLine(localY(e)) ? "ns-resize" : "";
        return;
      }
      const price = priceAt(e);
      const entry = linesRef.current.get(id);
      if (price == null || price <= 0 || !entry) return;
      entry.spec = { ...entry.spec, price };
      entry.line.applyOptions({ price });
      propsRef.current.onLineDrag?.(id, price);
    };
    const onUp = () => {
      const id = dragRef.current;
      if (!id) return;
      dragRef.current = null;
      chart.applyOptions({ handleScroll: true, handleScale: true });
      const entry = linesRef.current.get(id);
      if (entry) propsRef.current.onLineDragEnd?.(id, entry.spec.price);
    };
    el.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);

    const lines = linesRef.current;
    return () => {
      el.removeEventListener("pointerdown", onDown, { capture: true });
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      lines.clear();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Price format follows the instrument's tick size.
  useEffect(() => {
    seriesRef.current?.applyOptions({
      priceFormat: { type: "price", precision: Math.min(decimalsOf(props.tickSize), 8), minMove: props.tickSize },
    });
  }, [props.tickSize]);

  useEffect(() => {
    chartRef.current?.applyOptions({ localization: { timeFormatter: (t: Time) => fmtTime((t as number) * 1000, props.timeZone) } });
  }, [props.timeZone]);

  // Diff price lines.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const next = new Map((props.lines ?? []).map((l) => [l.id, l]));
    for (const [id, { line }] of linesRef.current) {
      if (!next.has(id)) {
        series.removePriceLine(line);
        linesRef.current.delete(id);
      }
    }
    for (const [id, spec] of next) {
      const existing = linesRef.current.get(id);
      const opts = {
        price: spec.price,
        color: spec.color,
        title: spec.title,
        lineWidth: 1 as const,
        lineStyle: STYLE[spec.style ?? "solid"],
        axisLabelVisible: true,
      };
      if (existing) {
        if (dragRef.current === id) continue; // don't fight the user's drag
        existing.line.applyOptions(opts);
        existing.spec = spec;
      } else {
        linesRef.current.set(id, { line: series.createPriceLine(opts), spec });
      }
    }
  }, [props.lines]);

  useEffect(() => {
    const m: SeriesMarker<Time>[] = (props.markers ?? [])
      .map((mk) => ({ time: toSec(mk.time), position: mk.position, color: mk.color, shape: mk.shape, text: mk.text }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    markersRef.current?.setMarkers(m);
  }, [props.markers]);

  useImperativeHandle(
    ref,
    () => ({
      setData(bars, opts) {
        barsRef.current = bars;
        const ts = chartRef.current?.timeScale();
        const range = opts?.keepView ? ts?.getVisibleLogicalRange() : null;
        seriesRef.current?.setData(bars.map((b) => ({ time: toSec(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
        if (range) ts?.setVisibleLogicalRange(range);
        else if (bars.length) ts?.setVisibleLogicalRange({ from: Math.max(0, bars.length - 150), to: bars.length + 8 });
      },
      update(bar) {
        const bars = barsRef.current;
        const last = bars[bars.length - 1];
        if (last && bar.time < last.time) return;
        if (last && last.time === bar.time) bars[bars.length - 1] = bar;
        else bars.push(bar);
        seriesRef.current?.update({ time: toSec(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
      },
      prepend(older) {
        const first = barsRef.current[0]?.time ?? Infinity;
        const add = older.filter((b) => b.time < first);
        if (!add.length) return;
        const ts = chartRef.current?.timeScale();
        const range = ts?.getVisibleLogicalRange();
        barsRef.current = [...add, ...barsRef.current];
        seriesRef.current?.setData(barsRef.current.map((b) => ({ time: toSec(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
        if (range) ts?.setVisibleLogicalRange({ from: range.from + add.length, to: range.to + add.length });
      },
      oldestTime() {
        return barsRef.current[0]?.time ?? null;
      },
      scrollToEnd() {
        chartRef.current?.timeScale().scrollToRealTime();
      },
    }),
    [],
  );

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      <div ref={legendRef} className="num pointer-events-none absolute left-2 top-1.5 z-10 text-[11px] text-muted [&_b]:font-normal [&_b]:text-ink" />
    </div>
  );
});

