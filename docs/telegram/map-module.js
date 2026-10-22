/* Pognali map adapter.
 * Shared, replaceable map infrastructure for the event map and event-location picker.
 * Keep app-specific markers, filters and interactions in the main application.
 */
(function (global) {
  'use strict';

  const DEFAULT_CENTER = [56.8389, 60.6057];
  const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  function createMap(container, options) {
    if (!global.L) throw new Error('Leaflet не загрузился');
    const opts = options || {};
    const map = global.L.map(container, opts.mapOptions || {}).setView(
      opts.center || DEFAULT_CENTER,
      Number.isFinite(opts.zoom) ? opts.zoom : 9
    );

    const tileUrl = opts.tileUrl || OSM_TILE_URL;
    const attribution = opts.attribution || OSM_ATTRIBUTION;
    global.L.tileLayer(tileUrl, {
      maxZoom: opts.maxZoom || 19,
      attribution: attribution,
      subdomains: opts.subdomains || 'abc'
    }).addTo(map);

    return map;
  }

  global.PognaliMap = Object.freeze({
    create: createMap,
    defaults: Object.freeze({
      center: DEFAULT_CENTER.slice(),
      tileUrl: OSM_TILE_URL,
      attribution: OSM_ATTRIBUTION
    })
  });
})(window);
