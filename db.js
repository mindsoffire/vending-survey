import { APP_CONFIG } from './config.js';

const DB_NAME = 'vending_survey_db';
const DB_VERSION = 1;

let dbPromise = null;

export function generateUuidV4() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      // Schema v1
      if (oldVersion < 1) {
        const machines = db.createObjectStore('machines', { keyPath: 'id' });
        machines.createIndex('updatedAt', 'updatedAt', { unique: false });
        machines.createIndex('backupState', 'backupState', { unique: false });
        machines.createIndex('isDraft', 'isDraft', { unique: false });

        const blobs = db.createObjectStore('photoBlobs', { keyPath: 'photoId' });
        blobs.createIndex('machineId', 'machineId', { unique: false });

        db.createObjectStore('settings', { keyPath: 'key' });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // Future migrations: if (oldVersion < 2) { ... }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getSetting(key, fallback = undefined) {
  const db = await openDb();
  const tx = db.transaction('settings', 'readonly');
  const row = await reqPromise(tx.objectStore('settings').get(key));
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  const db = await openDb();
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put({ key, value });
  await txDone(tx);
}

export async function getAllSettings() {
  const db = await openDb();
  const tx = db.transaction('settings', 'readonly');
  const rows = await reqPromise(tx.objectStore('settings').getAll());
  const map = { ...APP_CONFIG.defaultSettings };
  for (const r of rows) {
    if (r.key === 'appSettings' && r.value && typeof r.value === 'object') {
      Object.assign(map, r.value);
    }
  }
  return map;
}

export async function saveAppSettings(partial) {
  const current = await getAllSettings();
  const next = { ...current, ...partial };
  await setSetting('appSettings', next);
  return next;
}

export async function getOrCreateDeviceId() {
  let id = await getSetting('deviceId');
  if (!id) {
    id = generateUuidV4();
    await setSetting('deviceId', id);
  }
  return id;
}

export async function getNextSerialLabel() {
  const db = await openDb();
  const tx = db.transaction('settings', 'readwrite');
  const store = tx.objectStore('settings');
  const row = await reqPromise(store.get('serialCounter'));
  const nextNum = (row ? Number(row.value) : 0) + 1;
  store.put({ key: 'serialCounter', value: nextNum });
  await txDone(tx);
  return `VM-${String(nextNum).padStart(6, '0')}`;
}

export async function saveMachine(machine) {
  const db = await openDb();
  const tx = db.transaction('machines', 'readwrite');
  const record = {
    ...machine,
    schemaVersion: APP_CONFIG.schemaVersion,
    updatedAt: new Date().toISOString()
  };
  tx.objectStore('machines').put(record);
  await txDone(tx);
  return record;
}

export async function getMachine(id) {
  const db = await openDb();
  const tx = db.transaction('machines', 'readonly');
  return reqPromise(tx.objectStore('machines').get(id));
}

export async function listMachines({ includeDrafts = false } = {}) {
  const db = await openDb();
  const tx = db.transaction('machines', 'readonly');
  const all = await reqPromise(tx.objectStore('machines').getAll());
  const filtered = includeDrafts ? all : all.filter((m) => !m.isDraft);
  filtered.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return filtered;
}

export async function getActiveDraft() {
  const db = await openDb();
  const tx = db.transaction('machines', 'readonly');
  const all = await reqPromise(tx.objectStore('machines').getAll());
  const drafts = all.filter((m) => m.isDraft);
  drafts.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return drafts[0] || null;
}

export async function deleteMachine(id) {
  const db = await openDb();
  const tx = db.transaction(['machines', 'photoBlobs'], 'readwrite');
  tx.objectStore('machines').delete(id);
  const blobIndex = tx.objectStore('photoBlobs').index('machineId');
  const keys = await reqPromise(blobIndex.getAllKeys(id));
  for (const key of keys) {
    tx.objectStore('photoBlobs').delete(key);
  }
  await txDone(tx);
}

export async function savePhotoBlob(photoId, machineId, blob) {
  const db = await openDb();
  const tx = db.transaction('photoBlobs', 'readwrite');
  tx.objectStore('photoBlobs').put({
    photoId,
    machineId,
    blob,
    byteSize: blob.size,
    updatedAt: new Date().toISOString()
  });
  await txDone(tx);
}

export async function getPhotoBlob(photoId) {
  const db = await openDb();
  const tx = db.transaction('photoBlobs', 'readonly');
  const row = await reqPromise(tx.objectStore('photoBlobs').get(photoId));
  return row ? row.blob : null;
}

export async function deletePhotoBlob(photoId) {
  const db = await openDb();
  const tx = db.transaction('photoBlobs', 'readwrite');
  tx.objectStore('photoBlobs').delete(photoId);
  await txDone(tx);
}

export async function getLocalBlobStats() {
  const db = await openDb();
  const tx = db.transaction('photoBlobs', 'readonly');
  const all = await reqPromise(tx.objectStore('photoBlobs').getAll());
  let totalBytes = 0;
  for (const row of all) {
    totalBytes += row.byteSize || (row.blob ? row.blob.size : 0);
  }
  return { count: all.length, totalBytes };
}

/**
 * Working-set eviction: removes local full-res photo blobs ONLY for machines
 * whose backupState === 'verified' and where every photo has a verified driveFileId,
 * keeping the most recent `keepCount` verified machines' blobs on-device.
 */
export async function pruneWorkingSetBlobs(keepCount = 25) {
  const machines = await listMachines({ includeDrafts: false });
  const verified = machines
    .filter((m) => m.backupState === 'verified')
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  const toEvict = verified.slice(keepCount);
  if (toEvict.length === 0) return { evictedPhotos: 0, freedBytes: 0 };

  const db = await openDb();
  const tx = db.transaction('photoBlobs', 'readwrite');
  const store = tx.objectStore('photoBlobs');
  let evictedPhotos = 0;
  let freedBytes = 0;

  for (const m of toEvict) {
    for (const p of (m.photos || [])) {
      if (p.driveFileId && p.backupState === 'verified') {
        const existing = await reqPromise(store.get(p.id));
        if (existing) {
          freedBytes += existing.byteSize || 0;
          store.delete(p.id);
          evictedPhotos++;
        }
      }
    }
  }
  await txDone(tx);
  return { evictedPhotos, freedBytes };
}
