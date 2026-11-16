import { APP_CONFIG } from './config.js';

export function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function clampToRadiusMetres(centerLat, centerLng, targetLat, targetLng, maxMetres = 8) {
  const dist = haversineMetres(centerLat, centerLng, targetLat, targetLng);
  if (dist <= maxMetres || dist === 0) {
    return { lat: targetLat, lng: targetLng, clamped: false, distanceM: dist };
  }
  const ratio = maxMetres / dist;
  return {
    lat: centerLat + (targetLat - centerLat) * ratio,
    lng: centerLng + (targetLng - centerLng) * ratio,
    clamped: true,
    distanceM: dist
  };
}

export function machineMatchesSearch(machine, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    machine.serialLabel,
    machine.name,
    machine.building,
    machine.floor,
    machine.status,
    machine.note,
    ...(machine.tags || [])
  ].join(' ').toLowerCase();
  return haystack.includes(q);
}

export function getDisplayCoords(machine) {
  if (machine?.confirmedPosition && Number.isFinite(machine.confirmedPosition.lat) && Number.isFinite(machine.confirmedPosition.lng)) {
    return {
      lat: machine.confirmedPosition.lat,
      lng: machine.confirmedPosition.lng,
      isConfirmed: true
    };
  }
  if (machine?.measuredGps && Number.isFinite(machine.measuredGps.lat) && Number.isFinite(machine.measuredGps.lng)) {
    return {
      lat: machine.measuredGps.lat,
      lng: machine.measuredGps.lng,
      isConfirmed: false
    };
  }
  return null;
}

