// Geometry-free Leaflet double. The quiz identifies hoods by
// `properties.name`, never by coordinates, and treats setView/fitBounds/
// getBounds as camera-only. So this fake carries no real polygons: map/tile
// methods are no-ops and each hood layer is a plain object the game mutates
// (`_locked`, `_revealed`) and styles (ignored here).
//
// Tests drive the game through the returned object's controls:
//   fireClick(name) / fireHover(name) / fireMouseout(name) — dispatch the
//     handlers the quiz registered via layer.on(...)
//   currentTarget() — the single hood the quiz has locked (NAME-mode answer)
//   layerFor(name) — the raw layer, for inspecting tooltip/_locked/_revealed

export function fakeLeaflet() {
  const layers = [];
  const byName = new Map();

  function makeLayer(feature) {
    return {
      feature,
      _handlers: {},
      _locked: false,
      _revealed: false,
      _tooltip: null,
      on(event, cb, opts) {
        (this._handlers[event] ||= []).push({ cb, once: !!(opts && opts.once) });
        return this;
      },
      setStyle() { return this; },
      bindTooltip(content, opts) { this._tooltip = { content, opts, open: false }; return this; },
      unbindTooltip() { this._tooltip = null; return this; },
      openTooltip() { if (this._tooltip) this._tooltip.open = true; return this; },
      getBounds() { return {}; },
    };
  }

  function fire(name, event) {
    const layer = byName.get(name);
    if (!layer) throw new Error(`fakeLeaflet: no hood named "${name}"`);
    const handlers = layer._handlers[event] || [];
    for (const h of [...handlers]) {
      h.cb();
      if (h.once) {
        layer._handlers[event] = (layer._handlers[event] || []).filter(x => x !== h);
      }
    }
  }

  const L = {
    map() {
      return {
        setView() { return this; },
        fitBounds() { return this; },
      };
    },
    tileLayer() {
      return { addTo() { return this; } };
    },
    geoJSON(geo, { onEachFeature } = {}) {
      (geo?.features || []).forEach(f => {
        const layer = makeLayer(f);
        byName.set(f.properties.name, layer);
        layers.push(layer);
        if (onEachFeature) onEachFeature(f, layer);
      });
      return {
        addTo() { return this; },
        eachLayer(cb) { layers.forEach(cb); },
      };
    },
  };

  L.fireClick = name => fire(name, 'click');
  L.fireHover = name => fire(name, 'mouseover');
  L.fireMouseout = name => fire(name, 'mouseout');
  L.currentTarget = () => {
    const locked = layers.filter(l => l._locked);
    return locked.length ? locked[locked.length - 1].feature.properties.name : null;
  };
  L.layerFor = name => byName.get(name);
  L.hoodNames = () => layers.map(l => l.feature.properties.name);
  return L;
}
