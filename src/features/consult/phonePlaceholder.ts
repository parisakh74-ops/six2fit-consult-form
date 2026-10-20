import { getExampleNumber, type CountryCode } from "libphonenumber-js/min";
import examples from "libphonenumber-js/examples.mobile.json";

/** Shown when no reliable example exists for the selected country (or none is selected). */
export const NEUTRAL_PHONE_PLACEHOLDER = "شماره واتساپ";

/**
 * Placeholder for the WhatsApp number field: an example national mobile number of the selected country, taken from
 * libphonenumber-js's own example metadata (no handwritten country table). Falls back to the neutral text. It only
 * affects the placeholder, never the field value or the selected country.
 */
export function phonePlaceholder(countryIso: string | undefined): string {
  if (!countryIso) return NEUTRAL_PHONE_PLACEHOLDER;
  try {
    const example = getExampleNumber(countryIso as CountryCode, examples);
    const national = example?.formatNational();
    return national ? national : NEUTRAL_PHONE_PLACEHOLDER;
  } catch {
    return NEUTRAL_PHONE_PLACEHOLDER;
  }
}
