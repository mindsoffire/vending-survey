import { APP_CONFIG } from './config.js';
import { getPhotoBlob, saveMachine, savePhotoBlob } from './db.js';

let tokenClient = null;
let currentAccessToken = null;
let tokenExpiresAt = 0;

export function getAuthState() {
  const valid = Boolean(currentAccessToken && Date.now() < tokenExpiresAt - 30_000);
  return {
    signedIn: valid,
    expiresAt: tokenExpiresAt
  };
}

export function signOutDrive() {
  if (currentAccessToken && window.google?.accounts?.oauth2?.revoke) {
    try {
      window.google.accounts.oauth2.revoke(currentAccessToken, () => {});
    } catch (_) {}
  }
  currentAccessToken = null;
  tokenExpiresAt = 0;
}

export function requestDriveToken(clientId, { prompt = '' } = {}) {
  return new Promise((resolve, reject) => {
    const effectiveId = (clientId || APP_CONFIG.googleOAuthClientId || '').trim();
    if (!effectiveId) {
      reject(new Error('No Google OAuth Client ID configured. Add it in Settings or config.js.'));
      return;
    }
    if (!window.google?.accounts?.oauth2?.initTokenClient) {
      reject(new Error('Google Identity Services script is not loaded (check internet connection).'));
      return;
    }

    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: effectiveId,
      scope: APP_CONFIG.driveScope,
      callback: (resp) => {
        if (resp.error) {
          reject(new Error(resp.error_description || resp.error));
          return;
        }
        currentAccessToken = resp.access_token;
        tokenExpiresAt = Date.now() + Number(resp.expires_in || 3600) * 1000;
        resolve(currentAccessToken);
      },
      error_callback: (err) => {
        reject(new Error(err?.message || 'Google sign-in popup was closed or blocked.'));
      }
    });

    tokenClient.requestAccessToken({ prompt });
  });
}

async function ensureToken(clientId) {
  if (getAuthState().signedIn) return currentAccessToken;
  return requestDriveToken(clientId, { prompt: '' });
}

async function driveFetch(url, options = {}, clientId = '') {
  let token = await ensureToken(clientId);
  let res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });

  // Handle expired/revoked token gracefully once
  if (res.status === 401) {
    currentAccessToken = null;
    token = await requestDriveToken(clientId, { prompt: '' });
    res = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`
      }
    });
  }

  if (!res.ok) {
    let msg = `Drive API error (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error?.message) msg = data.error.message;
    } catch (_) {}
    throw new Error(msg);
  }
  return res;
}

async function findOrCreateFolder(name, parentId = null, clientId = '') {
  const escaped = name.replace(/'/g, "\\'");
  let q = `mimeType='application/vnd.google-apps.folder' and name='${escaped}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=5`;
  const res = await driveFetch(listUrl, {}, clientId);
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  const createRes = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {})
    })
  }, clientId);
  const created = await createRes.json();
  return created.id;
}

async function findExistingFileInFolder(folderId, { appPropKey, appPropVal, name }, clientId) {
  let q = `'${folderId}' in parents and trashed=false`;
  if (appPropKey && appPropVal) {
    q += ` and appProperties has { key='${appPropKey}' and value='${appPropVal}' }`;
  } else if (name) {
    q += ` and name='${name.replace(/'/g, "\\'")}'`;
  }
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,size)&pageSize=5`;
  const res = await driveFetch(url, {}, clientId);
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

async function uploadMultipartFile({ existingId, folderId, name, mimeType, blob, appProperties }, clientId) {
  const metadata = {
    name,
    mimeType,
    ...(appProperties ? { appProperties } : {}),
    ...(!existingId && folderId ? { parents: [folderId] } : {})
  };

  const boundary = `vs_${Math.random().toString(36).slice(2)}`;
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const mediaHeader = `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const closeDelim = `\r\n--${boundary}--`;
  const bodyBlob = new Blob([metaPart, mediaHeader, blob, closeDelim], {
    type: `multipart/related; boundary=${boundary}`
  });

  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name,size`
    : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size`;

  const res = await driveFetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    body: bodyBlob
  }, clientId);

  return res.json();
}

