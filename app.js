import { APP_CONFIG } from './config.js';
import {
  generateUuidV4,
  getAllSettings,
  saveAppSettings,
  getSetting,
  setSetting,
  getOrCreateDeviceId,
  getNextSerialLabel,
  saveMachine,
  getMachine,
  listMachines,
  getActiveDraft,
  deleteMachine,
  savePhotoBlob,
  getPhotoBlob,
  getLocalBlobStats,
  pruneWorkingSetBlobs
} from './db.js';
import {
  compressPhoto,
  cropPhotoBlob,
  loadImageFromBlob,
  getTagSpellingSuggestion,
  formatBytes
} from './photo.js';
import {
  getAuthState,
  requestDriveToken,
  signOutDrive,
  backupMachineToDrive,
  downloadDrivePhotoBlob,
  restoreAllFromDrive
} from './drive.js';
import { createZipBlob, parseZipBuffer } from './zip.js';
import { MainMapController, NudgeMapController, haversineMetres, getDisplayCoords } from './map.js';

const state = {
  settings: { ...APP_CONFIG.defaultSettings },
  clientId: APP_CONFIG.googleOAuthClientId,
  deviceId: '',
  machines: [],
  activeCapture: null,
  pendingPhoto: null, // { id, compressed, role, tags }
  gpsWatchId: null,
  deferredInstallPrompt: null,
  mainMap: null,
  reviewNudgeMap: null,
  detailNudgeMap: null,
  detailMachineId: null,
  listSort: { field: 'createdAt', dir: 'desc' },
  retakeTarget: null, // { machineId, photoId, isReview }
  cropContext: null,  // { machineId, photoId, isReview, img, rect }
  isSyncing: false
};

const $ = (id) => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  $(`screen-${name}`).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === name);
  });
}

function updateOnlineStatus() {
  const pill = $('net-pill');
  if (navigator.onLine) {
    pill.textContent = 'Online';
    pill.classList.remove('offline');
  } else {
    pill.textContent = 'Offline';
    pill.classList.add('offline');
  }
}

async function init() {
  document.title = APP_CONFIG.appName;
  $('app-title').textContent = APP_CONFIG.appName;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    $('install-banner').style.display = 'block';
  });

  // iOS Safari install hint
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isIos && !isStandalone) {
    $('install-text').textContent = 'On iPhone: tap Share then "Add to Home Screen" to install.';
    $('btn-install-app').style.display = 'none';
    $('install-banner').style.display = 'block';
  }

  $('btn-install-app').addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    $('install-banner').style.display = 'none';
  });

  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }

  state.settings = await getAllSettings();
  state.deviceId = await getOrCreateDeviceId();
  state.clientId = APP_CONFIG.googleOAuthClientId;
  state.profile = await getSetting('contributorProfile', { ageRange: '', sex: '' });

  state.mainMap = new MainMapController('main-map', {
    onSelectMachine: (id) => openDetailScreen(id)
  });

  bindEvents();
  updateOnlineStatus();
  window.addEventListener('online', () => {
    updateOnlineStatus();
    autoSyncPending();
  });
  window.addEventListener('offline', updateOnlineStatus);

  await refreshDataAndHome();
  autoSyncPending();
}

async function refreshDataAndHome() {
  state.machines = await listMachines({ includeDrafts: false });
  const draft = await getActiveDraft();

  if (draft) {
    $('draft-banner').style.display = 'block';
    $('draft-summary').textContent = `${draft.serialLabel} · ${(draft.photos || []).length} photo(s) saved locally`;
  } else {
    $('draft-banner').style.display = 'none';
  }

  const pending = state.machines.filter((m) => m.backupState !== 'verified');
  if (pending.length > 0) {
    $('backup-warning').style.display = 'block';
    $('backup-warning-text').textContent = `${pending.length} record(s) not yet backed up and verified in Google Drive.`;
  } else {
    $('backup-warning').style.display = 'none';
  }

  $('home-total-count').textContent = `${state.machines.length} machine(s) saved`;
  const auth = getAuthState();
  const isDev = auth.signedIn && auth.role === 'developer';
  const hasCommProfile = Boolean(state.profile?.ageRange && state.profile?.sex);

  $('home-signin-card').style.display = auth.signedIn ? 'none' : 'block';
  $('community-profile-card').style.display = (auth.signedIn && !isDev && !hasCommProfile) ? 'block' : 'none';

  const canCapture = auth.signedIn && (isDev || hasCommProfile);
  $('btn-start-capture').disabled = !canCapture;
  if (!auth.signedIn) {
    $('home-capture-hint').textContent = 'Sign in with Google above to unlock capture.';
    $('home-drive-status').textContent = 'Drive: Not signed in';
  } else if (!isDev && !hasCommProfile) {
    $('home-capture-hint').textContent = 'Please save your Age range and Sex above to unlock capture.';
    $('home-drive-status').textContent = `Signed in as ${auth.email || 'Community'} (Community)`;
  } else {
    $('home-capture-hint').textContent = 'Survey one machine at a time from outside only. Photos and drafts save locally as you go.';
    $('home-drive-status').textContent = `Signed in as ${auth.email || 'Google user'} (${isDev ? 'Developer' : 'Community'})`;
  }
}

