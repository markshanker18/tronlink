const ALLOWED_EMBED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com",
]);

const DIRECT_VIDEO_EXTENSIONS = [".mp4", ".webm", ".ogg", ".mov", ".m4v"];

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

export function isDirectVideoFileUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const path = url.pathname.toLowerCase();
    return DIRECT_VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

export function isAllowedVideoUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    const host = normalizeHostname(url.hostname);
    if (ALLOWED_EMBED_HOSTS.has(host)) return true;
    return isDirectVideoFileUrl(rawUrl);
  } catch {
    return false;
  }
}

