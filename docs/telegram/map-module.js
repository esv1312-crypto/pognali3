/* Погнали map module v1
 * Isolated, opt-in Leaflet map. Does not alter the main app until explicitly mounted.
 * API: PognaliMap.mount(container, { events, onSelect, onJoin, center, zoom })
 */
(function (global) {
  'use strict';

  const DEFAULT_CENTER = [56.8389, 60.6057];
  const CATEGORY_ICONS = {
    'Спорт': '⚽', 'Прогулка': '🚶', 'Общение': '☕', 'Еда': '🍕',
    'Музыка': '🎵', 'Игры': '🎲', 'Культура': '🎭', 'Путешествия': '🧭'
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function coordinates(event) {
    const lat = Number(event.lat ?? event.latitude);
    const lng = Number(event.lng ?? event.lon ?? event.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) &&
      Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
  }

  function mount(container, options) {
    if (!container) throw new Error('PognaliMap: container is required');
    if (!global.L) throw new Error('PognaliMap: Leaflet must be loaded first');
    options = options || {};
    const events = Array.isArray(options.events) ? options.events : [];
    const center = Array.isArray(options.center) ? options.center : DEFAULT_CENTER;
    container.innerHTML = '';
    container.classList.add('pognali-map-root');
    container.innerHTML =
      '<div class="pognali-map-canvas" role="application" aria-label="Карта событий"></div>' +
      '<div class="pognali-map-top"><div class="pognali-map-brand">📍 Погнали <span>Рядом происходит жизнь</span></div>' +
      '<button type="button" class="pognali-map-locate" aria-label="Моё местоположение" title="Моё местоположение">⌖</button></div>' +
      '<div class="pognali-map-count"></div>' +
      '<div class="pognali-map-sheet" hidden></div>' +
      '<div class="pognali-map-attribution"></div>';

    const canvas = container.querySelector('.pognali-map-canvas');
    const count = container.querySelector('.pognali-map-count');
    const sheet = container.querySelector('.pognali-map-sheet');
    const map = global.L.map(canvas, { zoomControl: false, preferCanvas: true })
      .setView(center, Number(options.zoom) || 12);
    global.L.control.zoom({ position: 'bottomright' }).addTo(map);
    // The public OSM tile endpoint is suitable for development/preview only.
    // Configure a contracted tile provider before production scale-up.
    const tileUrl = options.tileLayerUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const tileAttribution = options.tileAttribution || '© OpenStreetMap contributors';
    global.L.tileLayer(tileUrl, {
      maxZoom: Number(options.maxZoom) || 19,
      subdomains: options.tileSubdomains || 'abc', attribution: tileAttribution
    }).addTo(map);
    const attributionNode = container.querySelector('.pognali-map-attribution');
    attributionNode.textContent = tileAttribution.replace(/<[^>]*>/g, '');

    const markerLayer = global.L.featureGroup().addTo(map);
    let activeCategory = 'Все';
    let selectedId = null;
    let visibleEvents = [];
    const validEvents = events.map((event, index) => ({
      ...event, _mapId: String(event.id ?? index), _coords: coordinates(event)
    })).filter(event => event._coords && event.status !== 'cancelled' && event.status !== 'FINISHED');

    const category = e => e.cat || e.category || 'Другое';
    const title = e => e.title || e.name || 'Встреча';
    const place = e => e.place || e.address || e.city || 'Место уточняется';
    const when = e => e.dateLabel || e.date || e.starts_at || e.time || '';
    const iconFor = e => e.emoji || e.icon || CATEGORY_ICONS[category(e)] || '📍';

    function renderSheet(event) {
      if (!event) { sheet.hidden = true; sheet.innerHTML = ''; return; }
      selectedId = event._mapId;
      sheet.hidden = false;
      sheet.innerHTML = '<button class="pognali-map-close" type="button" aria-label="Закрыть">×</button>' +
        '<div class="pognali-map-card-kicker">' + escapeHtml(iconFor(event) + ' ' + category(event)) + '</div>' +
        '<div class="pognali-map-card-title">' + escapeHtml(title(event)) + '</div>' +
        '<div class="pognali-map-card-meta">📍 ' + escapeHtml(place(event)) + '</div>' +
        (when(event) ? '<div class="pognali-map-card-meta">🕒 ' + escapeHtml(when(event)) + '</div>' : '') +
        (event.desc || event.description ? '<p class="pognali-map-card-desc">' + escapeHtml(event.desc || event.description) + '</p>' : '') +
        '<div class="pognali-map-card-actions"><button class="pognali-map-details" type="button">Подробнее</button>' +
        '<button class="pognali-map-join" type="button">Погнали →</button></div>';
      sheet.querySelector('.pognali-map-close').addEventListener('click', () => renderSheet(null));
      sheet.querySelector('.pognali-map-details').addEventListener('click', () => {
        if (typeof options.onSelect === 'function') options.onSelect(event);
      });
      sheet.querySelector('.pognali-map-join').addEventListener('click', () => {
        if (typeof options.onJoin === 'function') options.onJoin(event);
        else if (typeof options.onSelect === 'function') options.onSelect(event);
      });
    }

    function renderMarkers() {
      markerLayer.clearLayers();
      visibleEvents = validEvents.filter(e => activeCategory === 'Все' || category(e) === activeCategory);
      visibleEvents.forEach(event => {
        const html = '<div class="pognali-map-pin" aria-label="' + escapeHtml(title(event)) + '">' +
          '<span>' + escapeHtml(iconFor(event)) + '</span></div>';
        const marker = global.L.marker(event._coords, {
          icon: global.L.divIcon({ className: 'pognali-map-marker', html, iconSize: [44, 48], iconAnchor: [22, 43] })
        }).addTo(markerLayer);
        marker.on('click', () => renderSheet(event));
      });
      count.textContent = visibleEvents.length
        ? visibleEvents.length + (visibleEvents.length === 1 ? ' событие на карте' : ' событий на карте')
        : 'В этой области пока нет событий';
    }

    const categories = ['Все', ...new Set(validEvents.map(category))];
    const filterBar = document.createElement('div');
    filterBar.className = 'pognali-map-filters';
    categories.slice(0, 8).forEach(name => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pognali-map-filter' + (name === activeCategory ? ' is-active' : '');
      button.textContent = name === 'Все' ? '✨ Все' : ((CATEGORY_ICONS[name] || '•') + ' ' + name);
      button.addEventListener('click', () => {
        activeCategory = name;
        filterBar.querySelectorAll('button').forEach(b => b.classList.toggle('is-active', b === button));
        renderMarkers();
      });
      filterBar.appendChild(button);
    });
    container.querySelector('.pognali-map-top').appendChild(filterBar);
    // Place search is intentionally isolated from the main app. Photon is primary;
    // Nominatim is a fallback only when Photon returns no usable result.
    const searchBox = document.createElement('form');
    searchBox.className = 'pognali-map-search';
    searchBox.innerHTML = '<input type="search" aria-label="Поиск места" placeholder="Адрес, кафе или место…">' +
      '<button type="submit">Найти</button><button type="button" class="pognali-map-pick">Выбрать точку</button>' +
      '<div class="pognali-map-search-results" hidden></div>';
    container.querySelector('.pognali-map-top').insertBefore(searchBox, filterBar);
    const searchInput = searchBox.querySelector('input');
    const searchResults = searchBox.querySelector('.pognali-map-search-results');
    let pickLocation = false;
    let searchMarker = null;
    const pickButton = searchBox.querySelector('.pognali-map-pick');
    pickButton.addEventListener('click', () => {
      pickLocation = !pickLocation;
      pickButton.classList.toggle('is-active', pickLocation);
      pickButton.textContent = pickLocation ? 'Нажми на карту…' : 'Выбрать точку';
      count.textContent = pickLocation ? 'Нажми на карте, чтобы выбрать место' : count.textContent;
    });
    map.on('click', event => {
      if (!pickLocation) return;
      const point = { lat: event.latlng.lat, lng: event.latlng.lng };
      if (searchMarker) searchMarker.remove();
      searchMarker = global.L.marker([point.lat, point.lng]).addTo(map);
      searchMarker.bindPopup('Выбранное место').openPopup();
      pickLocation = false;
      pickButton.classList.remove('is-active');
      pickButton.textContent = 'Выбрать точку';
      count.textContent = 'Точка выбрана: ' + point.lat.toFixed(5) + ', ' + point.lng.toFixed(5);
      if (typeof options.onLocationSelect === 'function') options.onLocationSelect(point);
    });
    searchBox.addEventListener('submit', async event => {
      event.preventDefault();
      const query = searchInput.value.trim();
      if (query.length < 2) { searchInput.focus(); return; }
      const submit = searchBox.querySelector('button[type="submit"]');
      submit.disabled = true;
      submit.textContent = 'Ищем…';
      searchResults.hidden = false;
      searchResults.textContent = 'Ищем адреса и организации…';
      try {
        const lang = String(options.language || document.documentElement.lang || 'ru').slice(0, 2);
        const photonUrl = new URL('https://photon.komoot.io/api/');
        photonUrl.search = new URLSearchParams({ q: query, limit: '8', lang }).toString();
        const getJson = async url => {
          const controller = new AbortController();
          const timer = global.setTimeout(() => controller.abort(), 8000);
          try {
            const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal, credentials: 'omit' });
            if (!response.ok) return null;
            return await response.json();
          } finally { global.clearTimeout(timer); }
        };
        let places = [];
        try {
          const data = await getJson(photonUrl.toString());
          places = (data && Array.isArray(data.features) ? data.features : []).map(feature => {
            const coords = feature && feature.geometry && feature.geometry.coordinates;
            const props = feature && feature.properties || {};
            if (!Array.isArray(coords) || coords.length < 2 || !Number.isFinite(Number(coords[0])) || !Number.isFinite(Number(coords[1]))) return null;
            return { name: props.name || props.street || props.city || 'Место', address: [props.street, props.housenumber, props.city, props.state, props.country].filter(Boolean).join(', '), lat: Number(coords[1]), lng: Number(coords[0]) };
          }).filter(Boolean);
        } catch (_) {}
        if (!places.length) {
          const fallback = new URL('https://nominatim.openstreetmap.org/search');
          fallback.search = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', limit: '8', 'accept-language': lang }).toString();
          try {
            const data = await getJson(fallback.toString());
            places = (Array.isArray(data) ? data : []).map(item => ({
              name: item.name || item.display_name || 'Место', address: item.display_name || '',
              lat: Number(item.lat), lng: Number(item.lon)
            })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
          } catch (_) {}
        }
        searchResults.innerHTML = '';
        if (!places.length) {
          searchResults.textContent = 'Ничего не найдено. Попробуй другой запрос или выбери точку на карте.';
          return;
        }
        places.forEach(place => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'pognali-map-search-result';
          const title = document.createElement('strong');
          title.textContent = place.name;
          const address = document.createElement('span');
          address.textContent = place.address || place.name;
          button.append(title, address);
          button.addEventListener('click', () => {
            map.setView([place.lat, place.lng], 16);
            if (searchMarker) searchMarker.remove();
            searchMarker = global.L.marker([place.lat, place.lng]).addTo(map).bindPopup(place.name).openPopup();
            searchResults.hidden = true;
            count.textContent = 'Выбрано место: ' + (place.address || place.name);
            if (typeof options.onLocationSelect === 'function') options.onLocationSelect({ lat: place.lat, lng: place.lng, address: place.address, name: place.name });
          });
          searchResults.appendChild(button);
        });
      } finally {
        submit.disabled = false;
        submit.textContent = 'Найти';
      }
    });

    container.querySelector('.pognali-map-locate').addEventListener('click', () => {
      if (!global.navigator.geolocation) return;
      global.navigator.geolocation.getCurrentPosition(position => {
        const point = [position.coords.latitude, position.coords.longitude];
        map.setView(point, 14);
        if (userMarker) userMarker.remove();
        userMarker = global.L.circleMarker(point, {
          radius: 7, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1
        }).addTo(map).bindTooltip('Вы здесь');
      }, () => {
        count.textContent = 'Не удалось определить местоположение. Можно переместить карту вручную.';
      }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
    });
    let userMarker = null;
    map.on('moveend', () => {
      if (typeof options.onBoundsChange === 'function') {
        const b = map.getBounds();
        options.onBoundsChange({ north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() });
      }
    });
    renderMarkers();
    if (validEvents.length > 0 && !options.center) {
      const bounds = markerLayer.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [60, 45], maxZoom: 13 });
    }
    requestAnimationFrame(() => map.invalidateSize());
    return {
      map,
      setEvents(next) {
        const safe = Array.isArray(next) ? next : [];
        validEvents = safe.map((event, index) => ({ ...event, _mapId: String(event.id ?? index), _coords: coordinates(event) }))
          .filter(event => event._coords && event.status !== 'cancelled' && event.status !== 'FINISHED');
        renderMarkers();
      },
      destroy() { map.remove(); container.innerHTML = ''; container.classList.remove('pognali-map-root'); }
    };
  }

  global.PognaliMap = Object.freeze({ mount });
})(window);