function bindEvents() {
  // Bottom nav
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav;
      showScreen(target);
      if (target === 'map') {
        state.mainMap.init(state.settings.basemap);
        state.mainMap.renderMachines(state.machines);
        renderListTable();
      } else if (target === 'settings') {
        renderSettingsScreen();
      } else if (target === 'home') {
        refreshDataAndHome();
      }
    });
  });

  // Home actions
  $('btn-start-capture').addEventListener('click', startNewCapture);
  $('btn-resume-draft').addEventListener('click', async () => {
    const draft = await getActiveDraft();
    if (draft) resumeCapture(draft);
  });
  $('btn-discard-draft').addEventListener('click', async () => {
    const draft = await getActiveDraft();
    if (draft) {
      await deleteMachine(draft.id);
      await refreshDataAndHome();
    }
  });
  $('btn-home-signin').addEventListener('click', handleSignIn);
  $('btn-home-sync').addEventListener('click', syncAllPending);

  // Capture screen
  $('camera-input').addEventListener('change', handleCameraInput);
  $('btn-add-custom-tag').addEventListener('click', handleAddCustomTag);
  $('cap-custom-tag').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddCustomTag();
    }
  });
  $('btn-save-photo').addEventListener('click', savePendingPhotoToCapture);
  $('btn-discard-photo').addEventListener('click', () => {
    state.pendingPhoto = null;
    $('cap-label-card').style.display = 'none';
  });
  $('btn-go-review').addEventListener('click', openReviewScreen);
  $('btn-cancel-capture').addEventListener('click', cancelActiveCapture);

  // Review screen
  $('btn-rev-back-capture').addEventListener('click', () => showScreen('capture'));
  $('btn-done-capture').addEventListener('click', finishActiveCapture);
  $('btn-rev-cancel').addEventListener('click', cancelActiveCapture);

  // Map / List toggle
  $('btn-view-map').addEventListener('click', () => {
    $('map-panel').style.display = 'block';
    $('list-panel').style.display = 'none';
    $('map-radius-bar').style.display = 'flex';
    $('btn-view-map').classList.add('btn-primary');
    $('btn-view-list').classList.remove('btn-primary');
    state.mainMap.init(state.settings.basemap);
    state.mainMap.renderMachines(state.machines);
  });
  $('btn-view-list').addEventListener('click', () => {
    $('map-panel').style.display = 'none';
    $('list-panel').style.display = 'block';
    $('map-radius-bar').style.display = 'none';
    $('map-gps-status').style.display = 'none';
    $('btn-view-list').classList.add('btn-primary');
    $('btn-view-map').classList.remove('btn-primary');
    populateListFilters();
    renderListTable();
  });

  document.querySelectorAll('.radius-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const radiusM = Number(btn.dataset.radius);
      triggerSingleShotRadius(radiusM, btn);
    });
  });
  $('btn-clear-radius').addEventListener('click', () => {
    state.mainMap.clearUserRadius();
    document.querySelectorAll('.radius-btn').forEach((b) => b.classList.remove('active'));
    $('btn-clear-radius').style.display = 'none';
    $('map-gps-status').style.display = 'none';
  });
  $('basemap-select').addEventListener('change', async (e) => {
    state.settings = await saveAppSettings({ basemap: e.target.value });
    state.mainMap.setBasemap(e.target.value);
  });
  $('filter-status').addEventListener('change', renderListTable);
  $('filter-tag').addEventListener('change', renderListTable);
  document.querySelectorAll('.data-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const f = th.dataset.sort;
      if (state.listSort.field === f) {
        state.listSort.dir = state.listSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.listSort = { field: f, dir: 'asc' };
      }
      renderListTable();
    });
  });

  // Detail screen
  $('btn-detail-back').addEventListener('click', () => {
    showScreen('map');
    state.mainMap.init(state.settings.basemap);
    state.mainMap.renderMachines(state.machines);
  });
  $('btn-det-retry').addEventListener('click', async () => {
    if (!state.detailMachineId) return;
    const m = await getMachine(state.detailMachineId);
    if (m) await syncSingleMachine(m);
    await openDetailScreen(state.detailMachineId);
  });

  // Community profile selects & save
  $('prof-age').innerHTML = '<option value="">Select age range...</option>' +
    APP_CONFIG.ageRanges.map((a) => `<option value="${a}">${a}</option>`).join('');
  $('prof-sex').innerHTML = '<option value="">Select sex...</option>' +
    APP_CONFIG.sexOptions.map((s) => `<option value="${s}">${s}</option>`).join('');
  $('btn-save-profile').addEventListener('click', async () => {
    const ageRange = $('prof-age').value;
    const sex = $('prof-sex').value;
    if (!ageRange || !sex) {
      alert('Please select both Age range and Sex.');
      return;
    }
    state.profile = { ageRange, sex };
    await setSetting('contributorProfile', state.profile);
    await refreshDataAndHome();
  });

  // Settings screen
  $('btn-drive-signin').addEventListener('click', handleSignIn);
  $('btn-drive-signout').addEventListener('click', () => {
    signOutDrive();
    renderSettingsScreen();
    refreshDataAndHome();
  });
  $('btn-sync-all').addEventListener('click', syncAllPending);
  $('btn-restore-drive').addEventListener('click', handleRestoreFromDrive);
  $('btn-save-photo-settings').addEventListener('click', async () => {
    const maxSide = Math.max(600, Math.min(4000, Number($('set-max-side').value) || 1600));
    const quality = Math.max(0.4, Math.min(0.95, Number($('set-quality').value) || 0.78));
    const format = $('set-format').value;
    state.settings = await saveAppSettings({ photoMaxSide: maxSide, photoQuality: quality, photoFormat: format });
    alert('Photo settings saved.');
  });
  $('legibility-test-input').addEventListener('change', handleLegibilityTest);
  $('btn-prune-blobs').addEventListener('click', async () => {
    const res = await pruneWorkingSetBlobs(state.settings.workingSetLimit);
    await renderSettingsScreen();
    alert(`Freed ${formatBytes(res.freedBytes)} across ${res.evictedPhotos} verified photo(s). Thumbnails remain.`);
  });
  $('btn-export-zip').addEventListener('click', handleExportZip);
  $('import-zip-input').addEventListener('change', handleImportZip);
  $('set-dev-mode').addEventListener('change', async (e) => {
    state.settings = await saveAppSettings({ developerMode: e.target.checked });
  });

  // Retake & Crop
  $('retake-input').addEventListener('change', handleRetakeFile);
  $('btn-cancel-crop').addEventListener('click', () => {
    $('crop-modal').classList.remove('open');
    state.cropContext = null;
  });
  $('btn-apply-crop').addEventListener('click', applyCrop);
}

