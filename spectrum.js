const NS = "http://www.w3.org/2000/svg";

export const STATE_COLORS = {
  CT: "#f5c542",
  MA: "#5b9dff",
  ME: "#3dd68c",
  NH: "#c084fc",
  RI: "#fb7185",
  VT: "#2dd4bf",
  NY: "#fb923c",
  NJ: "#818cf8",
};

export const MODE_COLORS = {
  FM: "#7dd3fc",
  NFM: "#38bdf8",
  DMR: "#fb923c",
  "D-STAR": "#a78bfa",
  YSF: "#34d399",
  P25: "#f472b6",
  NXDN: "#facc15",
  M17: "#d6d3d1",
};

function kindFill(kind) {
  return `var(--kind-${kind})`;
}

function markerStroke(kind) {
  return `var(--marker-${kind || "call"})`;
}

function svg(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

export function formatMHz(hz, digits = 3) {
  return (hz / 1_000_000).toFixed(digits);
}

export function formatOffset(offsetHz, raw) {
  if (offsetHz == null) return raw || "unknown";
  const sign = offsetHz >= 0 ? "+" : "−";
  const abs = Math.abs(offsetHz);
  if (abs >= 1_000_000) return `${sign}${abs / 1_000_000} MHz`;
  if (abs >= 1000) return `${sign}${abs / 1000} kHz`;
  return `${sign}${abs} Hz`;
}

function niceStep(spanHz) {
  if (spanHz <= 80_000) return 5_000;
  if (spanHz <= 200_000) return 10_000;
  if (spanHz <= 500_000) return 20_000;
  if (spanHz <= 1_200_000) return 50_000;
  if (spanHz <= 2_500_000) return 100_000;
  if (spanHz <= 6_000_000) return 200_000;
  if (spanHz <= 15_000_000) return 500_000;
  if (spanHz <= 40_000_000) return 1_000_000;
  return 2_000_000;
}

function chipColor(item, colorBy) {
  if (colorBy === "mode") {
    const preferred = item.modes.find((mode) => mode !== "FM") || item.modes[0];
    return MODE_COLORS[preferred] || "#94a3b8";
  }
  return STATE_COLORS[item.state] || "#94a3b8";
}

export function marksFromItems(items, pairMode) {
  const marks = [];
  for (const item of items) {
    if (pairMode !== "input") {
      marks.push({ item, role: "output", markHz: item.freqHz });
    }
    if (pairMode !== "output" && item.inputHz != null) {
      marks.push({ item, role: "input", markHz: item.inputHz });
    }
  }
  return marks;
}

function packLanes(marks) {
  const groups = new Map();
  for (const mark of marks) {
    const key = mark.markHz;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(mark);
  }
  let maxLane = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => (
      a.item.state.localeCompare(b.item.state)
      || a.item.city.localeCompare(b.item.city)
      || a.item.call.localeCompare(b.item.call)
      || a.role.localeCompare(b.role)
    ));
    group.forEach((mark, index) => {
      mark.lane = index;
    });
    maxLane = Math.max(maxLane, group.length);
  }
  return { groups, maxLane };
}

export class SpectrumRuler {
  constructor(host, options) {
    this.host = host;
    this.mode = options.mode || "detail";
    this.band = options.band;
    this.channelWidthHz = options.band.channelWidthHz || 15_000;
    this.minSpanHz = options.band.minSpanHz || options.minSpanHz || 50_000;
    this.colorBy = "state";
    this.pairMode = options.pairMode || "both";
    this.items = [];
    this.selectedId = null;
    this.hoverId = null;
    this.view = { startHz: options.band.minHz, endHz: options.band.maxHz };
    this._drag = null;
    this._width = 0;
    this._height = 0;

    this.svg = svg("svg", { class: `ruler ${this.mode}` });
    this.host.replaceChildren(this.svg);

    this.svg.addEventListener("wheel", (event) => this._onWheel(event), { passive: false });
    this.svg.addEventListener("pointerdown", (event) => this._onPointerDown(event));
    this.svg.addEventListener("pointermove", (event) => this._onPointerMove(event));
    this.svg.addEventListener("pointerup", (event) => this._onPointerUp(event));
    this.svg.addEventListener("pointerleave", () => this._emit("hover", { id: null, clientX: 0, clientY: 0, hz: null }));
    this.svg.addEventListener("dblclick", () => this.resetView());
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(this.host);
  }

  setItems(items) {
    this.items = items;
    this.render();
  }

  setColorBy(value) {
    this.colorBy = value;
    this.render();
  }

  setPairMode(value) {
    this.pairMode = value;
    this.render();
  }