function createBaseLayer(basemap) {
  if (basemap === 'onemap') {
    return L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png', {
      detectRetina: true,
      maxZoom: 19,
      minZoom: 11,
      attribution:
        '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:16px;width:16px;vertical-align:middle;" alt="OneMap"/> <a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a> &copy; contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>'
    });
  }
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class MainMapController {
  constructor(containerId, { onSelectMachine }) {
    this.containerId = containerId;
    this.onSelectMachine = onSelectMachine;
    this.map = null;
    this.baseLayer = null;
    this.markersLayer = null;
    this.radiusLayer = null;
    this.currentBasemap = 'osm';
  }

  init(basemap = 'osm') {
    if (typeof window.L === 'undefined') return false;
    if (this.map) {
      this.setBasemap(basemap);
      this.map.invalidateSize();
      return true;
    }

    this.map = L.map(this.containerId, {
      center: APP_CONFIG.mapCenter,
      zoom: APP_CONFIG.mapDefaultZoom,
      zoomControl: true
    });

    this.currentBasemap = basemap;
    this.baseLayer = createBaseLayer(basemap).addTo(this.map);
    this.radiusLayer = L.layerGroup().addTo(this.map);
    this.markersLayer = L.layerGroup().addTo(this.map);
    return true;
  }

  setBasemap(basemap) {
    if (!this.map || this.currentBasemap === basemap) return;
    if (this.baseLayer) this.map.removeLayer(this.baseLayer);
    this.currentBasemap = basemap;
    this.baseLayer = createBaseLayer(basemap).addTo(this.map);
  }

  renderMachines(machines, { authState = null, searchQuery = '', userRadius = null } = {}) {
    if (!this.map || !this.markersLayer) return;
    this.markersLayer.clearLayers();

    const bounds = [];
    for (const m of machines) {
      if (!machineMatchesSearch(m, searchQuery)) continue;
      const coords = getDisplayCoords(m);
      if (!coords) continue;
      if (userRadius && haversineMetres(userRadius.lat, userRadius.lng, coords.lat, coords.lng) > userRadius.radiusM) {
        continue;
      }
      bounds.push([coords.lat, coords.lng]);

      // Solid black for developer pins; lighter blue-grey for community pins
      const isDevPin = m.contributorRole !== 'community';
      let color = isDevPin ? '#111827' : '#475569';
      let fillColor = isDevPin ? '#111827' : '#64748b';
      let fillOpacity = 0.95;
      if (m.status === 'Broken') {
        color = '#b91c1c';
      } else if (m.status === 'Gone') {
        color = '#6b7280';
        fillColor = '#94a3b8';
        fillOpacity = 0.7;
      }

      const marker = L.circleMarker([coords.lat, coords.lng], {
        radius: 7,
        color,
        weight: m.status === 'Broken' ? 2.5 : 1.5,
        fillColor,
        fillOpacity
      });

      const thumb = m.photos?.[0]?.thumbDataUrl || '';
      const title = escapeHtml(m.name || m.serialLabel || 'Unnamed machine');
      const building = escapeHtml(m.building || '—');
      const floor = escapeHtml(m.floor || '—');
      const status = escapeHtml(m.status || 'Unknown / Not checked');

      const popupHtml = `
        <div class="map-popup">
          ${thumb ? `<img src="${thumb}" alt="${title}" class="map-popup-thumb" />` : ''}
          <div class="map-popup-title">${title}</div>
          <div class="map-popup-meta">${escapeHtml(m.serialLabel)} · ${status}</div>
          <div class="map-popup-meta">${building}${m.floor ? `, ${floor}` : ''}</div>
          ${(m.tags && m.tags.length) ? `<div class="map-popup-meta">Tags: ${escapeHtml(m.tags.join(', '))}</div>` : ''}
          ${(authState?.signedIn && (authState.role === 'developer' || (m.contributorEmail && m.contributorEmail === authState.email)))
            ? `<button type="button" class="btn btn-sm btn-primary map-popup-btn" data-machine-id="${escapeHtml(m.id)}">Open record</button>`
            : ''}
        </div>
      `;

      marker.bindPopup(popupHtml);

      // Desktop hover preview only (does not interfere with mobile tap)
      if (window.matchMedia('(hover: hover)').matches) {
        marker.bindTooltip(`${title} (${status})`, { direction: 'top', offset: [0, -6] });
      }

      marker.on('popupopen', (e) => {
        const el = e.popup.getElement();
        const btn = el?.querySelector('.map-popup-btn');
        if (btn) {
          btn.addEventListener('click', () => {
            this.onSelectMachine(m.id);
          });
        }
      });

      marker.addTo(this.markersLayer);
    }

    if (bounds.length > 0 && !this._hasFittedOnce) {
      this._hasFittedOnce = true;
      this.map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
    }
  }

  showUserRadius(lat, lng, radiusMetres, { fit = true } = {}) {
    if (!this.map || !this.radiusLayer) return;
    this.radiusLayer.clearLayers();

    let circle = null;
    if (radiusMetres > 0) {
      circle = L.circle([lat, lng], {
        radius: radiusMetres,
        color: '#2563eb',
        fillColor: '#60a5fa',
        fillOpacity: 0.14,
        weight: 2
      }).addTo(this.radiusLayer);
    }

    const userIcon = L.divIcon({
      className: 'user-pos-icon',
      html: '<div class="user-pos-dot"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    L.marker([lat, lng], { icon: userIcon, interactive: false }).addTo(this.radiusLayer);

    if (fit && circle) {
      this.map.fitBounds(circle.getBounds(), { padding: [20, 20] });
    }
  }

  clearUserRadius() {
    if (this.radiusLayer) this.radiusLayer.clearLayers();
  }
}

export class NudgeMapController {
  constructor(containerId, { onNudge }) {
    this.containerId = containerId;
    this.onNudge = onNudge;
    this.map = null;
    this.accuracyCircle = null;
    this.nudgeLimitCircle = null;
    this.measuredMarker = null;
    this.confirmedMarker = null;
    this.refLayer = null;
    this._currentOpts = {};
  }

  destroy() {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.accuracyCircle = null;
    this.nudgeLimitCircle = null;
    this.measuredMarker = null;
    this.confirmedMarker = null;
    this.refLayer = null;
  }

  _applyNudge(lat, lng) {
    const { measuredGps, isDeveloper = true } = this._currentOpts;
    let finalLat = lat;
    let finalLng = lng;
    let clamped = false;
    if (!isDeveloper && measuredGps && Number.isFinite(measuredGps.lat)) {
      const res = clampToRadiusMetres(measuredGps.lat, measuredGps.lng, lat, lng, 8);
      finalLat = res.lat;
      finalLng = res.lng;
      clamped = res.clamped;
    }
    this.placeConfirmedPin(finalLat, finalLng, true);
    this.onNudge(finalLat, finalLng, clamped);
  }

  render({ measuredGps, confirmedPosition, basemap = 'osm', editable = true, isDeveloper = true, otherMachines = [] }) {
    if (typeof window.L === 'undefined') return;
    this._currentOpts = { measuredGps, confirmedPosition, basemap, editable, isDeveloper };

    const center = confirmedPosition
      ? [confirmedPosition.lat, confirmedPosition.lng]
      : measuredGps
      ? [measuredGps.lat, measuredGps.lng]
      : APP_CONFIG.mapCenter;

    if (!this.map) {
      this.map = L.map(this.containerId, {
        center,
        zoom: measuredGps || confirmedPosition ? 19 : 12,
        zoomControl: true
      });
      createBaseLayer(basemap).addTo(this.map);
      this.refLayer = L.layerGroup().addTo(this.map);

      if (editable) {
        this.map.on('click', (e) => this._applyNudge(e.latlng.lat, e.latlng.lng));
      }
    } else {
      this.map.setView(center, measuredGps || confirmedPosition ? 19 : 12);
    }

    if (this.accuracyCircle) this.map.removeLayer(this.accuracyCircle);
    if (this.nudgeLimitCircle) this.map.removeLayer(this.nudgeLimitCircle);
    if (this.measuredMarker) this.map.removeLayer(this.measuredMarker);
    if (this.confirmedMarker) this.map.removeLayer(this.confirmedMarker);
    if (this.refLayer) this.refLayer.clearLayers();

    // Reference dots for nearby existing machines so side-by-side placement is easy
    for (const om of otherMachines) {
      const oc = getDisplayCoords(om);
      if (!oc) continue;
      const isDev = om.contributorRole !== 'community';
      const refDot = L.circleMarker([oc.lat, oc.lng], {
        radius: 5,
        color: isDev ? '#111827' : '#475569',
        fillColor: isDev ? '#111827' : '#64748b',
        fillOpacity: 0.6,
        weight: 1
      });
      refDot.bindTooltip(escapeHtml(om.name || om.serialLabel), { permanent: false, direction: 'top' });
      refDot.addTo(this.refLayer);
    }

    if (measuredGps && Number.isFinite(measuredGps.lat)) {
      this.accuracyCircle = L.circle([measuredGps.lat, measuredGps.lng], {
        radius: Math.max(3, measuredGps.accuracyM || 15),
        color: '#457b9d',
        fillColor: '#a8dadc',
        fillOpacity: 0.18,
        weight: 1,
        dashArray: '4 4'
      }).addTo(this.map);

      // 8m guide ring
      this.nudgeLimitCircle = L.circle([measuredGps.lat, measuredGps.lng], {
        radius: 8,
        color: '#2d6a4f',
        fillOpacity: 0,
        weight: 1.5,
        dashArray: '3 3'
      }).addTo(this.map);

      this.measuredMarker = L.circleMarker([measuredGps.lat, measuredGps.lng], {
        radius: 5,
        color: '#1d3557',
        fillColor: '#457b9d',
        fillOpacity: 0.9,
        weight: 1.5
      }).addTo(this.map);
    }

    const pinLat = confirmedPosition?.lat ?? measuredGps?.lat;
    const pinLng = confirmedPosition?.lng ?? measuredGps?.lng;
    if (Number.isFinite(pinLat) && Number.isFinite(pinLng)) {
      this.placeConfirmedPin(pinLat, pinLng, editable);
    }

    setTimeout(() => this.map?.invalidateSize(), 100);
  }

  placeConfirmedPin(lat, lng, editable = true) {
    if (!this.map) return;
    if (this.confirmedMarker) this.map.removeLayer(this.confirmedMarker);

    const icon = L.divIcon({
      className: 'nudge-pin-icon',
      html: '<div class="nudge-pin-dot"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });

    this.confirmedMarker = L.marker([lat, lng], {
      icon,
      draggable: editable
    }).addTo(this.map);

    if (editable) {
      this.confirmedMarker.on('dragend', () => {
        const pos = this.confirmedMarker.getLatLng();
        this._applyNudge(pos.lat, pos.lng);
      });
    }
  }
}