// ==================== CAPTURE & GPS ====================

async function startNewCapture() {
  const existing = await getActiveDraft();
  if (existing) {
    resumeCapture(existing);
    return;
  }

  const serialLabel = await getNextSerialLabel();
  const draft = {
    id: generateUuidV4(),
    schemaVersion: APP_CONFIG.schemaVersion,
    serialLabel,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    contributorId: getAuthState().email || state.deviceId,
    contributorEmail: getAuthState().email || '',
    contributorRole: getAuthState().role || 'community',
    contributorAgeRange: getAuthState().role === 'developer' ? '' : (state.profile?.ageRange || ''),
    contributorSex: getAuthState().role === 'developer' ? '' : (state.profile?.sex || ''),
    measuredGps: null,
    gpsHistory: [],
    confirmedPosition: null,
    name: '',
    building: '',
    floor: '',
    status: APP_CONFIG.machineStatuses[0],
    note: '',
    colocatedNote: '',
    tags: [],
    photos: [],
    backupState: 'not_backed_up',
    backupError: null,
    isDraft: true
  };
  await saveMachine(draft);
  resumeCapture(draft);
}

function resumeCapture(draft) {
  state.activeCapture = draft;
  state.pendingPhoto = null;
  $('cap-label-card').style.display = 'none';
  $('cap-serial').textContent = `${draft.serialLabel} (Draft)`;
  updateCapturePhotoCount();
  renderCaptureRoleButtons();
  renderCaptureTagChips([]);
  showScreen('capture');
  startGpsWatch();
  updateNearbyWarning();
}