  setBand(band) {
    this.band = band;
    this.channelWidthHz = band.channelWidthHz || 15_000;
    this.minSpanHz = band.minSpanHz || 50_000;
    this.resetView();
  }

  setSelection(id) {
    this.selectedId = id;
    this.render();
  }

  setView(startHz, endHz) {
    this.view = this._clampView(startHz, endHz);
    this.render();
  }

  resetView() {
    this.setView(this.band.minHz, this.band.maxHz);
    this._emit("view", this.view);
  }

  _clampView(startHz, endHz) {
    const min = this.band.minHz;
    const max = this.band.maxHz;
    let start = startHz;
    let end = endHz;
    if (end - start < this.minSpanHz) {
      const mid = (start + end) / 2;
      start = mid - this.minSpanHz / 2;
      end = mid + this.minSpanHz / 2;
    }
    if (end - start > max - min) {
      return { startHz: min, endHz: max };
    }
    if (start < min) {
      end += min - start;
      start = min;
    }
    if (end > max) {
      start -= end - max;
      end = max;
    }
    return { startHz: Math.max(min, start), endHz: Math.min(max, end) };
  }

  _x(hz) {
    const span = this.view.endHz - this.view.startHz;
    return ((hz - this.view.startHz) / span) * this._width;
  }

  _hzAt(clientX) {
    const rect = this.svg.getBoundingClientRect();
    const x = clientX - rect.left;
    if (this.mode === "overview") {
      return this.band.minHz + (x / this._width) * (this.band.maxHz - this.band.minHz);
    }
    const span = this.view.endHz - this.view.startHz;
    return this.view.startHz + (x / this._width) * span;
  }

  _onWheel(event) {
    if (this.mode !== "detail") return;
    event.preventDefault();
    const hz = this._hzAt(event.clientX);
    const factor = Math.exp(-event.deltaY * 0.0015);
    const span = this.view.endHz - this.view.startHz;
    const nextSpan = span / factor;
    const ratio = (hz - this.view.startHz) / span;
    this.setView(hz - nextSpan * ratio, hz + nextSpan * (1 - ratio));
    this._emit("view", this.view);
  }

  _onPointerDown(event) {
    const chip = event.target.closest("[data-id]");
    if (chip && this.mode === "detail") {
      this._emit("select", { id: chip.getAttribute("data-id") });
      return;
    }
    this.svg.setPointerCapture(event.pointerId);
    if (this.mode === "overview") {
      const hz = this._hzAt(event.clientX);
      const span = this.view.endHz - this.view.startHz;
      this.setView(hz - span / 2, hz + span / 2);
      this._emit("view", this.view);
      this._drag = { kind: "overview", x: event.clientX, start: this.view.startHz, end: this.view.endHz };
      return;
    }
    this._drag = { kind: "pan", x: event.clientX, start: this.view.startHz, end: this.view.endHz };
  }

  _onPointerMove(event) {
    const hz = this._width ? this._hzAt(event.clientX) : null;
    const chip = event.target.closest("[data-id]");
    this._emit("hover", {
      id: chip ? chip.getAttribute("data-id") : null,
      role: chip ? chip.getAttribute("data-role") : null,
      clientX: event.clientX,
      clientY: event.clientY,
      hz,
    });
    if (!this._drag) return;
    const dx = event.clientX - this._drag.x;
    const scale = this._drag.kind === "overview"
      ? (this.band.maxHz - this.band.minHz)
      : (this._drag.end - this._drag.start);
    const deltaHz = (-dx / this._width) * scale;
    this.setView(this._drag.start + deltaHz, this._drag.end + deltaHz);
    this._emit("view", this.view);
  }

  _onPointerUp() {
    this._drag = null;
  }

