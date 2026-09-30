import { SpectrumRuler, formatMHz, formatOffset, MODE_COLORS } from "./spectrum.js";
import { RepeaterMap } from "./map.js";

let regionCatalog = [];
let sourceCatalog = [];
let region = null;

const state = {
  bandId: "2m",
  pairMode: "both",
  colorBy: "state",
  hideOff: false,
  query: "",
  states: new Set(),
  areas: new Set(),
  modes: new Set(),
  selectedId: null,
  view: "spectrum",
};

function activeStates() {
  return region?.states?.length ? region.states : [];
}

function $(id) {
  return document.getElementById(id);
}

function allModes(repeaters) {
  const set = new Set();
  for (const item of repeaters) {
    for (const mode of item.modes) set.add(mode);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function matches(item) {
  if (!state.states.has(item.state)) return false;
  if (region?.areas?.length && item.sourceIds?.length && !item.sourceIds.some((id) => state.areas.has(id))) return false;
  if (state.hideOff && item.status === "OFF") return false;
  if (state.modes.size && !item.modes.some((mode) => state.modes.has(mode))) return false;
  const query = state.query.trim().toLowerCase();
  if (!query) return true;
  const hay = [
    item.call,
    item.city,
    item.state,
    item.county,
    item.freq.toFixed(4),
    formatMHz(item.freqHz, 3),
    item.inputHz != null ? formatMHz(item.inputHz, 4) : "",
    item.comments,
  ].join(" ").toLowerCase();
  return hay.includes(query);
}

function makeChip(label, pressed, attrs = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
  for (const [key, value] of Object.entries(attrs)) button.setAttribute(key, value);
  return button;
}

function renderBandTabs(bands) {
  const host = $("band-tabs");
  host.replaceChildren();
  for (const band of bands) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.band = band.id;
    button.textContent = band.label;
    button.title = `${band.name} · ${band.rangeLabel}`;
    if (band.id === state.bandId) {
      button.classList.add("active");
      button.setAttribute("aria-current", "page");
    }
    button.addEventListener("click", () => switchBand(band.id));
    host.appendChild(button);
  }
}

function renderFilters(repeaters) {
  const stateHost = $("state-filters");
  stateHost.replaceChildren();
  for (const code of activeStates()) {
    const button = makeChip(code, state.states.has(code), { "data-state": code });
    button.addEventListener("click", () => {
      if (state.states.has(code)) state.states.delete(code);
      else state.states.add(code);
      if (state.states.size === 0) activeStates().forEach((item) => state.states.add(item));
      sync();
    });
    stateHost.appendChild(button);
  }

  const areaHost = $("area-filters");
  areaHost.replaceChildren();
  const areas = region?.areas || [];
  areaHost.hidden = areas.length === 0;
  for (const area of areas) {
    const button = makeChip(area.label, state.areas.has(area.id), { "data-area": area.id });
    button.addEventListener("click", () => {
      if (state.areas.has(area.id)) state.areas.delete(area.id);
      else state.areas.add(area.id);
      if (state.areas.size === 0) areas.forEach((item) => state.areas.add(item.id));
      sync();
    });
    areaHost.appendChild(button);
  }

  const modeHost = $("mode-filters");
  modeHost.replaceChildren();
  for (const mode of allModes(repeaters)) {
    const button = makeChip(mode, state.modes.size === 0 || state.modes.has(mode));
    button.style.setProperty("--swatch", MODE_COLORS[mode] || "#94a3b8");
    button.addEventListener("click", () => {
      if (state.modes.has(mode)) state.modes.delete(mode);
      else state.modes.add(mode);
      sync();
    });
    modeHost.appendChild(button);
  }
}

function renderStats(source, visible) {
  const channels = new Set(visible.map((item) => item.freqHz)).size;
  const label = source.sourceLabel || region?.statsLabel || "public CSV";
  $("stats").textContent = `${visible.length} of ${source.count} systems · ${channels} channels · ${label}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function pill(text, className = "pill") {
  return el("span", className, text);
}

function renderDetail(item) {
  const host = $("detail");
  host.replaceChildren();
  if (!item) {
    host.appendChild(el("p", "detail-empty", "Click a repeater to see call, tones, offset, and the input/output pair."));
    return;
  }

  const card = el("div", "detail-card");
  const left = el("div");
  left.appendChild(el("h2", "", item.call || "Unknown"));
  const pair = el("p", "pair");
  const out = el("strong", "", formatMHz(item.freqHz));
  pair.append(out, document.createTextNode(item.inputHz == null ? " output → unknown input" : ` output → ${formatMHz(item.inputHz)} MHz`));
  left.appendChild(pair);
  left.appendChild(el("p", "meta", formatOffset(item.offsetHz, item.offset)));

  const right = el("div");
  right.appendChild(el("p", "meta", `${item.city}, ${item.state}${item.county ? ` · ${item.county} County` : ""}`));
  right.appendChild(el("p", "meta", item.voip ? `VoIP ${item.voip.replaceAll("\n", " ")}` : "No VoIP listed"));
  right.appendChild(el("p", "meta", `${item.comments || "No comments"}${item.updated ? ` · updated ${item.updated}` : ""}`));
  const sourceIds = item.sourceIds?.length ? item.sourceIds : [];
  if (sourceIds.length) {
    const line = el("p", "meta");
    line.append("Plotted from ");
    sourceIds.forEach((id, index) => {
      if (index) line.append(" and ");
      const listed = sourceCatalog.find((entry) => entry.id === id);
      if (!listed) {
        line.append(id);
        return;
      }
      const link = document.createElement("a");
      link.href = listed.href;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = listed.label;
      line.append(link);
    });
    right.appendChild(line);
  }
  if (item.remoteRx?.length) {
    right.appendChild(el(
      "p",
      "meta",
      `Remote RX: ${item.remoteRx.map((rx) => `${rx.city}, ${rx.state}${rx.toneIn ? ` (${rx.toneIn})` : ""}`).join(" · ")}`,
    ));
  }
  const pills = el("div", "pills");
  for (const mode of item.modes) pills.appendChild(pill(mode));
  if (item.status) pills.appendChild(pill(item.status, `pill ${item.status === "OFF" ? "off" : "local"}`));
  if (item.toneIn) pills.appendChild(pill(`IN ${item.toneIn.replaceAll("\n", " / ")}`));
  if (item.toneOut) pills.appendChild(pill(`OUT ${item.toneOut.replaceAll("\n", " / ")}`));
  right.appendChild(pills);
  card.append(left, right);
  host.appendChild(card);
}

function updateFilterButtons() {
  for (const button of $("state-filters").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", state.states.has(button.dataset.state) ? "true" : "false");
  }
  for (const button of $("mode-filters").querySelectorAll("button")) {
    const on = state.modes.size === 0 || state.modes.has(button.textContent);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
  for (const button of $("pair-mode").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", button.dataset.pair === state.pairMode ? "true" : "false");
  }
  for (const button of $("area-filters").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", state.areas.has(button.dataset.area) ? "true" : "false");
  }
}

function byId(repeaters, id) {
  return repeaters.find((item) => item.id === id) || null;
}

function nearestMarker(band, hz) {
  if (hz == null || !band?.markers?.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const marker of band.markers) {
    const delta = Math.abs(marker.hz - hz);
    if (delta < bestD) {
      best = marker;
      bestD = delta;
    }
  }
  const threshold = Math.max(band.channelWidthHz * 3, (band.maxHz - band.minHz) * 0.003);
  return bestD <= threshold ? best : null;
}

function tooltipHtml(item, hz, role, band) {
  if (!item) {
    const marker = nearestMarker(band, hz);
    if (marker) return `<strong>${formatMHz(marker.hz)} MHz</strong>${marker.label}`;
    return hz == null ? "" : `<strong>${formatMHz(hz)} MHz</strong>`;
  }
  const freq = role === "input" && item.inputHz != null ? item.inputHz : item.freqHz;
  const tag = role === "input" ? "input" : "output";
  return `<strong>${item.call} · ${formatMHz(freq)} ${tag}</strong>${item.city}, ${item.state} · ${(item.modes.join(" / ") || "mode n/a")}${item.status ? ` · ${item.status}` : ""}`;
}

function placeTooltip(tip, clientX, clientY) {
  const pad = 12;
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  let left = clientX + 14;
  let top = clientY + 14;
  if (left + width > window.innerWidth - pad) left = clientX - width - 14;
  if (left < pad) left = pad;
  if (top + height > window.innerHeight - pad) top = clientY - height - 14;
  if (top < pad) top = pad;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

const EDGE_PAD_HZ = 1_000_000;

function withEdgePad(band) {
  const pad = band.edgePadHz ?? EDGE_PAD_HZ;
  return {
    ...band,
    minHz: band.minHz - pad,
    maxHz: band.maxHz + pad,
    segments: [
      { startHz: band.minHz - pad, endHz: band.minHz, id: `${band.id}-oob-lo`, label: "Out of band", kind: "oob" },
      ...band.segments,
      { startHz: band.maxHz, endHz: band.maxHz + pad, id: `${band.id}-oob-hi`, label: "Out of band", kind: "oob" },
    ],
  };
}

function currentBand(catalog) {
  return withEdgePad(catalog.find((band) => band.id === state.bandId) || catalog[0]);
}

function currentSource(catalogData) {
  return catalogData.bands[state.bandId];
}

let switchBand = () => {};
let sync = () => {};

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.statusText}`);
  return res.json();
}

