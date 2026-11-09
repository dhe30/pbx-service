// Phone number rules from the course spec (Project tab §3 "Outgoing calls", §1 "PSTN vendors").
//
//  - Accept US numbers as 10 digits or 1 + 10 digits, and any number as E.164 (+...) or with 011.
//  - US vendor: US numbers. International vendor: everything else, INCLUDING non-US +1 countries
//    (Canada and the Caribbean share country code 1 with the US: the area code decides).

/**
 * Area codes (NPAs) inside +1 that are NOT the United States. Everything else in +1 is treated as
 * US, including US territories (PR, VI, GU, MP, AS) and the shared toll-free codes.
 * [VERIFY] against the US vendor's rate deck once imported: if a prefix here is in the US deck
 * (or a US-classified one is only in the international deck), the deck is the authority.
 */
export const NON_US_NANP: Readonly<Record<string, string>> = Object.freeze({
  // Canada
  ...Object.fromEntries(
    [
      204, 226, 236, 249, 250, 257, 263, 289, 306, 343, 354, 365, 367, 368, 382, 387, 403, 416, 418, 428, 431,
      437, 438, 450, 460, 468, 474, 506, 514, 519, 548, 579, 581, 584, 587, 600, 604, 613, 622, 633, 639, 644,
      647, 655, 672, 677, 683, 688, 705, 709, 742, 753, 778, 780, 782, 807, 819, 825, 867, 873, 879, 902, 905,
      942,
    ].map((n) => [String(n), 'CA']),
  ),
  // Caribbean and Atlantic NANP countries
  '242': 'BS', '246': 'BB', '264': 'AI', '268': 'AG', '284': 'VG', '345': 'KY', '441': 'BM', '473': 'GD',
  '649': 'TC', '658': 'JM', '876': 'JM', '664': 'MS', '721': 'SX', '758': 'LC', '767': 'DM', '784': 'VC',
  '809': 'DO', '829': 'DO', '849': 'DO', '868': 'TT', '869': 'KN',
});

/** US toll-free area codes (shared across NANP; routed via the US vendor). */
export const NANP_TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);

const E164 = /^\+[1-9][0-9]{6,14}$/;

export function isE164(s: string): boolean {
  return E164.test(s);
}

/**
 * Normalize a number dialed by a customer's phone to E.164, or null if it isn't a PSTN number.
 * Visual separators (space, -, ., parentheses) are ignored. Extensions are matched BEFORE this.
 */
export function normalizeDialed(input: string): string | null {
  const s = input.trim().replace(/[\s\-.()]/g, '');
  if (s.startsWith('+')) return isE164(s) ? s : null;
  if (!/^[0-9]+$/.test(s)) return null;
  if (s.startsWith('011')) {
    const e = `+${s.slice(3)}`;
    return isE164(e) ? e : null;
  }
  if (/^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(s)) return `+1${s}`;
  if (/^1[2-9][0-9]{2}[2-9][0-9]{6}$/.test(s)) return `+${s}`;
  return null;
}

/**
 * Normalize a caller/DID number delivered by the carrier (often digits without '+'). US numbers may
 * come as 10 digits. Returns null for anonymous/unparseable callers.
 */
export function normalizeCarrierNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().replace(/[\s\-.()]/g, '');
  if (s.startsWith('+')) return isE164(s) ? s : null;
  if (!/^[0-9]+$/.test(s)) return null;
  if (s.startsWith('00')) return normalizeCarrierNumber(`+${s.slice(2)}`);
  if (s.startsWith('011')) return normalizeCarrierNumber(`+${s.slice(3)}`);
  if (/^[2-9][0-9]{9}$/.test(s)) return `+1${s}`;
  const e = `+${s}`;
  return isE164(e) ? e : null;
}

export type Region = 'us' | 'intl';

export interface NumberClass {
  region: Region;
  /** ISO country for non-US +1 numbers (CA, JM, ...). */
  nanpCountry?: string;
  tollFree: boolean;
}

/** Which vendor serves an E.164 number, and whether it's (US) toll-free. */
export function classifyE164(e164: string): NumberClass {
  if (!e164.startsWith('+1')) return { region: 'intl', tollFree: false };
  const npa = e164.slice(2, 5);
  const country = NON_US_NANP[npa];
  if (country) return { region: 'intl', nanpCountry: country, tollFree: false };
  return { region: 'us', tollFree: NANP_TOLL_FREE.has(npa) };
}

/** Extension numbers: digits only, unique per account (e.g. 101). */
export const EXTENSION_NUMBER = /^[0-9]{1,8}$/;
