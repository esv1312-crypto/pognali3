/* Pognali map module — isolated prototype.
 * Requires Leaflet 1.9+. No app globals or production API assumptions.
 * Exposes window.PognaliMap.create({container, mode, events, center, zoom, ...}).
 */
(function (root) {
  'use strict';

  const DEFAULT_CENTER = [56.8389, 60.6057];
  const DEFAULT_TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  }

  function eventLabel(event) {
    return String(event.emoji || event.categoryEmoji || '📍');
  }

  function markerIcon(emoji, count) {
    const content = count > 1
      ? '<span class="pm-emoji">' + escapeHtml(emoji) + '</span><span class="pm-count">' + count + '</span>'
      : '<span class="pm-emoji">' + escapeHtml(emoji) + '</span>';
    return root.L.divIcon({
      className: 'pognali-map-marker' + (count > 1 ? ' is-cluster' : ''),
      html: content,
      iconSize: count > 1 ? [48, 48] : [42, 48],
      iconAnchor: count > 1 ? [24, 24] : [21, 42],
      popupAnchor: [0, -38]
    });
  }

  function create(options) {
    options = options || {};
    if (!root.L) throw new Error('Leaflet не загружен');
    const container = typeof options.container === 'string'
      ? document.getElementById(options.container) : options.container;
    if (!container) throw new Error('Не найден контейнер карты');
    const mode = options.mode === 'picker' ? 'picker' : 'events';
    const center = options.center || DEFAULT_CENTER;
    const map = root.L.map(container, {
      zoomControl: true,
      preferCanvas: true,
      zoomSnap: 0.25,
      wheelDebounceTime: 40
    }).setView(center, options.zoom || 12);
    const tileLayer = root.L.tileLayer(options.tileUrl || DEFAULT_TILES, {
      maxZoom: options.maxZoom || 19,
      attribution: options.attribution || '&copy; OpenStreetMap contributors',
      updateWhenIdle: true,
      keepBuffer: 2
    }).addTo(map);
    const markerLayer = root.L.layerGroup().addTo(map);
    let events = Array.isArray(options.events) ? options.events.slice() : [];
    let selectedPoint = null;
    let destroyed = false;
    let renderFrame = 0;
    let renderTimer = 0;

    const style = document.createElement('style');
    style.dataset.pognaliMapModule = 'true';
    style.textContent = [
      '.pognali-map-marker{background:transparent;border:0}',
      '.pognali-map-marker>div,.pognali-map-marker{display:flex;align-items:center;justify-content:center}',
      '.pognali-map-marker .pm-emoji{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border:2px solid #fff;border-radius:15px;background:#fff;box-shadow:0 4px 16px #1114;font-size:23px}',
      '.pognali-map-marker.is-cluster{position:relative}',
      '.pognali-map-marker.is-cluster .pm-emoji{width:44px;height:44px;border-radius:50%;background:#17191d;color:#fff;border-color:#fff;font-size:21px}',
      '.pognali-map-marker .pm-count{position:absolute;right:-2px;top:-3px;min-width:20px;height:20px;padding:0 5px;border:2px solid #fff;border-radius:12px;background:#ffcc4d;color:#17191d;font:800 11px/16px system-ui;text-align:center}',
      '.pm-popup{min-width:160px;font:14px/1.35 system-ui;color:#17191d}',
      '.pm-popup strong{display:block;margin-bottom:5px;font-size:15px}',
      '.pm-popup small{display:block;color:#666;margin-top:5px}',
      '.pm-select{display:inline-block;margin-top:8px;padding:8px 12px;border-radius:10px;background:#17191d;color:white;text-decoration:none;font-weight:700}'
    ].join('');
    document.head.appendChild(style);

    function validPoint(item) {
      const lat = Number(item && (item.lat != null ? item.lat : item.latitude));
      const lng = Number(item && (item.lng != null ? item.lng : item.longitude));
      return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        ? [lat, lng] : null;
    }

    function scheduleRender() {
      if (destroyed) return;
      if (renderFrame) cancelAnimationFrame(renderFrame);
      clearTimeout(renderTimer);
      renderFrame = requestAnimationFrame(() => {
        renderTimer = setTimeout(renderMarkers, 80);
      });
    }

    function renderMarkers() {
      if (destroyed || mode !== 'events') return;
      markerLayer.clearLayers();
      const bounds = map.getBounds().pad(0.08);
      const visible = events.map(event => ({ event, point: validPoint(event) }))
        .filter(row => row.point && bounds.contains(row.point));
      // Group only markers occupying the same screen cell. Far-apart events stay distinct,
      // even when the overall event count is high.
      const cellSize = Math.max(36, Number(options.clusterCellSize) || 54);
      const cells = new Map();
      visible.forEach(row => {
        const p = map.latLngToContainerPoint(row.point);
        const key = Math.floor(p.x / cellSize) + ':' + Math.floor(p.y / cellSize);
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(row);
      });
      cells.forEach(rows => {
        const lat = rows.reduce((sum, row) => sum + row.point[0], 0) / rows.length;
        const lng = rows.reduce((sum, row) => sum + row.point[1], 0) / rows.length;
        const first = rows[0].event;
        const emoji = eventLabel(first);
        const marker = root.L.marker([lat, lng], { icon: markerIcon(emoji, rows.length), keyboard: true });
        if (rows.length === 1) {
          const event = first;
          const title = event.title || event.name || 'Событие';
          const place = event.place || event.address || event.city || '';
          marker.bindPopup('<div class="pm-popup"><strong>' + escapeHtml(title) + '</strong>' +
            (place ? '<span>' + escapeHtml(place) + '</span>' : '') +
            (event.date || event.time ? '<small>' + escapeHtml([event.date, event.time].filter(Boolean).join(' · ')) + '</small>' : '') +
            '<a class="pm-select" href="#" data-event-id="' + escapeHtml(event.id) + '">Открыть событие</a></div>');
          marker.on('popupopen', popupEvent => {
            const link = popupEvent.popup.getElement()?.querySelector('[data-event-id]');
            if (link) link.addEventListener('click', ev => {
              ev.preventDefault();
              if (typeof options.onEventSelect === 'function') options.onEventSelect(event);
            }, { once: true });
          });
        } else {
          marker.bindTooltip(rows.length + ' события', { direction: 'top', offset: [0, -12] });
          marker.on('click', () => {
            if (map.getZoom() < (options.clusterZoom || 16)) {
              map.setView([lat, lng], Math.min(map.getZoom() + 2, options.maxZoom || 19));
            } else if (typeof options.onClusterSelect === 'function') {
              options.onClusterSelect(rows.map(row => row.event));
            } else {
              const list = rows.slice(0, 8).map(row => '<li>' + escapeHtml(row.event.title || row.event.name || 'Событие') + '</li>').join('');
              root.L.popup().setLatLng([lat, lng]).setContent('<div class="pm-popup"><strong>' + rows.length + ' событий рядом</strong><ul>' + list + '</ul></div>').openOn(map);
            }
          });
        }
        marker.addTo(markerLayer);
      });
      if (typeof options.onVisibleCount === 'function') options.onVisibleCount(visible.length, events.length);
    }

    function onMapClick(ev) {
      if (mode !== 'picker') return;
      selectedPoint = { lat: ev.latlng.lat, lng: ev.latlng.lng };
      if (typeof options.onPointSelect === 'function') options.onPointSelect(selectedPoint, null);
      markerLayer.clearLayers();
      root.L.marker([selectedPoint.lat, selectedPoint.lng], { icon: markerIcon('📍', 1) })
        .addTo(markerLayer)
        .bindPopup('<div class="pm-popup"><strong>Выбранная точка</strong><small>' +
          selectedPoint.lat.toFixed(5) + ', ' + selectedPoint.lng.toFixed(5) + '</small></div>')
        .openPopup();
    }

    map.on('moveend zoomend', scheduleRender);
    map.on('click', onMapClick);
    scheduleRender();

    return {
      map,
      tileLayer,
      setEvents(nextEvents) {
        events = Array.isArray(nextEvents) ? nextEvents.slice() : [];
        scheduleRender();
      },
      setCenter(lat, lng, zoom) {
        if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
          map.setView([Number(lat), Number(lng)], zoom || map.getZoom());
        }
      },
      fitEvents(nextEvents) {
        const list = Array.isArray(nextEvents) ? nextEvents : events;
        const points = list.map(validPoint).filter(Boolean);
        if (points.length === 1) map.setView(points[0], 14);
        else if (points.length > 1) map.fitBounds(root.L.latLngBounds(points), { padding: [36, 36], maxZoom: 14 });
      },
      setPoint(lat, lng, notify) {
        const point = validPoint({ lat, lng });
        if (!point || mode !== 'picker') return false;
        selectedPoint = { lat: point[0], lng: point[1] };
        markerLayer.clearLayers();
        root.L.marker(point, { icon: markerIcon('📍', 1) }).addTo(markerLayer);
        if (notify !== false && typeof options.onPointSelect === 'function') options.onPointSelect(selectedPoint, null);
        map.setView(point, Math.max(map.getZoom(), 14));
        return true;
      },
      getPoint() { return selectedPoint ? { ...selectedPoint } : null; },
      async searchPlaces(query) {
        const q = String(query || '').trim();
        if (!q) return [];
        const c = map.getCenter();
        const url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(q) +
          '&limit=8&lat=' + encodeURIComponent(c.lat) + '&lon=' + encodeURIComponent(c.lng);
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('Сервис поиска мест временно недоступен');
        const data = await response.json();
        return (data.features || []).map(feature => {
          const p = feature.properties || {};
          const coords = feature.geometry && feature.geometry.coordinates || [];
          return {
            name: p.name || p.street || p.city || p.district || 'Место на карте',
            address: [p.street, p.housenumber, p.city, p.state, p.country].filter(Boolean).join(', '),
            lat: Number(coords[1]), lng: Number(coords[0]), properties: p
          };
        }).filter(place => Number.isFinite(place.lat) && Number.isFinite(place.lng));
      },
      choosePlace(place) {
        if (!place || !this.setPoint(place.lat, place.lng, false)) return false;
        if (typeof options.onPointSelect === 'function') options.onPointSelect(this.getPoint(), place);
        return true;
      },
      invalidateSize() { map.invalidateSize(); scheduleRender(); },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(renderTimer);
        if (renderFrame) cancelAnimationFrame(renderFrame);
        map.off();
        map.remove();
        style.remove();
      }
    };
  }

  root.PognaliMap = Object.freeze({ create, DEFAULT_CENTER: DEFAULT_CENTER.slice() });
})(window);
