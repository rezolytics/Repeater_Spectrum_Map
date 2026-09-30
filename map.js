import { STATE_COLORS, MODE_COLORS, formatMHz } from "./spectrum.js";

const DEFAULT_BOUNDS = [[40.95, -73.75], [47.45, -66.95]];

function siteKey(city, state) {
  return `${city}|${state}`;
}

function chipColor(item, colorBy) {
  if (colorBy === "mode") return MODE_COLORS[item.modes[0]] || "#94a3b8";
  return STATE_COLORS[item.state] || "#94a3b8";
}

export class RepeaterMap {
  constructor(host, locations, bounds = DEFAULT_BOUNDS) {
    this.host = host;
    this.locations = locations?.sites || {};
    this.bounds = bounds;
    this.items = [];
    this.colorBy = "state";
    this.selectedId = null;
    this.onSelect = null;
    this._markers = [];
    this._tile = null;
    this._fitted = false;
    this._map = L.map(host, {
      zoomControl: true,
      attributionControl: true,
    });
    this._map.fitBounds(bounds);
    this._applyTiles();
    this._map.on("click", () => {
      if (this.onSelect) this.onSelect(null);
    });
  }

  lookup(city, state) {
    return this.locations[siteKey(city, state)] || null;
  }

  setLocations(locations) {
    this.locations = locations?.sites || {};
  }

  setBounds(bounds) {
    this.bounds = bounds?.length ? bounds : DEFAULT_BOUNDS;
  }

  setColorBy(value) {
    this.colorBy = value;
  }

  setItems(items) {
    this.items = items;
    this.render();
  }

  setSelection(id, { pan = false } = {}) {
    this.selectedId = id;
    this._styleMarkers();
    if (!pan || !id) return;
    const item = this.items.find((row) => row.id === id);
    const site = item ? this.lookup(item.city, item.state) : null;
    if (site) this._map.panTo([site.lat, site.lon], { animate: true });
  }

  resetView() {
    this._fitData();
  }

  invalidate() {
    this._map.invalidateSize();
    if (!this._fitted) {
      this._fitData();
      this._fitted = true;
    }
  }

  _fitData() {
    if (this._markers.length) {
      this._map.fitBounds(L.featureGroup(this._markers).getBounds().pad(0.12), { maxZoom: 8 });
      return;
    }
    this._map.fitBounds(this.bounds);
  }

  applyTheme() {
    this._applyTiles();
  }

  missingCount(items = this.items) {
    return items.filter((item) => !this.lookup(item.city, item.state)).length;
  }

  _applyTiles() {
    if (this._tile) this._map.removeLayer(this._tile);
    this._tile = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
      maxZoom: 18,
    }).addTo(this._map);
  }

  render() {
    for (const marker of this._markers) marker.remove();
    this._markers = [];

    const groups = new Map();
    for (const item of this.items) {
      const site = this.lookup(item.city, item.state);
      if (!site) continue;
      const key = `${site.lat},${site.lon}`;
      if (!groups.has(key)) groups.set(key, { site, items: [] });
      groups.get(key).items.push(item);
    }

    for (const group of groups.values()) {
      const marker = L.circleMarker([group.site.lat, group.site.lon]);
      marker._group = group;
      marker.bindTooltip(this._tooltip(group), { direction: "top", offset: [0, -6], opacity: 0.95 });
      marker.bindPopup(() => this._popup(group), { closeButton: true });
      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event);
        const pick = group.items.find((item) => item.id === this.selectedId) || group.items[0];
        if (this.onSelect) this.onSelect(pick.id);
      });
      marker.on("popupopen", () => {
        const root = marker.getPopup()?.getElement();
        if (!root) return;
        root.querySelectorAll("button[data-id]").forEach((button) => {
          button.addEventListener("click", (event) => {
            event.preventDefault();
            L.DomEvent.stopPropagation(event);
            if (this.onSelect) this.onSelect(button.dataset.id);
          });
        });
      });
      marker.addTo(this._map);
      this._markers.push(marker);
    }
    this._styleMarkers();
  }

  _styleMarkers() {
    for (const marker of this._markers) {
      const group = marker._group;
      const selected = group.items.some((item) => item.id === this.selectedId);
      const color = chipColor(group.items[0], this.colorBy);
      const count = group.items.length;
      marker.setStyle({
        radius: selected ? 10 : Math.min(9, 4 + Math.sqrt(count) * 1.6),
        color: selected ? "#f8fafc" : color,
        weight: selected ? 3 : 1.4,
        fillColor: color,
        fillOpacity: selected ? 0.95 : 0.78,
      });
      marker.setTooltipContent(this._tooltip(group));
    }
  }

  _tooltip(group) {
    const names = group.items.slice(0, 6).map((item) => `${item.call} · ${formatMHz(item.freqHz)}`);
    const extra = group.items.length > 6 ? `<br>+${group.items.length - 6} more` : "";
    return `<strong>${group.site.label}</strong>${group.items.length} system${group.items.length === 1 ? "" : "s"}<br>${names.join("<br>")}${extra}`;
  }

  _popup(group) {
    const rows = group.items.map((item) => {
      const current = item.id === this.selectedId ? " aria-current=\"true\"" : "";
      return `<button type="button" data-id="${item.id}"${current}>${item.call} · ${formatMHz(item.freqHz)} · ${item.modes.join("/") || "n/a"}</button>`;
    });
    return `<div class="map-popup"><strong>${group.site.label}</strong>${rows.join("")}</div>`;
  }
}
