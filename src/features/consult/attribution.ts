/**
 * Attribution parameters from the page URL.
 *
 * ManyChat links built for the legacy Smart Redirector carry `m_id` (ManyChat Contact Id) and `handle` (ManyChat Username).
 * The new form expects `manychat_id` and `instagram_id`. Both spellings are accepted; the new names win when both are present.
 * The legacy placeholder value "unknown" (what the Redirector used when a parameter was missing) is treated as absent.
 */

const MAX_LEN = 120;

const clean = (value: string | null): string | null => {
  const v = value?.trim().slice(0, MAX_LEN) ?? "";
  if (v === "" || v.toLowerCase() === "unknown") return null;
  return v;
};

export interface UrlAttribution {
  utm_source: string | null;
  utm_campaign: string | null;
  instagram_id: string | null;
  manychat_id: string | null;
}

export function readUrlAttribution(search: string): UrlAttribution {
  const params = new URLSearchParams(search);
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = clean(params.get(key));
      if (value !== null) return value;
    }
    return null;
  };
  return {
    utm_source: first("utm_source"),
    utm_campaign: first("utm_campaign"),
    instagram_id: first("instagram_id", "handle"),
    manychat_id: first("manychat_id", "m_id"),
  };
}
