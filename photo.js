import { APP_CONFIG } from './config.js';

/**
 * Load an image File/Blob into an HTMLImageElement (with createImageBitmap fallback).
 */
export function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image'));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas compression failed'));
      },
      mimeType,
      quality
    );
  });
}

/**
 * Resize and compress a photo on-device.
 * Preserves aspect ratio; longest side is capped at maxSide.
 */
export async function compressPhoto(fileOrBlob, { maxSide = 1600, quality = 0.78, format = 'image/jpeg' } = {}) {
  const img = await loadImageFromBlob(fileOrBlob);
  const origW = img.naturalWidth || img.width;
  const origH = img.naturalHeight || img.height;

  const longest = Math.max(origW, origH);
  const scale = longest > maxSide ? maxSide / longest : 1;
  const targetW = Math.max(1, Math.round(origW * scale));
  const targetH = Math.max(1, Math.round(origH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, targetW, targetH);

  let blob = await canvasToBlob(canvas, format, quality);
  // Fallback to JPEG if WebP is unsupported in this browser
  if (format === 'image/webp' && blob.type !== 'image/webp') {
    blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  }

  const thumbDataUrl = createThumbnailDataUrl(img, 240);

  return {
    blob,
    width: targetW,
    height: targetH,
    originalWidth: origW,
    originalHeight: origH,
    mimeType: blob.type,
    byteSize: blob.size,
    thumbDataUrl
  };
}

/**
 * Apply a manual normalized crop { x, y, w, h } (values 0..1) to an existing photo blob.
 * Replaces the stored photo with the cropped version (simple single-copy model).
 */
export async function cropPhotoBlob(blob, cropRect, { maxSide = 1600, quality = 0.78, format = 'image/jpeg' } = {}) {
  const img = await loadImageFromBlob(blob);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;

  const sx = Math.max(0, Math.round(cropRect.x * srcW));
  const sy = Math.max(0, Math.round(cropRect.y * srcH));
  const sw = Math.max(10, Math.round(cropRect.w * srcW));
  const sh = Math.max(10, Math.round(cropRect.h * srcH));

  const longest = Math.max(sw, sh);
  const scale = longest > maxSide ? maxSide / longest : 1;
  const outW = Math.max(1, Math.round(sw * scale));
  const outH = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);

  const outBlob = await canvasToBlob(canvas, format, quality);
  const croppedImg = await loadImageFromBlob(outBlob);
  const thumbDataUrl = createThumbnailDataUrl(croppedImg, 240);

  return {
    blob: outBlob,
    width: outW,
    height: outH,
    mimeType: outBlob.type,
    byteSize: outBlob.size,
    thumbDataUrl
  };
}

export function createThumbnailDataUrl(img, maxSide = 240) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, tw, th);
  return canvas.toDataURL('image/jpeg', 0.65);
}

/**
 * Simple Levenshtein distance for gentle custom-tag spellcheck suggestions.
 * Never auto-replaces; only returns a suggestion if close to a known word.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

export function getTagSpellingSuggestion(input) {
  const clean = (input || '').trim().toLowerCase();
  if (!clean || clean.length < 3) return null;
  const dict = [...new Set([...APP_CONFIG.presetTags, ...APP_CONFIG.spellcheckDictionary])];
  if (dict.includes(clean)) return null;

  let best = null;
  let bestDist = Infinity;
  for (const word of dict) {
    const maxAllowed = word.length <= 5 ? 1 : 2;
    const d = levenshtein(clean, word);
    if (d > 0 && d <= maxAllowed && d < bestDist) {
      bestDist = d;
      best = word;
    }
  }
  return best;
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