function startGpsWatch() {
  stopGpsWatch();
  if (!navigator.geolocation) {
    $('cap-gps-badge').textContent = 'GPS unavailable';
    $('cap-gps-detail').textContent = 'Geolocation is not supported in this browser.';
    return;
  }
  $('cap-gps-badge').textContent = 'GPS: Requesting...';
  $('cap-gps-detail').textContent = 'Waiting for location fix. You can wait for better accuracy before Done.';

  state.gpsWatchId = navigator.geolocation.watchPosition(
    async (pos) => {
      if (!state.activeCapture) return;
      const fix = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracyM: Math.round(pos.coords.accuracy),
        timestamp: new Date(pos.timestamp).toISOString()
      };
      const prev = state.activeCapture.measuredGps;
      // Keep best-known accuracy fix during capture (never overwrite after Done)
      if (!prev || fix.accuracyM <= prev.accuracyM) {
        state.activeCapture.measuredGps = fix;
      }
      state.activeCapture.gpsHistory = [...(state.activeCapture.gpsHistory || []).slice(-9), fix];
      await saveMachine(state.activeCapture);

      $('cap-gps-badge').textContent = `±${fix.accuracyM} m`;
      $('cap-gps-detail').textContent =
        `Best fix: ${state.activeCapture.measuredGps.lat.toFixed(6)}, ${state.activeCapture.measuredGps.lng.toFixed(6)} (±${state.activeCapture.measuredGps.accuracyM} m). Wait longer for a tighter fix if needed.`;
      updateNearbyWarning();
    },
    (err) => {
      let msg = 'Location error.';
      if (err.code === err.PERMISSION_DENIED) {
        msg = 'Location permission denied. Enable location permission for this site in your browser settings.';
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        msg = 'Location unavailable. Move outdoors or check that phone location is turned on.';
      } else if (err.code === err.TIMEOUT) {
        msg = 'Location request timed out. Still trying—or you can place the pin manually on the Review map.';
      }
      $('cap-gps-badge').textContent = 'GPS issue';
      $('cap-gps-detail').textContent = msg;
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}

function stopGpsWatch() {
  if (state.gpsWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
  }
}

function updateNearbyWarning() {
  const gps = state.activeCapture?.measuredGps;
  const box = $('cap-nearby-box');
  if (!gps) {
    box.style.display = 'none';
    return;
  }
  const nearby = state.machines.filter((m) => {
    const c = getDisplayCoords(m);
    if (!c) return false;
    return haversineMetres(gps.lat, gps.lng, c.lat, c.lng) <= APP_CONFIG.nearbyRadiusMetres;
  });
  if (nearby.length === 0) {
    box.style.display = 'none';
    return;
  }
  const names = nearby.slice(0, 3).map((m) => `${m.serialLabel} (${m.name || 'Unnamed'})`).join(', ');
  box.textContent = `${nearby.length} existing machine(s) within ${APP_CONFIG.nearbyRadiusMetres} m: ${names}. Check if this is a co-located machine before duplicating.`;
  box.style.display = 'block';
}

function renderCaptureRoleButtons(selectedRole = 'Front') {
  const wrap = $('cap-role-buttons');
  wrap.innerHTML = '';
  for (const role of APP_CONFIG.photoRoles) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `role-btn ${role === selectedRole ? 'selected' : ''}`;
    btn.textContent = role;
    btn.addEventListener('click', () => {
      if (state.pendingPhoto) state.pendingPhoto.role = role;
      wrap.querySelectorAll('.role-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    wrap.appendChild(btn);
  }
}

function renderCaptureTagChips(selectedTags) {
  const wrap = $('cap-tag-chips');
  wrap.innerHTML = '';
  const all = [...new Set([...APP_CONFIG.presetTags, ...selectedTags])];
  for (const tag of all) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip ${selectedTags.includes(tag) ? 'selected' : ''}`;
    btn.textContent = tag;
    btn.addEventListener('click', () => {
      if (!state.pendingPhoto) return;
      const idx = state.pendingPhoto.tags.indexOf(tag);
      if (idx >= 0) state.pendingPhoto.tags.splice(idx, 1);
      else state.pendingPhoto.tags.push(tag);
      renderCaptureTagChips(state.pendingPhoto.tags);
    });
    wrap.appendChild(btn);
  }
}

function handleAddCustomTag() {
  if (!state.pendingPhoto) return;
  const raw = $('cap-custom-tag').value.trim();
  if (!raw) return;

  const suggestion = getTagSpellingSuggestion(raw);
  const sugBox = $('cap-spell-suggestion');

  if (suggestion && suggestion !== raw.toLowerCase()) {
    sugBox.innerHTML = `
      <span>Did you mean <strong>${suggestion}</strong>?</span>
      <div class="row-gap" style="margin-top:6px;">
        <button type="button" class="btn btn-sm btn-primary" id="btn-use-sug">Use "${suggestion}"</button>
        <button type="button" class="btn btn-sm" id="btn-keep-raw">Keep "${raw}"</button>
      </div>
    `;
    sugBox.style.display = 'block';
    $('btn-use-sug').onclick = () => {
      addTagToPending(suggestion);
      sugBox.style.display = 'none';
    };
    $('btn-keep-raw').onclick = () => {
      addTagToPending(raw);
      sugBox.style.display = 'none';
    };
  } else {
    addTagToPending(raw);
    sugBox.style.display = 'none';
  }
}

function addTagToPending(tag) {
  if (!state.pendingPhoto) return;
  if (!state.pendingPhoto.tags.includes(tag)) {
    state.pendingPhoto.tags.push(tag);
  }
  $('cap-custom-tag').value = '';
  renderCaptureTagChips(state.pendingPhoto.tags);
}

async function handleCameraInput(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !state.activeCapture) return;

  const compressed = await compressPhoto(file, {
    maxSide: state.settings.photoMaxSide,
    quality: state.settings.photoQuality,
    format: state.settings.photoFormat
  });

  const defaultRole = state.activeCapture.photos.length === 0 ? 'Front' : 'Shelf 1';
  state.pendingPhoto = {
    id: generateUuidV4(),
    compressed,
    role: defaultRole,
    tags: []
  };

  $('cap-preview-img').src = compressed.thumbDataUrl;
  $('cap-spell-suggestion').style.display = 'none';
  renderCaptureRoleButtons(defaultRole);
  renderCaptureTagChips([]);
  $('cap-label-card').style.display = 'block';
}

async function savePendingPhotoToCapture() {
  if (!state.activeCapture || !state.pendingPhoto) return;
  const p = state.pendingPhoto;
  await savePhotoBlob(p.id, state.activeCapture.id, p.compressed.blob);

  state.activeCapture.photos.push({
    id: p.id,
    role: p.role,
    tags: [...p.tags],
    width: p.compressed.width,
    height: p.compressed.height,
    originalWidth: p.compressed.originalWidth,
    originalHeight: p.compressed.originalHeight,
    mimeType: p.compressed.mimeType,
    byteSize: p.compressed.byteSize,
    thumbDataUrl: p.compressed.thumbDataUrl,
    crop: null,
    driveFileId: null,
    driveByteSize: null,
    backupState: 'not_backed_up',
    createdAt: new Date().toISOString()
  });

  // Merge photo tags into machine-level tags
  for (const t of p.tags) {
    if (!state.activeCapture.tags.includes(t)) {
      state.activeCapture.tags.push(t);
    }
  }

  await saveMachine(state.activeCapture);
  state.pendingPhoto = null;
  $('cap-label-card').style.display = 'none';
  updateCapturePhotoCount();
}

function updateCapturePhotoCount() {
  const count = state.activeCapture?.photos?.length || 0;
  $('cap-photo-count').textContent = `${count} photo(s) in this capture`;
}

async function cancelActiveCapture() {
  if (!state.activeCapture) return;
  if (!confirm('Discard this capture and all photos taken in it?')) return;
  stopGpsWatch();
  await deleteMachine(state.activeCapture.id);
  state.activeCapture = null;
  state.pendingPhoto = null;
  showScreen('home');
  await refreshDataAndHome();
}

// ==================== REVIEW & DONE ====================

async function openReviewScreen() {
  if (!state.activeCapture) return;
  const m = state.activeCapture;

  $('rev-title').textContent = `Review ${m.serialLabel}`;
  $('rev-gps-summary').textContent = m.measuredGps
    ? `Measured GPS: ${m.measuredGps.lat.toFixed(6)}, ${m.measuredGps.lng.toFixed(6)} (±${m.measuredGps.accuracyM} m)`
    : 'No GPS fix yet. You can tap the map below to set a pin position.';

  $('rev-pin-status').textContent = m.confirmedPosition
    ? `Confirmed pin: ${m.confirmedPosition.lat.toFixed(6)}, ${m.confirmedPosition.lng.toFixed(6)} (${m.confirmedPosition.method})`
    : 'Pin not nudged yet (using measured GPS).';

  // Populate known machine names datalist
  const names = [...new Set(state.machines.map((x) => x.name).filter(Boolean))];
  $('known-machine-names').innerHTML = names.map((n) => `<option value="${n.replace(/"/g, '&quot;')}"></option>`).join('');

  $('rev-name').value = m.name || '';
  $('rev-building').value = m.building || '';
  $('rev-floor').value = m.floor || '';
  $('rev-colocated').value = m.colocatedNote || '';
  $('rev-note').value = m.note || '';

  const statusSel = $('rev-status');
  statusSel.innerHTML = APP_CONFIG.machineStatuses
    .map((s) => `<option value="${s}" ${s === m.status ? 'selected' : ''}>${s}</option>`)
    .join('');

  renderReviewMachineTags();
  await renderReviewPhotos();
  showScreen('review');

  if (!state.reviewNudgeMap) {
    state.reviewNudgeMap = new NudgeMapController('nudge-map', {
      onNudge: async (lat, lng) => {
        if (!state.activeCapture) return;
        state.activeCapture.confirmedPosition = {
          lat,
          lng,
          method: 'nudged on map',
          timestamp: new Date().toISOString()
        };
        await saveMachine(state.activeCapture);
        $('rev-pin-status').textContent = `Confirmed pin: ${lat.toFixed(6)}, ${lng.toFixed(6)} (nudged on map)`;
      }
    });
  }
  state.reviewNudgeMap.render({
    measuredGps: m.measuredGps,
    confirmedPosition: m.confirmedPosition,
    basemap: state.settings.basemap,
    editable: true
  });
}

function renderReviewMachineTags() {
  const wrap = $('rev-machine-tags');
  wrap.innerHTML = '';
  const m = state.activeCapture;
  const all = [...new Set([...APP_CONFIG.presetTags, ...(m.tags || [])])];
  for (const tag of all) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip ${m.tags.includes(tag) ? 'selected' : ''}`;
    btn.textContent = tag;
    btn.addEventListener('click', async () => {
      const idx = m.tags.indexOf(tag);
      if (idx >= 0) m.tags.splice(idx, 1);
      else m.tags.push(tag);
      await saveMachine(m);
      renderReviewMachineTags();
    });
    wrap.appendChild(btn);
  }
}

async function renderReviewPhotos() {
  const m = state.activeCapture;
  $('rev-photo-count').textContent = String(m.photos.length);
  const list = $('rev-photo-list');
  list.innerHTML = '';

  for (const p of m.photos) {
    const card = document.createElement('div');
    card.className = 'photo-card col-stack';
    const roleOptions = APP_CONFIG.photoRoles
      .map((r) => `<option value="${r}" ${r === p.role ? 'selected' : ''}>${r}</option>`)
      .join('');
    card.innerHTML = `
      <img src="${p.thumbDataUrl}" alt="${p.role}" />
      <div class="muted">${p.width}×${p.height} px · ${formatBytes(p.byteSize)}</div>
      <select class="select rev-role-sel">${roleOptions}</select>
      <div class="row-gap">
        <button type="button" class="btn btn-sm rev-crop-btn">Crop</button>
        <button type="button" class="btn btn-sm rev-retake-btn">Retake</button>
        <button type="button" class="btn btn-sm btn-danger rev-del-btn">Delete</button>
      </div>
    `;
    card.querySelector('.rev-role-sel').addEventListener('change', async (e) => {
      p.role = e.target.value;
      await saveMachine(m);
    });
    card.querySelector('.rev-crop-btn').addEventListener('click', () => openCropModal(m.id, p.id, true));
    card.querySelector('.rev-retake-btn').addEventListener('click', () => {
      state.retakeTarget = { machineId: m.id, photoId: p.id, isReview: true };
      $('retake-input').click();
    });
    card.querySelector('.rev-del-btn').addEventListener('click', async () => {
      m.photos = m.photos.filter((x) => x.id !== p.id);
      await saveMachine(m);
      await renderReviewPhotos();
    });
    list.appendChild(card);
  }
}

async function finishActiveCapture() {
  if (!state.activeCapture) return;
  const m = state.activeCapture;
  m.name = $('rev-name').value.trim();
  m.building = $('rev-building').value.trim();
  m.floor = $('rev-floor').value.trim();
  m.status = $('rev-status').value;
  m.colocatedNote = $('rev-colocated').value.trim();
  m.note = $('rev-note').value.trim();
  m.isDraft = false;
  m.backupState = 'not_backed_up';
  m.backupError = null;

  stopGpsWatch();
  const saved = await saveMachine(m);
  state.activeCapture = null;
  state.pendingPhoto = null;

  showScreen('home');
  await refreshDataAndHome();
  // Queue immediate backup if online & signed in
  if (navigator.onLine && getAuthState().signedIn) {
    await syncSingleMachine(saved);
    await refreshDataAndHome();
  }
}

// ==================== RETAKE & MANUAL CROP ====================

async function handleRetakeFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  const target = state.retakeTarget;
  state.retakeTarget = null;
  if (!file || !target) return;

  const compressed = await compressPhoto(file, {
    maxSide: state.settings.photoMaxSide,
    quality: state.settings.photoQuality,
    format: state.settings.photoFormat
  });

  const m = target.isReview ? state.activeCapture : await getMachine(target.machineId);
  if (!m) return;
  const p = m.photos.find((x) => x.id === target.photoId);
  if (!p) return;

  await savePhotoBlob(p.id, m.id, compressed.blob);
  Object.assign(p, {
    width: compressed.width,
    height: compressed.height,
    originalWidth: compressed.originalWidth,
    originalHeight: compressed.originalHeight,
    mimeType: compressed.mimeType,
    byteSize: compressed.byteSize,
    thumbDataUrl: compressed.thumbDataUrl,
    crop: null,
    backupState: 'not_backed_up'
  });

  if (!target.isReview) {
    m.backupState = 'not_backed_up';
  }
  await saveMachine(m);
  if (target.isReview) await renderReviewPhotos();
  else await openDetailScreen(m.id);
}

async function openCropModal(machineId, photoId, isReview) {
  const blob = await getPhotoBlob(photoId);
  if (!blob) {
    alert('Full photo is not on device. Re-download from Drive first.');
    return;
  }
  const img = await loadImageFromBlob(blob);
  const canvas = $('crop-canvas');
  const maxDrawW = 500;
  const scale = Math.min(1, maxDrawW / img.width);
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);

  const rect = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  state.cropContext = { machineId, photoId, isReview, img, rect, dragging: false, startX: 0, startY: 0 };
  drawCropCanvas();
  $('crop-modal').classList.add('open');

  canvas.onpointerdown = (ev) => {
    const r = canvas.getBoundingClientRect();
    state.cropContext.dragging = true;
    state.cropContext.startX = (ev.clientX - r.left) / r.width;
    state.cropContext.startY = (ev.clientY - r.top) / r.height;
  };
  canvas.onpointermove = (ev) => {
    if (!state.cropContext?.dragging) return;
    const r = canvas.getBoundingClientRect();
    const curX = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    const curY = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
    const sx = state.cropContext.startX;
    const sy = state.cropContext.startY;
    state.cropContext.rect = {
      x: Math.min(sx, curX),
      y: Math.min(sy, curY),
      w: Math.max(0.05, Math.abs(curX - sx)),
      h: Math.max(0.05, Math.abs(curY - sy))
    };
    drawCropCanvas();
  };
  canvas.onpointerup = () => {
    if (state.cropContext) state.cropContext.dragging = false;
  };
}

function drawCropCanvas() {
  const ctxObj = state.cropContext;
  if (!ctxObj) return;
  const canvas = $('crop-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(ctxObj.img, 0, 0, canvas.width, canvas.height);

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const rx = ctxObj.rect.x * canvas.width;
  const ry = ctxObj.rect.y * canvas.height;
  const rw = ctxObj.rect.w * canvas.width;
  const rh = ctxObj.rect.h * canvas.height;

  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, rw, rh);
  ctx.clip();
  ctx.drawImage(ctxObj.img, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.strokeRect(rx, ry, rw, rh);
}

async function applyCrop() {
  const ctxObj = state.cropContext;
  if (!ctxObj) return;
  const blob = await getPhotoBlob(ctxObj.photoId);
  if (!blob) return;

  const cropped = await cropPhotoBlob(blob, ctxObj.rect, {
    maxSide: state.settings.photoMaxSide,
    quality: state.settings.photoQuality,
    format: state.settings.photoFormat
  });

  const m = ctxObj.isReview ? state.activeCapture : await getMachine(ctxObj.machineId);
  const p = m?.photos.find((x) => x.id === ctxObj.photoId);
  if (m && p) {
    await savePhotoBlob(p.id, m.id, cropped.blob);
    p.width = cropped.width;
    p.height = cropped.height;
    p.byteSize = cropped.byteSize;
    p.mimeType = cropped.mimeType;
    p.thumbDataUrl = cropped.thumbDataUrl;
    p.crop = ctxObj.rect;
    p.backupState = 'not_backed_up';
    if (!ctxObj.isReview) m.backupState = 'not_backed_up';
    await saveMachine(m);
  }

  $('crop-modal').classList.remove('open');
  state.cropContext = null;
  if (ctxObj.isReview) await renderReviewPhotos();
  else if (m) await openDetailScreen(m.id);
}

// ==================== LIST & DETAIL ====================

function populateListFilters() {
  const st = $('filter-status');
  const prevS = st.value;
  st.innerHTML = '<option value="">All statuses</option>' +
    APP_CONFIG.machineStatuses.map((s) => `<option value="${s}">${s}</option>`).join('');
  st.value = prevS;

  const tg = $('filter-tag');
  const prevT = tg.value;
  const allTags = [...new Set(state.machines.flatMap((m) => m.tags || []))].sort();
  tg.innerHTML = '<option value="">All tags</option>' +
    allTags.map((t) => `<option value="${t}">${t}</option>`).join('');
  tg.value = prevT;
}

function renderListTable() {
  const statusF = $('filter-status').value;
  const tagF = $('filter-tag').value;
  let rows = state.machines.filter((m) => {
    if (statusF && m.status !== statusF) return false;
    if (tagF && !(m.tags || []).includes(tagF)) return false;
    return true;
  });

  const { field, dir } = state.listSort;
  rows.sort((a, b) => {
    const va = String(a[field] || '');
    const vb = String(b[field] || '');
    return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
  });

  const tbody = $('machine-table-body');
  tbody.innerHTML = '';
  for (const m of rows) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    const badgeClass = m.backupState === 'verified' ? 'badge-ok' : m.backupState === 'failed' ? 'badge-err' : 'badge-warn';
    const badgeLabel = m.backupState === 'verified' ? 'Verified' : m.backupState === 'failed' ? 'Failed' : m.backupState === 'uploading' ? 'Uploading' : 'Not backed up';
    tr.innerHTML = `
      <td><strong>${m.serialLabel}</strong></td>
      <td>${m.name || '<span class="muted">Unnamed</span>'}<div class="muted">${m.building || ''}</div></td>
      <td>${m.status}</td>
      <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
    `;
    tr.addEventListener('click', () => openDetailScreen(m.id));
    tbody.appendChild(tr);
  }
}

async function openDetailScreen(id) {
  const m = await getMachine(id);
  if (!m) return;
  state.detailMachineId = id;
  showScreen('detail');

  $('det-title').textContent = `${m.serialLabel}${m.name ? ' · ' + m.name : ''}`;
  const coords = getDisplayCoords(m);
  $('det-meta').textContent = coords
    ? `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)} (${coords.isConfirmed ? 'confirmed pin' : `measured ±${m.measuredGps?.accuracyM ?? '?'} m`})`
    : 'No coordinates recorded';

  const badge = $('det-backup-badge');
  badge.className = 'badge ' + (m.backupState === 'verified' ? 'badge-ok' : m.backupState === 'failed' ? 'badge-err' : 'badge-warn');
  badge.textContent = m.backupState === 'verified' ? 'Backed up & verified' : m.backupState === 'failed' ? `Failed: ${m.backupError || 'error'}` : 'Not backed up';

  const dev = Boolean(state.settings.developerMode);
  $('det-dev-notice').style.display = dev ? 'block' : 'none';
  $('det-nudge-card').style.display = dev ? 'block' : 'none';

  if (dev) {
    if (!state.detailNudgeMap) {
      state.detailNudgeMap = new NudgeMapController('det-nudge-map', {
        onNudge: async (lat, lng) => {
          m.confirmedPosition = { lat, lng, method: 'nudged in developer mode', timestamp: new Date().toISOString() };
          m.backupState = 'not_backed_up';
          await saveMachine(m);
          await openDetailScreen(m.id);
        }
      });
    }
    state.detailNudgeMap.render({
      measuredGps: m.measuredGps,
      confirmedPosition: m.confirmedPosition,
      basemap: state.settings.basemap,
      editable: true
    });
  }

  const fieldsCard = $('det-fields-card');
  if (dev) {
    fieldsCard.innerHTML = `
      <div><label class="field-label">Name / Brand</label><input id="det-name" class="input" value="${(m.name || '').replace(/"/g, '&quot;')}" /></div>
      <div><label class="field-label">Building</label><input id="det-building" class="input" value="${(m.building || '').replace(/"/g, '&quot;')}" /></div>
      <div><label class="field-label">Floor</label><input id="det-floor" class="input" value="${(m.floor || '').replace(/"/g, '&quot;')}" /></div>
      <div><label class="field-label">Status</label><select id="det-status" class="select">${APP_CONFIG.machineStatuses.map((s) => `<option value="${s}" ${s === m.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label class="field-label">Note</label><textarea id="det-note" class="textarea">${m.note || ''}</textarea></div>
      <button type="button" id="btn-det-save-edits" class="btn btn-primary btn-sm">Save edits (marks Not backed up)</button>
    `;
    $('btn-det-save-edits').onclick = async () => {
      m.name = $('det-name').value.trim();
      m.building = $('det-building').value.trim();
      m.floor = $('det-floor').value.trim();
      m.status = $('det-status').value;
      m.note = $('det-note').value.trim();
      m.backupState = 'not_backed_up';
      await saveMachine(m);
      await refreshDataAndHome();
      await openDetailScreen(m.id);
    };
  } else {
    fieldsCard.innerHTML = `
      <div><strong>Status:</strong> ${m.status}</div>
      <div><strong>Building / Floor:</strong> ${m.building || '—'} ${m.floor ? `(${m.floor})` : ''}</div>
      <div><strong>Tags:</strong> ${(m.tags || []).join(', ') || '—'}</div>
      <div><strong>Co-located note:</strong> ${m.colocatedNote || '—'}</div>
      <div><strong>Note:</strong> ${m.note || '—'}</div>
    `;
  }

  const photoList = $('det-photo-list');
  photoList.innerHTML = '';
  for (const p of (m.photos || [])) {
    const localBlob = await getPhotoBlob(p.id);
    const card = document.createElement('div');
    card.className = 'photo-card col-stack';
    card.innerHTML = `
      <img src="${p.thumbDataUrl}" alt="${p.role}" />
      <div><strong>${p.role}</strong> · ${p.width}×${p.height} px · ${formatBytes(p.byteSize)}</div>
      <div class="muted">Tags: ${(p.tags || []).join(', ') || 'none'}</div>
      <div class="muted">${localBlob ? 'Full photo on device' : 'Evicted from device (in Drive)'}</div>
      <div class="row-gap">
        ${!localBlob && p.driveFileId ? '<button type="button" class="btn btn-sm det-dl-btn">Re-download from Drive</button>' : ''}
        ${dev && localBlob ? '<button type="button" class="btn btn-sm det-crop-btn">Crop</button>' : ''}
      </div>
    `;
    const dlBtn = card.querySelector('.det-dl-btn');
    if (dlBtn) {
      dlBtn.onclick = async () => {
        try {
          const blob = await downloadDrivePhotoBlob(p.driveFileId, state.clientId);
          await savePhotoBlob(p.id, m.id, blob);
          await openDetailScreen(m.id);
        } catch (err) {
          alert(err.message);
        }
      };
    }
    const cropBtn = card.querySelector('.det-crop-btn');
    if (cropBtn) {
      cropBtn.onclick = () => openCropModal(m.id, p.id, false);
    }
    photoList.appendChild(card);
  }
}

