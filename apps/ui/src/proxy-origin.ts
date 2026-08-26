/**
 * Translate a genuinely same-origin Vite request to the daemon's origin. A foreign page
 * can POST to a loopback dev server, so its Origin must pass through unchanged and be
 * rejected by the daemon rather than being laundered by the proxy.
 */
export function proxiedOrigin(
  origin: string | undefined,
  host: string | undefined,
  daemonOrigin: string,
): string | undefined {
  if (origin === undefined || host === undefined) return origin;
  try {
    return new URL(origin).host === host ? daemonOrigin : origin;
  } catch {
    return origin;
  }
}
