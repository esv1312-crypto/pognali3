/* Pognali map services — isolated geocoding provider adapter.
 * The UI and Leaflet map stay in index.html; this module only resolves place searches.
 * Provider failures are contained here so the event form can show a helpful message.
 */
(function (global) {
  'use strict';
  const PHOTON_URL = 'https://photon.komoot.io/api/';
  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
  function validCoordinates(lng, lat) {
    return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
  }
  async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method:'GET', headers:{Accept:'application/json'}, signal:controller.signal, mode:'cors', credentials:'omit' });
      if (!response.ok) return null;
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  function photonFeature(feature) {
    const coordinates = feature && feature.geometry && feature.geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const lng = Number(coordinates[0]), lat = Number(coordinates[1]);
    return validCoordinates(lng, lat) ? feature : null;
  }
  function nominatimFeature(item) {
    const lat = Number(item && item.lat), lng = Number(item && item.lon);
    if (!validCoordinates(lng, lat)) return null;
    const address = item.address || {}, names = item.namedetails || {};
    return { type:'Feature', geometry:{type:'Point',coordinates:[lng,lat]}, properties:{
      name:item.name || names.name || item.display_name || '', display_name:item.display_name || '',
      country:address.country || '', city:address.city || address.town || address.village || address.municipality || '',
      state:address.state || '', street:address.road || address.pedestrian || '', housenumber:address.house_number || ''
    }};
  }
  async function searchPlaces(query, near, language) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const lang = String(language || 'ru').slice(0,2), features = [];
    const params = new URLSearchParams({q,limit:'10',lang});
    if (near && validCoordinates(Number(near.lng), Number(near.lat))) {
      params.set('lat',String(Number(near.lat))); params.set('lon',String(Number(near.lng)));
    }
    try {
      const data = await fetchJson(PHOTON_URL + '?' + params.toString(),7000);
      if (data && Array.isArray(data.features)) for (const feature of data.features) {
        const valid = photonFeature(feature); if (valid) features.push(valid);
      }
    } catch (_) {}
    if (features.length) return features;
    try {
      const fallbackParams = new URLSearchParams({format:'jsonv2',addressdetails:'1',namedetails:'1','accept-language':lang,limit:'10',q});
      const data = await fetchJson(NOMINATIM_URL + '?' + fallbackParams.toString(),9000);
      if (Array.isArray(data)) for (const item of data) {
        const feature = nominatimFeature(item); if (feature) features.push(feature);
      }
    } catch (_) {}
    return features;
  }
  global.PognaliMapServices = Object.freeze({searchPlaces});
})(window);
