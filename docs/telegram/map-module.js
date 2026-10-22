/* Погнали map module v1 — isolated, no global app state, no API writes. */
(function (global) {
  'use strict';

  const DEFAULT_CENTER = [55.751244, 37.618423];
  const CATEGORY_EMOJI = { sport: '🏃', walk: '🚶', food: '🍕', coffee: '☕', games: '🎲', culture: '🎭', other: '✨' };

  function safeText(value, fallback) {
    const text = String(value == null ? '' : value).trim();
    return text || (fallback || '');
  }

  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function validCoordinates(event) {
    const lat = Number(event.latitude ?? event.lat);
    const lng = Number(event.longitude ?? event.lng ?? event.lon);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function coords(event) {
    return [Number(event.latitude ?? event.lat), Number(event.longitude ?? event.lng ?? event.lon)];
  }

  function eventIcon(event) {
    const emoji = safeText(event.emoji, CATEGORY_EMOJI[event.category] || '✨');
    return L.divIcon({
      className: 'pognali-map-marker-shell',
      html: '<span class="pognali-map-marker">' + emoji.replace(/[<>&"']/g, '') + '</span>',
      iconSize: [44, 44],
      iconAnchor: [22, 22]
    });
  }

  function popupContent(event, onSelect) {
    const card = make('div', 'pognali-map-popup');
    const title = make('strong', 'pognali-map-popup-title', safeText(event.title, 'Событие'));
    const meta = make('div', 'pognali-map-popup-meta', [safeText(event.city), safeText(event.address)].filter(Boolean).join(' · '));
    const time = make('div', 'pognali-map-popup-time', safeText(event.starts_at ? new Date(event.starts_at).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }) : event.time, 'Время уточняется'));
    const action = make('button', 'pognali-map-popup-action', 'Открыть событие');
    action.type = 'button';
    action.addEventListener('click', function () { if (typeof onSelect === 'function') onSelect(event); });
    card.append(title, meta, time, action);
    return card;
  }

  function mount(options) {
    options = options || {};
    const root = typeof options.element === 'string' ? document.querySelector(options.element) : options.element;
    if (!root) throw new Error('PognaliMap: element not found');
    if (!global.L) throw new Error('PognaliMap: Leaflet is not loaded');
    root.innerHTML = '';
    root.classList.add('pognali-map-root');

    const mapEl = make('div', 'pognali-map-canvas');
    mapEl.setAttribute('role', 'application');
    mapEl.setAttribute('aria-label', 'Карта событий');
    root.appendChild(mapEl);

    const status = make('div', 'pognali-map-status', 'Загружаем карту…');
    root.appendChild(status);

    const map = L.map(mapEl, { zoomControl: false, preferCanvas: true, scrollWheelZoom: false })
      .setView(options.center || DEFAULT_CENTER, options.zoom || 12);

    L.tileLayer(options.tileUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const markers = L.featureGroup().addTo(map);
    let currentEvents = [];

    function renderEvents(events) {
      currentEvents = Array.isArray(events) ? events.slice() : [];
      markers.clearLayers();
      let count = 0;
      currentEvents.forEach(function (event) {
        if (!event || !validCoordinates(event)) return;
        const marker = L.marker(coords(event), { icon: eventIcon(event), keyboard: true, title: safeText(event.title, 'Событие') });
        marker.bindPopup(popupContent(event, options.onEventSelect), { maxWidth: 260 });
        marker.addTo(markers);
        count += 1;
      });
      status.textContent = count ? 'На карте: ' + count + (count === 1 ? ' событие' : count < 5 ? ' события' : ' событий') : 'Пока нет событий с координатами в этой области';
      return count;
    }

    if (Array.isArray(options.events)) renderEvents(options.events);
    else status.textContent = 'Карта готова — передайте события через setEvents()';

    const searchWrap = make('div', 'pognali-map-search');
    const input = make('input', 'pognali-map-search-input');
    input.type = 'search';
    input.placeholder = 'Найти адрес или заведение';
    input.setAttribute('aria-label', 'Найти адрес или заведение');
    const searchButton = make('button', 'pognali-map-search-button', 'Найти');
    searchButton.type = 'button';
    const results = make('div', 'pognali-map-search-results');
    results.hidden = true;
    searchWrap.append(input, searchButton);
    root.append(searchWrap, results);

    let searchController = null;
    async function searchPlaces() {
      const query = input.value.trim();
      if (query.length < 3) {
        results.hidden = false;
        results.replaceChildren(make('div', 'pognali-map-result-empty', 'Введите не менее 3 символов'));
        return;
      }
      if (searchController) searchController.abort();
      searchController = new AbortController();
      searchButton.disabled = true;
      searchButton.textContent = 'Ищем…';
      results.hidden = false;
      results.replaceChildren(make('div', 'pognali-map-result-empty', 'Ищем адрес…'));
      try {
        let places = [];
        try {
          const near = map.getCenter();
          const photon = await fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(query) + '&limit=6&lat=' + near.lat + '&lon=' + near.lng + '&lang=ru', { signal: searchController.signal });
          if (photon.ok) {
            const data = await photon.json();
            places = (data.features || []).map(function (f) {
              const p = f.properties || {};
              return { name: [p.name, p.street, p.housenumber].filter(Boolean).join(' '), city: p.city || p.district || p.county || '', label: [p.name, p.street, p.housenumber, p.city, p.country].filter(Boolean).join(', '), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
            });
          }
        } catch (err) { if (err.name === 'AbortError') return; }
        if (!places.length) {
          const response = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=ru&q=' + encodeURIComponent(query), { signal: searchController.signal });
          if (response.ok) {
            const data = await response.json();
            places = data.map(function (p) { return { name: p.name || p.display_name, city: '', label: p.display_name, lat: Number(p.lat), lng: Number(p.lon) }; });
          }
        }
        results.replaceChildren();
        if (!places.length) {
          results.appendChild(make('div', 'pognali-map-result-empty', 'Ничего не найдено. Уточните запрос или выберите точку на карте.'));
          return;
        }
        places.forEach(function (place) {
          if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return;
          const button = make('button', 'pognali-map-result', place.label || place.name || 'Место');
          button.type = 'button';
          button.addEventListener('click', function () {
            map.setView([place.lat, place.lng], 16);
            const point = L.marker([place.lat, place.lng]).addTo(map);
            point.bindPopup(make('div', 'pognali-map-selected-place', place.label || place.name)).openPopup();
            if (typeof options.onPlaceSelect === 'function') options.onPlaceSelect({ name: place.name, city: place.city, address: place.label, latitude: place.lat, longitude: place.lng });
            results.hidden = true;
          });
          results.appendChild(button);
        });
      } catch (err) {
        if (err.name !== 'AbortError') results.replaceChildren(make('div', 'pognali-map-result-empty', 'Поиск временно недоступен. Можно поставить точку вручную.'));
      } finally {
        searchButton.disabled = false;
        searchButton.textContent = 'Найти';
      }
    }
    searchButton.addEventListener('click', searchPlaces);
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter') searchPlaces(); });

    const locate = make('button', 'pognali-map-locate', '◎');
    locate.type = 'button';
    locate.title = 'Показать моё местоположение';
    locate.setAttribute('aria-label', locate.title);
    locate.addEventListener('click', function () {
      if (!navigator.geolocation) { status.textContent = 'Геолокация недоступна — можно искать место вручную'; return; }
      status.textContent = 'Определяем местоположение…';
      navigator.geolocation.getCurrentPosition(function (position) {
        map.setView([position.coords.latitude, position.coords.longitude], 15);
        status.textContent = 'Карта показывает выбранную область';
      }, function () {
        status.textContent = 'Нет доступа к геолокации — карта продолжает работать, выберите место вручную';
      }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
    });
    root.appendChild(locate);

    requestAnimationFrame(function () { map.invalidateSize(); });
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { map.invalidateSize(); }) : null;
    if (resizeObserver) resizeObserver.observe(root);

    return {
      map: map,
      setEvents: renderEvents,
      fitEvents: function () { if (markers.getLayers().length) map.fitBounds(markers.getBounds().pad(0.15), { maxZoom: 15 }); },
      destroy: function () {
        if (searchController) searchController.abort();
        if (resizeObserver) resizeObserver.disconnect();
        map.remove();
        root.replaceChildren();
        root.classList.remove('pognali-map-root');
      }
    };
  }

  global.PognaliMap = { mount: mount };
})(window);
