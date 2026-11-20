// Encoding in a worker avoids Chrome's idle-task delay for canvas serialization
// in hidden documents. There is only one request in flight.
const canvas = new OffscreenCanvas(1, 1);
const context = canvas.getContext('2d', { alpha: false });
self.onmessage = async ({ data: { frame, rect: r } }) => {
  try {
    const widthIn = frame.displayWidth, heightIn = frame.displayHeight;
    // Captured tracks may contain a centered, letterboxed viewport.
    const viewportWidth = Math.min(widthIn, heightIn * r.aspect);
    const viewportHeight = viewportWidth / r.aspect;
    const sx = (widthIn - viewportWidth) / 2 + r.x * viewportWidth;
    const sy = (heightIn - viewportHeight) / 2 + r.y * viewportHeight;
    const sw = Math.min(r.w * viewportWidth, widthIn - sx);
    const sh = Math.min(r.h * viewportHeight, heightIn - sy);
    const scale = Math.min(854 / sw, 480 / sh, 1);
    const width = Math.max(1, Math.round(sw * scale)), height = Math.max(1, Math.round(sh * scale));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.drawImage(frame, sx, sy, sw, sh, 0, 0, width, height);
    self.postMessage({ blob: await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 }) });
  } catch { self.postMessage({ error: 'encoding-failed' }); }
  finally { frame.close(); }
};
