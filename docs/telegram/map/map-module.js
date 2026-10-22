/* Pognali Map Module — isolated, dependency-injected Leaflet map.
 * No API calls that mutate application data. Caller owns event loading and persistence.
 * Required: Leaflet 1.9.x loaded before this script.
 */
(function (global) {
  'use strict';

  const DEFAULT_CENTER = [56.8389, 60.6057];

  function validPoint(lat, lon) {
    return Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) &&
      Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  class PognaliMap {
    constructor(options) {
      if (!options || !options.container) throw new Error('PognaliMap requires a container element or id');
      if (!global.L) throw new Error('Leaflet is not loaded');
      this.options = options;
      this.container = typeof options.container === 'string'
        ? document.getElementById(options.container) : options.container;
      if (!this.container) throw new Error('PognaliMap container was not found');
      this.map = null;
      this.eventLayer = null;
      this.selectionMarker = null;
      this.eventMarkers = new Map();
      this.events = [];
      this.onEventSelect = typeof options.onEventSelect === 'function' ? options.onEventSelect : function () {};
      this.onLocationSelect = typeof options.onLocationSelect === 'function' ? options.onLocationSelect : function () {};
      this.init();
    }

    init() {
      const center = this.options.center || DEFAULT_CENTER;
      this.map = L.map(this.container, {
        zoomControl: false,
        preferCanvas: true,
        scrollWheelZoom: this.options.scrollWheelZoom !== false
      }).setView(center, this.options.zoom || 12);

      L.tileLayer(this.options.tileUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
      }).addTo(this.map);
      L.control.zoom({ position: 'bottomright' }).addTo(this.map);
      this.eventLayer = L.layerGroup().addTo(this.map);

      if (this.options.pickLocation) {
        this.map.on('click', event => {
          const point = { latitude: event.latlng.lat, longitude: event.latlng.lng };
          if (this.selectionMarker) this.selectionMarker.setLatLng(event.latlng);
          else this.selectionMarker = L.marker(event.latlng, { draggable: true }).addTo(this.map);
          this.selectionMarker.on('dragend', () => {
            const p = this.selectionMarker.getLatLng();
            this.onLocationSelect({ latitude: p.lat, longitude: p.lng });
          });
          this.onLocationSelect(point);
        });
      }
      if (Array.isArray(this.options.events)) this.setEvents(this.options.events);
    }

    setEvents(events) {
      this.events = Array.isArray(events) ? events.filter(event => event && validPoint(event.latitude, event.longitude)) : [];
      this.eventLayer.clearLayers();
      this.eventMarkers.clear();

      this.events.forEach(event => {
        const id = String(event.id == null ? '' : event.id);
        const emoji = escapeHtml(event.emoji || event.icon || '📍');
        const title = escapeHtml(event.title || 'Событие');
        const address = escapeHtml(event.address || event.city || '');
        const marker = L.marker([Number(event.latitude), Number(event.longitude)], {
          icon: L.divIcon({
            className: 'pognali-map-marker-host',
            html: '<span class="pognali-map-marker" aria-label="' + title + '">' + emoji + '</span>',
            iconSize: [42, 42], iconAnchor: [21, 21]
          })
        });
        marker.bindPopup(
          '<article class="pognali-map-popup"><strong>' + title + '</strong>' +
          (address ? '<span>' + address + '</span>' : '') +
          '<button type="button" data-pognali-event="' + id + '">Открыть событие</button></article>',
          { closeButton: true, maxWidth: 240 }
        );
        marker.on('popupopen', () => {
          const button = marker.getPopup().getElement().querySelector('[data-pognali-event]');
          if (button) button.addEventListener('click', () => this.onEventSelect(event), { once: true });
        });
        marker.addTo(this.eventLayer);
        this.eventMarkers.set(id, marker);
      });
      return this;
    }

    focus(latitude, longitude, zoom) {
      if (validPoint(latitude, longitude)) this.map.setView([Number(latitude), Number(longitude)], zoom || 15);
      return this;
    }

    fitEvents() {
      const markers = Array.from(this.eventMarkers.values());
      if (!markers.length) return this;
      const group = L.featureGroup(markers);
      this.map.fitBounds(group.getBounds().pad(0.18), { maxZoom: 15 });
      return this;
    }

    setPickLocation(enabled) {
      this.options.pickLocation = Boolean(enabled);
      return this;
    }

    invalidateSize() {
      if (this.map) this.map.invalidateSize();
      return this;
    }

    destroy() {
      if (this.map) this.map.remove();
      this.map = null;
      this.eventLayer = null;
      this.eventMarkers.clear();
    }
  }

  global.PognaliMap = PognaliMap;
})(window);