async function verifyDriveFile(fileId, expectedByteSize, clientId) {
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,size,trashed`,
    {},
    clientId
  );
  const meta = await res.json();
  if (meta.trashed) throw new Error('Uploaded file is in Trash');
  const remoteSize = Number(meta.size);
  if (remoteSize !== expectedByteSize) {
    throw new Error(`Size mismatch after upload (local ${expectedByteSize} B vs Drive ${remoteSize} B)`);
  }
  return remoteSize;
}

/**
 * Idempotent backup & verification for a single machine record.
 * Folder layout: Vending Survey / <serialLabel>_<machineId> / machine_<machineId>.json + photo_<photoId>_<role>.ext
 */
export async function backupMachineToDrive(machine, clientId, onProgress = () => {}) {
  onProgress('uploading');
  const rootId = await findOrCreateFolder(APP_CONFIG.driveRootFolderName, null, clientId);
  const folderName = `${machine.serialLabel || 'VM'}_${machine.id}`;
  const machineFolderId = machine.driveFolderId || await findOrCreateFolder(folderName, rootId, clientId);

  const updatedPhotos = [];
  for (const photo of (machine.photos || [])) {
    const ext = photo.mimeType === 'image/webp' ? 'webp' : 'jpg';
    const safeRole = (photo.role || 'photo').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `photo_${photo.id}_${safeRole}.${ext}`;

    const localBlob = await getPhotoBlob(photo.id);
    if (!localBlob) {
      if (photo.driveFileId && photo.backupState === 'verified') {
        updatedPhotos.push(photo);
        continue;
      }
      throw new Error(`Local photo ${fileName} missing before Drive verification`);
    }

    const existing = photo.driveFileId
      ? { id: photo.driveFileId }
      : await findExistingFileInFolder(machineFolderId, { appPropKey: 'photoId', appPropVal: photo.id }, clientId);

    const uploaded = await uploadMultipartFile({
      existingId: existing?.id || null,
      folderId: machineFolderId,
      name: fileName,
      mimeType: photo.mimeType || 'image/jpeg',
      blob: localBlob,
      appProperties: { machineId: machine.id, photoId: photo.id, kind: 'photo' }
    }, clientId);

    const verifiedSize = await verifyDriveFile(uploaded.id, localBlob.size, clientId);

    updatedPhotos.push({
      ...photo,
      driveFileId: uploaded.id,
      driveByteSize: verifiedSize,
      backupState: 'verified'
    });
  }

  // Upload machine metadata JSON (without raw blobs)
  const jsonPayload = JSON.stringify({
    ...machine,
    driveFolderId: machineFolderId,
    photos: updatedPhotos,
    backupState: 'verified',
    lastBackedUpAt: new Date().toISOString()
  }, null, 2);
  const jsonBlob = new Blob([jsonPayload], { type: 'application/json' });
  const jsonName = `machine_${machine.id}.json`;

  const existingJson = await findExistingFileInFolder(
    machineFolderId,
    { appPropKey: 'kind', appPropVal: `machine_json_${machine.id}` },
    clientId
  );

  const uploadedJson = await uploadMultipartFile({
    existingId: existingJson?.id || null,
    folderId: machineFolderId,
    name: jsonName,
    mimeType: 'application/json',
    blob: jsonBlob,
    appProperties: { machineId: machine.id, kind: `machine_json_${machine.id}` }
  }, clientId);

  await verifyDriveFile(uploadedJson.id, jsonBlob.size, clientId);

  const saved = await saveMachine({
    ...machine,
    driveFolderId: machineFolderId,
    photos: updatedPhotos,
    backupState: 'verified',
    backupError: null,
    lastBackedUpAt: new Date().toISOString()
  });

  onProgress('verified');
  return saved;
}

export async function downloadDrivePhotoBlob(driveFileId, clientId) {
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
    {},
    clientId
  );
  return res.blob();
}

/**
 * Restore all machines & photos from the "Vending Survey" folder in Google Drive.
 */
export async function restoreAllFromDrive(clientId, onStatus = () => {}) {
  onStatus('Finding Vending Survey folder...');
  const rootId = await findOrCreateFolder(APP_CONFIG.driveRootFolderName, null, clientId);

  const foldersRes = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id,name)&pageSize=1000`,
    {},
    clientId
  );
  const folders = (await foldersRes.json()).files || [];
  let restoredCount = 0;

  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    onStatus(`Restoring ${i + 1}/${folders.length}: ${folder.name}...`);
    const filesRes = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folder.id}' in parents and trashed=false`)}&fields=files(id,name,mimeType,size)&pageSize=100`,
      {},
      clientId
    );
    const files = (await filesRes.json()).files || [];
    const jsonFile = files.find((f) => f.name.startsWith('machine_') && f.name.endsWith('.json'));
    if (!jsonFile) continue;

    const jsonRes = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${jsonFile.id}?alt=media`,
      {},
      clientId
    );
    const machine = await jsonRes.json();

    for (const photo of (machine.photos || [])) {
      if (photo.driveFileId) {
        const blob = await downloadDrivePhotoBlob(photo.driveFileId, clientId);
        await savePhotoBlob(photo.id, machine.id, blob);
      }
    }

    await saveMachine({
      ...machine,
      isDraft: false,
      driveFolderId: folder.id,
      backupState: 'verified'
    });
    restoredCount++;
  }

  return restoredCount;
}