// ==================== DRIVE BACKUP, EXPORT & SETTINGS ====================

async function handleSignIn() {
  try {
    await requestDriveToken(state.clientId, { prompt: 'consent' });
    const auth = getAuthState();
    if (auth.role === 'developer') {
      state.settings = await saveAppSettings({ developerMode: true });
    }
    await refreshDataAndHome();
    await renderSettingsScreen();
    await autoSyncPending();
  } catch (err) {
    alert(err.message);
  }
}

async function syncSingleMachine(machine) {
  try {
    machine.backupState = 'uploading';
    await saveMachine(machine);
    await backupMachineToDrive(machine, state.clientId);
  } catch (err) {
    machine.backupState = 'failed';
    machine.backupError = err.message;
    await saveMachine(machine);
  }
}

async function syncAllPending() {
  if (state.isSyncing) return;
  if (!navigator.onLine) {
    alert('You are offline. Records will stay safely on your phone until back online.');
    return;
  }
  state.isSyncing = true;
  try {
    if (!getAuthState().signedIn) {
      await requestDriveToken(state.clientId, { prompt: '' });
    }
    const all = await listMachines({ includeDrafts: false });
    const pending = all.filter((m) => m.backupState !== 'verified');
    for (const m of pending) {
      await syncSingleMachine(m);
    }
    await refreshDataAndHome();
    await renderSettingsScreen();
  } catch (err) {
    alert(`Backup paused: ${err.message}`);
  } finally {
    state.isSyncing = false;
  }
}

