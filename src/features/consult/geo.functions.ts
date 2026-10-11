import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

export type GeoResult =
  | { resolved: true; ip_country_code: string; currency_route_source: "ip" }
  | { resolved: false };

const COUNTRY_RE = /^[A-Z]{2}$/;

/**
 * Server-side IP country resolution.
 * The raw IP never leaves the server and is never returned to the client,
 * stored in the payload, or logged.
 */
export const resolveIpCountry = createServerFn({ method: "GET" }).handler(
  async (): Promise<GeoResult> => {
    const headerCandidates = [
      "cf-ipcountry",
      "x-vercel-ip-country",
      "x-geo-country",
      "x-country-code",
    ];

    for (const name of headerCandidates) {
      const value = getRequestHeader(name)?.trim().toUpperCase();
      if (value && COUNTRY_RE.test(value) && value !== "XX" && value !== "T1") {
        return { resolved: true, ip_country_code: value, currency_route_source: "ip" };
      }
    }

    // Fallback lookup by client IP, performed server-side only.
    const forwarded = getRequestHeader("x-forwarded-for") ?? "";
    const ip =
      forwarded.split(",")[0]?.trim() || getRequestHeader("x-real-ip")?.trim() || "";

    if (ip && !isPrivateIp(ip)) {
      try {
        const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/country/`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const code = (await res.text()).trim().toUpperCase();
          if (COUNTRY_RE.test(code)) {
            return {
              resolved: true,
              ip_country_code: code,
              currency_route_source: "ip",
            };
          }
        }
      } catch {
        // Swallow: resolution failure must never surface network details.
      }
    }

    return { resolved: false };
  },
);

function isPrivateIp(ip: string): boolean {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("127.") ||
    ip === "::1" ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}