  _emit(name, detail) {
    this.host.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  render() {
    const width = Math.max(this.host.clientWidth, 40);
    const height = Math.min(
      1200,
      Math.max(this.host.clientHeight, this.mode === "overview" ? 48 : 200),
    );
    this._width = width;
    this._height = height;
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.svg.replaceChildren();

    if (this.mode === "overview") {
      this._renderOverview(width, height);
      return;
    }
    this._renderDetail(width, height);
  }

  _renderOverview(width, height) {
    const marks = marksFromItems(this.items, this.pairMode);
    const { groups, maxLane } = packLanes(marks);
    const fullStart = this.band.minHz;
    const fullEnd = this.band.maxHz;
    const x = (hz) => ((hz - fullStart) / (fullEnd - fullStart)) * width;

    this._drawBandplan(this.svg, x, 0, height);
    this._drawMarkers(this.svg, x, 0, height, false);

    for (const [freqHz, group] of groups) {
      const barH = Math.max(4, (group.length / Math.max(maxLane, 1)) * (height - 8));
      const hasOutput = group.some((mark) => mark.role === "output");
      svg("rect", {
        x: x(freqHz) - 1,
        y: height - 4 - barH,
        width: 2,
        height: barH,
        fill: hasOutput ? "var(--minimap-bar)" : "var(--minimap-input)",
        opacity: 0.7,
      }, this.svg);
    }

    const vx = x(this.view.startHz);
    const vw = Math.max(8, x(this.view.endHz) - vx);
    svg("rect", {
      x: vx,
      y: 1,
      width: vw,
      height: height - 2,
      fill: "var(--viewport-fill)",
      stroke: "var(--viewport-stroke)",
      "stroke-width": 1.5,
    }, this.svg);
  }

  _renderDetail(width, height) {
    const top = 36;
    const bottom = 28;
    const plotH = height - top - bottom;
    const x = (hz) => this._x(hz);

    this._drawBandplan(this.svg, x, 0, height);
    this._drawPlanLabels(this.svg, x, 16);
    this._drawTicks(this.svg, x, top, height - bottom);
    this._drawMarkers(this.svg, x, 0, height - bottom, true);

    const marks = marksFromItems(this.items, this.pairMode).filter((mark) => {
      const half = this.channelWidthHz / 2;
      return mark.markHz + half >= this.view.startHz && mark.markHz - half <= this.view.endHz;
    });
    const { maxLane } = packLanes(marks);
    const laneH = Math.min(24, Math.max(15, plotH / Math.max(maxLane, 8)));
    const originY = top + plotH;

    const selected = this.items.find((item) => item.id === this.selectedId);
    if (selected && selected.inputHz != null) {
      const selectedMark = marks.find((mark) => mark.item.id === this.selectedId) || { lane: 0 };
      this._drawDuplex(this.svg, selected, selectedMark.lane || 0, x, originY, laneH);
    }

    const chips = svg("g", { class: "chips" }, this.svg);
    const ordered = [...marks].sort((a, b) => Number(a.item.id === this.selectedId) - Number(b.item.id === this.selectedId));
    for (const mark of ordered) {
      this._drawChip(chips, mark, x, originY, laneH, mark.item.id === this.selectedId);
    }

    const axis = svg("g", { class: "axis" }, this.svg);
    svg("line", { x1: 0, x2: width, y1: height - bottom, y2: height - bottom, stroke: "var(--axis)" }, axis);
  }

  _drawBandplan(parent, x, y, height) {
    const clipStart = this.mode === "overview" ? this.band.minHz : this.view.startHz;
    const clipEnd = this.mode === "overview" ? this.band.maxHz : this.view.endHz;
    for (const segment of this.band.segments) {
      const start = Math.max(segment.startHz, clipStart);
      const end = Math.min(segment.endHz, clipEnd);
      if (end <= start) continue;
      svg("rect", {
        x: x(start),
        y,
        width: Math.max(0.5, x(end) - x(start)),
        height,
        fill: kindFill(segment.kind),
      }, parent);
    }
  }

  _drawMarkers(parent, x, y, bottom, withLabels) {
    const clipStart = this.mode === "overview" ? this.band.minHz : this.view.startHz;
    const clipEnd = this.mode === "overview" ? this.band.maxHz : this.view.endHz;
    const span = clipEnd - clipStart;
    const markers = (this.band.markers || [])
      .filter((marker) => marker.hz >= clipStart && marker.hz <= clipEnd)
      .sort((a, b) => a.hz - b.hz);
    const placed = [];
    for (const marker of markers) {
      const px = x(marker.hz);
      const group = svg("g", { class: "marker", "data-marker": marker.short || marker.label }, parent);
      const tip = svg("title", {}, group);
      tip.textContent = marker.label;
      svg("line", {
        x1: px,
        x2: px,
        y1: y,
        y2: bottom,
        stroke: markerStroke(marker.kind),
        "stroke-dasharray": "3 4",
        "stroke-width": 1.15,
      }, group);
      if (!withLabels) continue;
      const text = span < 1_500_000 ? marker.label : (marker.short || marker.label);
      const width = text.length * 6.1;
      let lane = 0;
      while (placed.some((prev) => Math.abs(prev.px - px) < (prev.width + width) / 2 + 10 && prev.lane === lane)) {
        lane += 1;
      }
      placed.push({ px, lane, width });
      const label = svg("text", {
        x: px + 5,
        y: 28 + lane * 11,
        fill: markerStroke(marker.kind),
        "font-size": 10,
        "font-weight": 600,
        "font-family": "ui-sans-serif, system-ui, sans-serif",
        "pointer-events": "none",
      }, group);
      label.textContent = text;
    }
  }

  _drawPlanLabels(parent, x, y) {
    for (const segment of this.band.segments) {
      if (!segment.label) continue;
      const start = Math.max(segment.startHz, this.view.startHz);
      const end = Math.min(segment.endHz, this.view.endHz);
      const mid = x((start + end) / 2);
      const wide = x(end) - x(start);
      if (wide < 48) continue;
      const label = svg("text", {
        x: mid,
        y,
        fill: "var(--plan-label)",
        "font-size": 10,
        "text-anchor": "middle",
        "font-family": "ui-sans-serif, system-ui, sans-serif",
      }, parent);
      label.textContent = segment.label;
    }
  }

  _drawTicks(parent, x, top, axisY) {
    const step = niceStep(this.view.endHz - this.view.startHz);
    const majorEvery = step >= 100_000 ? 5 : 4;
    const first = Math.ceil(this.view.startHz / step) * step;
    for (let hz = first; hz <= this.view.endHz; hz += step) {
      const px = x(hz);
      const major = Math.round(hz / step) % majorEvery === 0;
      svg("line", {
        x1: px,
        x2: px,
        y1: major ? top - 8 : top - 4,
        y2: axisY,
        stroke: major ? "var(--tick-major)" : "var(--tick-minor)",
      }, parent);
      if (!major) continue;
      const digits = step >= 1_000_000 ? 0 : step >= 100_000 ? 1 : 3;
      const label = svg("text", {
        x: px,
        y: axisY + 16,
        fill: "var(--axis-label)",
        "font-size": 11,
        "text-anchor": "middle",
        "font-family": 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }, parent);
      label.textContent = formatMHz(hz, hz % 1_000_000 === 0 ? 0 : digits);
    }
  }

  _drawDuplex(parent, item, lane, x, originY, laneH) {
    const y = originY - lane * laneH - laneH / 2;
    const xOut = x(item.freqHz);
    const xIn = x(item.inputHz);
    const peak = 52;
    const path = `M ${xOut} ${y} C ${xOut} ${peak}, ${xIn} ${peak}, ${xIn} ${y}`;
    svg("path", {
      d: path,
      fill: "none",
      stroke: chipColor(item, this.colorBy),
      "stroke-width": 1.4,
      opacity: 0.85,
    }, parent);
    if (this.pairMode === "both") return;
    const half = this.channelWidthHz / 2;
    const ghostHz = this.pairMode === "output" ? item.inputHz : item.freqHz;
    svg("rect", {
      x: x(ghostHz - half),
      y: originY - (lane + 1) * laneH + 2,
      width: Math.max(3, x(ghostHz + half) - x(ghostHz - half)),
      height: laneH - 5,
      fill: "none",
      stroke: chipColor(item, this.colorBy),
      "stroke-dasharray": "3 3",
      opacity: 0.9,
      rx: 3,
    }, parent);
  }

  _drawChip(parent, mark, x, originY, laneH, selected = false) {
    const item = mark.item;
    const half = this.channelWidthHz / 2;
    const x0 = x(mark.markHz - half);
    const w = Math.max(2.5, x(mark.markHz + half) - x0);
    const y = originY - (mark.lane + 1) * laneH + 2;
    const h = laneH - 5;
    const color = chipColor(item, this.colorBy);
    const isInput = mark.role === "input";
    const group = svg("g", { "data-id": item.id, "data-role": mark.role, style: "cursor:pointer" }, parent);
    svg("rect", {
      x: x0 - 3,
      y,
      width: w + 6,
      height: h,
      fill: "transparent",
    }, group);
    svg("rect", {
      x: x0,
      y,
      width: w,
      height: h,
      fill: isInput ? "none" : color,
      opacity: item.status === "OFF" ? 0.35 : selected ? 1 : 0.86,
      stroke: selected ? "var(--chip-selected)" : isInput ? color : "var(--chip-edge)",
      "stroke-width": selected ? 1.6 : isInput ? 1.4 : 0.6,
      "stroke-dasharray": isInput ? "3 2" : null,
      rx: 3,
    }, group);

    if (w >= 34) {
      const flip = x0 + Math.max(w, 80) > this._width - 8;
      const label = svg("text", {
        x: flip ? x0 + w - 4 : x0 + 4,
        y: y + h - 4,
        fill: isInput ? color : "var(--chip-ink)",
        "font-size": Math.min(11, h - 3),
        "font-family": "ui-sans-serif, system-ui, sans-serif",
        "text-anchor": flip ? "end" : "start",
        "pointer-events": "none",
      }, group);
      const name = w >= 88 ? `${item.call} · ${item.city}` : item.call;
      label.textContent = isInput ? `IN ${name}` : name;
    }
  }
}