async function autoSyncPending() {
  if (!navigator.onLine || !getAuthState().signedIn) return;
  await syncAllPending();
}

async function handleRestoreFromDrive() {
  try {
    if (!getAuthState().signedIn) {
      await requestDriveToken(state.clientId, { prompt: '' });
    }
    const count = await restoreAllFromDrive(state.clientId, (msg) => {
      $('set-drive-status').textContent = msg;
    });
    await refreshDataAndHome();
    await renderSettingsScreen();
    alert(`Restored ${count} machine(s) from Google Drive.`);
  } catch (err) {
    alert(`Restore failed: ${err.message}`);
  }
}

async function renderSettingsScreen() {
  const auth = getAuthState();
  $('set-drive-status').textContent = auth.signedIn
    ? `Signed in as ${auth.email || 'Google user'} (${auth.role === 'developer' ? 'Developer' : 'Community'})`
    : 'Not signed in.';
  $('btn-drive-signin').disabled = auth.signedIn;
  $('btn-drive-signout').disabled = !auth.signedIn;

  $('set-max-side').value = state.settings.photoMaxSide;
  $('set-quality').value = state.settings.photoQuality;
  $('set-format').value = state.settings.photoFormat;
  $('set-dev-mode').checked = Boolean(state.settings.developerMode);

  const stats = await getLocalBlobStats();
  let estText = `Local photos: ${stats.count} (${formatBytes(stats.totalBytes)})`;
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    const used = formatBytes(est.usage || 0);
    const quota = formatBytes(est.quota || 0);
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    estText += ` · Browser storage: ${used} / ${quota} (persistent: ${persisted ? 'yes' : 'no'})`;
  }
  $('set-storage-info').textContent = estText;
}