function initialRegionId() {
  const hash = location.hash.replace(/^#/, "");
  if (regionCatalog.some((item) => item.id === hash)) return hash;
  const saved = localStorage.getItem("spectrum-region");
  if (regionCatalog.some((item) => item.id === saved)) return saved;
  return regionCatalog[0]?.id;
}

function markActiveSources() {
  const active = new Set(region?.sourceIds || []);
  for (const item of document.querySelectorAll("#source-files [data-source]")) {
    const on = active.has(item.dataset.source);
    item.dataset.active = on ? "true" : "false";
    const badge = item.querySelector(".file-badge");
    if (badge) badge.hidden = !on;
  }
}

function renderRegionTabs() {
  for (const button of $("region-tabs").querySelectorAll("button")) {
    const on = button.dataset.region === region?.id;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

async function boot() {
  let catalogData;
  let listings;
  let locations = { sites: {} };
  try {
    const pack = await loadJson("data/regions.json");
    regionCatalog = pack.regions || [];
    sourceCatalog = pack.sources || [];
    catalogData = await loadJson("data/bands.json");
    region = regionCatalog.find((item) => item.id === initialRegionId()) || regionCatalog[0];
    listings = await loadJson(region.repeaters);
  } catch (error) {
    document.body.innerHTML = `<p class="error">Could not load local data. Serve this folder with <code>python3 -m http.server</code> instead of opening the HTML file directly.<br>${error}</p>`;
    return;
  }

  try {
    const res = await fetch(region.locations);
    if (res.ok) locations = await res.json();
  } catch {
    locations = { sites: {} };
  }

  let catalog = catalogData.bands.filter((band) => listings.bands?.[band.id]);
  if (!catalog.length) {
    document.body.innerHTML = `<p class="error">No band listings found. Run <code>python3 scripts/import_nerd.py</code> and <code>python3 scripts/import_nyrd.py</code>.</p>`;
    return;
  }
  state.states = new Set(activeStates());
  state.areas = new Set((region.areas || []).map((area) => area.id));
  if (!listings.bands[state.bandId]) state.bandId = catalog[0].id;

  renderBandTabs(catalog);
  renderFilters(currentSource(listings).repeaters);
  markActiveSources();
  renderRegionTabs();

  const spectrum = new SpectrumRuler($("spectrum"), { band: currentBand(catalog), mode: "detail", pairMode: state.pairMode });
  const minimap = new SpectrumRuler($("minimap"), { band: currentBand(catalog), mode: "overview", pairMode: state.pairMode });
  const geoMap = new RepeaterMap($("map"), locations, region.bounds);
  geoMap.onSelect = (id) => {
    state.selectedId = id && id === state.selectedId ? null : id;
    spectrum.setSelection(state.selectedId);
    geoMap.setSelection(state.selectedId, { pan: true });
    renderDetail(byId(currentSource(listings).repeaters, state.selectedId));
  };

  function applyView(view) {
    state.view = view;
    document.body.dataset.view = view;
    $("map").hidden = view !== "map";
    $("spectrum").hidden = view === "map";
    $("spectrum-hint").hidden = view !== "spectrum";
    $("map-hint").hidden = view !== "map";
    for (const button of $("view-tabs").querySelectorAll("button")) {
      button.setAttribute("aria-pressed", button.dataset.view === view ? "true" : "false");
    }
    if (view === "map") {
      requestAnimationFrame(() => requestAnimationFrame(() => geoMap.invalidate()));
    }
  }

  function applyBandChrome(band) {
    document.title = region.title || "Repeater Spectrum Map";
    $("eyebrow").textContent = `${region.name} · ${band.rangeLabel}`;
    $("map").setAttribute("aria-label", `${region.name} repeater map`);
    $("map-hint").textContent = region.mapHint || $("map-hint").textContent;
    $("spectrum").setAttribute("aria-label", `Zoomable ${band.name} frequency ruler`);
    $("minimap").setAttribute("aria-label", `Full ${band.name} band overview`);
    for (const button of $("band-tabs").querySelectorAll("button")) {
      const on = button.dataset.band === band.id;
      button.classList.toggle("active", on);
      if (on) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }

  sync = () => {
    const source = currentSource(listings);
    const visible = source.repeaters.filter(matches);
    if (state.selectedId && !visible.some((item) => item.id === state.selectedId)) {
      state.selectedId = null;
    }
    spectrum.setColorBy(state.colorBy);
    minimap.setColorBy(state.colorBy);
    spectrum.setPairMode(state.pairMode);
    minimap.setPairMode(state.pairMode);
    spectrum.setItems(visible);
    minimap.setItems(visible);
    geoMap.setColorBy(state.colorBy);
    geoMap.setItems(visible);
    spectrum.setSelection(state.selectedId);
    geoMap.setSelection(state.selectedId, { pan: false });
    updateFilterButtons();
    renderStats(source, visible);
    renderDetail(byId(source.repeaters, state.selectedId));
  };

  switchBand = (bandId) => {
    if (bandId === state.bandId) return;
    state.bandId = bandId;
    state.selectedId = null;
    state.modes = new Set();
    const band = currentBand(catalog);
    applyBandChrome(band);
    renderFilters(currentSource(listings).repeaters);
    spectrum.setBand(band);
    minimap.setBand(band);
    sync();
  };

  async function switchRegion(regionId) {
    const next = regionCatalog.find((item) => item.id === regionId);
    if (!next || next.id === region.id) return;
    region = next;
    localStorage.setItem("spectrum-region", region.id);
    if (location.hash !== `#${region.id}`) history.replaceState(null, "", `#${region.id}`);
    listings = await loadJson(region.repeaters);
    try {
      locations = await loadJson(region.locations);
    } catch {
      locations = { sites: {} };
    }
    catalog = catalogData.bands.filter((band) => listings.bands?.[band.id]);
    state.selectedId = null;
    state.modes = new Set();
    state.states = new Set(activeStates());
    state.areas = new Set((region.areas || []).map((area) => area.id));
    if (!listings.bands[state.bandId]) state.bandId = catalog[0]?.id;
    geoMap.setLocations(locations);
    geoMap.setBounds(region.bounds);
    renderRegionTabs();
    markActiveSources();
    renderBandTabs(catalog);
    const band = currentBand(catalog);
    applyBandChrome(band);
    renderFilters(currentSource(listings).repeaters);
    spectrum.setBand(band);
    minimap.setBand(band);
    sync();
    if (state.view === "map") geoMap.resetView();
  }

  applyBandChrome(currentBand(catalog));
  localStorage.setItem("spectrum-region", region.id);
  if (location.hash !== `#${region.id}`) history.replaceState(null, "", `#${region.id}`);

  $("spectrum").addEventListener("select", (event) => {
    state.selectedId = event.detail.id === state.selectedId ? null : event.detail.id;
    spectrum.setSelection(state.selectedId);
    geoMap.setSelection(state.selectedId, { pan: true });
    renderDetail(byId(currentSource(listings).repeaters, state.selectedId));
  });

  $("view-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button) return;
    applyView(button.dataset.view);
  });

  $("region-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-region]");
    if (!button) return;
    switchRegion(button.dataset.region);
  });

  window.addEventListener("hashchange", () => {
    const id = location.hash.replace(/^#/, "");
    if (id && id !== region.id) switchRegion(id);
  });

  const onView = (event) => {
    const { startHz, endHz } = event.detail;
    spectrum.setView(startHz, endHz);
    minimap.setView(startHz, endHz);
  };
  $("spectrum").addEventListener("view", onView);
  $("minimap").addEventListener("view", onView);

  const tip = $("tooltip");
  $("spectrum").addEventListener("hover", (event) => {
    const { id, role, clientX, clientY, hz } = event.detail;
    const item = byId(currentSource(listings).repeaters, id);
    const html = tooltipHtml(item, hz, role, currentBand(catalog));
    if (!html) {
      tip.hidden = true;
      return;
    }
    tip.hidden = false;
    tip.innerHTML = html;
    placeTooltip(tip, clientX, clientY);
  });

  $("hide-off").addEventListener("change", (event) => {
    state.hideOff = event.target.checked;
    sync();
  });
  $("search").addEventListener("input", (event) => {
    state.query = event.target.value;
    sync();
  });
  $("color-by").addEventListener("change", (event) => {
    state.colorBy = event.target.value;
    sync();
  });
  $("pair-mode").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-pair]");
    if (!button) return;
    state.pairMode = button.dataset.pair;
    sync();
  });
  $("reset-view").addEventListener("click", () => {
    if (state.view === "map") geoMap.resetView();
    else spectrum.resetView();
  });

  const themeToggle = $("theme-toggle");
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("spectrum-theme", theme);
    themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
    themeToggle.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
    spectrum.render();
    minimap.render();
    geoMap.applyTheme();
  }
  applyTheme(document.documentElement.dataset.theme || "dark");
  applyView(state.view);
  themeToggle.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      state.selectedId = null;
      spectrum.setSelection(null);
      geoMap.setSelection(null);
      renderDetail(null);
    }
    if (event.key === "0" && !event.metaKey && document.activeElement?.id !== "search") {
      if (state.view === "map") geoMap.resetView();
      else spectrum.resetView();
    }
  });

  sync();
}

boot();