async function handleLegibilityTest(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  const compressed = await compressPhoto(file, {
    maxSide: state.settings.photoMaxSide,
    quality: state.settings.photoQuality,
    format: state.settings.photoFormat
  });

  const url = URL.createObjectURL(compressed.blob);
  const resDiv = $('legibility-test-result');
  resDiv.style.display = 'block';
  resDiv.innerHTML = `
    <div class="banner banner-info">
      <strong>Compression result:</strong> ${compressed.originalWidth}×${compressed.originalHeight} (${formatBytes(file.size)})
      &rarr; ${compressed.width}×${compressed.height} (${formatBytes(compressed.byteSize)}, ${compressed.mimeType})
    </div>
    <img src="${url}" alt="Legibility test" style="width:100%;border-radius:8px;border:1px solid var(--border);" />
    <p class="muted">Pinch-zoom or open image to verify shelf labels, prices, and contact numbers are sharp.</p>
  `;
}

async function handleExportZip() {
  const machines = await listMachines({ includeDrafts: false });
  const encoder = new TextEncoder();
  const entries = [
    { name: 'machines.json', data: encoder.encode(JSON.stringify(machines, null, 2)) }
  ];

  for (const m of machines) {
    for (const p of (m.photos || [])) {
      const blob = await getPhotoBlob(p.id);
      if (blob) {
        const ext = p.mimeType === 'image/webp' ? 'webp' : 'jpg';
        const safeRole = (p.role || 'photo').replace(/[^a-zA-Z0-9_-]/g, '_');
        const buf = new Uint8Array(await blob.arrayBuffer());
        entries.push({ name: `photos/${m.id}/${p.id}_${safeRole}.${ext}`, data: buf });
      }
    }
  }

  const zipBlob = createZipBlob(entries);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zipBlob);
  a.download = `vending-survey-export-${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function handleImportZip(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  try {
    const buf = await file.arrayBuffer();
    const entries = parseZipBuffer(buf);
    const jsonEntry = entries.find((x) => x.name === 'machines.json');
    if (!jsonEntry) throw new Error('machines.json not found in ZIP');

    const machines = JSON.parse(new TextDecoder().decode(jsonEntry.data));
    const blobMap = new Map();
    for (const entry of entries) {
      if (entry.name.startsWith('photos/')) {
        const parts = entry.name.split('/');
        const filename = parts[2] || '';
        const photoId = filename.split('_')[0];
        if (photoId) blobMap.set(photoId, entry.data);
      }
    }

    for (const m of machines) {
      for (const p of (m.photos || [])) {
        const raw = blobMap.get(p.id);
        if (raw) {
          await savePhotoBlob(p.id, m.id, new Blob([raw], { type: p.mimeType || 'image/jpeg' }));
        }
      }
      await saveMachine({ ...m, isDraft: false });
    }

    await refreshDataAndHome();
    await renderSettingsScreen();
    alert(`Imported ${machines.length} machine(s) from ZIP.`);
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
}

init();

function triggerSingleShotRadius(radiusMetres, activeBtn) {
  const statusEl = $('map-gps-status');
  document.querySelectorAll('.radius-btn').forEach((b) => b.classList.remove('active'));
  activeBtn.classList.add('active');

  if (!navigator.geolocation) {
    statusEl.textContent = 'Geolocation is not supported in this browser.';
    statusEl.style.display = 'block';
    return;
  }

  statusEl.textContent = 'Checking GPS once...';
  statusEl.style.display = 'block';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      state.mainMap.init(state.settings.basemap);
      state.mainMap.showUserRadius(latitude, longitude, radiusMetres);
      $('btn-clear-radius').style.display = 'inline-flex';
      const label = radiusMetres >= 1000 ? `${radiusMetres / 1000} km` : `${radiusMetres} m`;
      statusEl.textContent = `Showing ${label} radius around you (±${Math.round(accuracy)} m). GPS stopped.`;
    },
    (err) => {
      let msg = 'Could not get location.';
      if (err.code === err.PERMISSION_DENIED) {
        msg = 'Location permission denied. Enable location in browser settings.';
      } else if (err.code === err.POSITION_UNAVAILABLE) {
        msg = 'Location unavailable. Check that phone GPS is turned on.';
      } else if (err.code === err.TIMEOUT) {
        msg = 'GPS timed out. Try tapping the radius button again outdoors.';
      }
      statusEl.textContent = msg;
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}
