// ISO 3166-1 alpha-2 code + flag emoji
export interface Country {
  readonly code: string;
  readonly flag: string;
}

const FLAG_MAP: Record<string, string> = {
  // North America
  US: "🇺🇸", CA: "🇨🇦", MX: "🇲🇽", CU: "🇨🇺", HT: "🇭🇹", DO: "🇩🇴",
  PR: "🇵🇷", JM: "🇯🇲", PA: "🇵🇦", CR: "🇨🇷", GT: "🇬🇹", HN: "🇭🇳",
  NI: "🇳🇮", SV: "🇸🇻", BZ: "🇧🇿",
  // South America
  BR: "🇧🇷", AR: "🇦🇷", CL: "🇨🇱", CO: "🇨🇴", PE: "🇵🇪", VE: "🇻🇪",
  EC: "🇪🇨", BO: "🇧🇴", PY: "🇵🇾", UY: "🇺🇾", GY: "🇬🇾", SR: "🇸🇷",
  // Europe
  GB: "🇬🇧", IE: "🇮🇪", FR: "🇫🇷", DE: "🇩🇪", IT: "🇮🇹", ES: "🇪🇸",
  PT: "🇵🇹", NL: "🇳🇱", BE: "🇧🇪", LU: "🇱🇺", CH: "🇨🇭", AT: "🇦🇹",
  SE: "🇸🇪", NO: "🇳🇴", DK: "🇩🇰", FI: "🇫🇮", IS: "🇮🇸",
  PL: "🇵🇱", CZ: "🇨🇿", SK: "🇸🇰", HU: "🇭🇺", RO: "🇷🇴", BG: "🇧🇬",
  GR: "🇬🇷", HR: "🇭🇷", SI: "🇸🇮", RS: "🇷🇸", BA: "🇧🇦", AL: "🇦🇱",
  MK: "🇲🇰", ME: "🇲🇪", XK: "🇽🇰",
  UA: "🇺🇦", BY: "🇧🇾", MD: "🇲🇩", LT: "🇱🇹", LV: "🇱🇻", EE: "🇪🇪",
  RU: "🇷🇺",
  // Middle East
  IL: "🇮🇱", PS: "🇵🇸", LB: "🇱🇧", JO: "🇯🇴", SY: "🇸🇾", IQ: "🇮🇶",
  IR: "🇮🇷", TR: "🇹🇷", SA: "🇸🇦", AE: "🇦🇪", QA: "🇶🇦", KW: "🇰🇼",
  BH: "🇧🇭", OM: "🇴🇲", YE: "🇾🇪",
  // Africa
  EG: "🇪🇬", LY: "🇱🇾", TN: "🇹🇳", DZ: "🇩🇿", MA: "🇲🇦",
  SD: "🇸🇩", SS: "🇸🇸", ET: "🇪🇹", ER: "🇪🇷", SO: "🇸🇴", DJ: "🇩🇯",
  KE: "🇰🇪", TZ: "🇹🇿", UG: "🇺🇬", RW: "🇷🇼", BI: "🇧🇮",
  ZA: "🇿🇦", NA: "🇳🇦", BW: "🇧🇼", ZW: "🇿🇼", ZM: "🇿🇲", MZ: "🇲🇿",
  AO: "🇦🇴", CD: "🇨🇩", CG: "🇨🇬", CM: "🇨🇲", CF: "🇨🇫", TD: "🇹🇩",
  NG: "🇳🇬", GH: "🇬🇭", CI: "🇨🇮", SN: "🇸🇳", ML: "🇲🇱", BF: "🇧🇫",
  NE: "🇳🇪", MR: "🇲🇷", LR: "🇱🇷", SL: "🇸🇱", GN: "🇬🇳", GW: "🇬🇼",
  MG: "🇲🇬", MU: "🇲🇺",
  // Asia
  JP: "🇯🇵", KR: "🇰🇷", KP: "🇰🇵", CN: "🇨🇳", TW: "🇹🇼", HK: "🇭🇰", MO: "🇲🇴",
  MN: "🇲🇳", VN: "🇻🇳", LA: "🇱🇦", KH: "🇰🇭", TH: "🇹🇭", MM: "🇲🇲",
  SG: "🇸🇬", MY: "🇲🇾", ID: "🇮🇩", PH: "🇵🇭", BN: "🇧🇳", TL: "🇹🇱",
  IN: "🇮🇳", PK: "🇵🇰", BD: "🇧🇩", LK: "🇱🇰", NP: "🇳🇵", BT: "🇧🇹",
  MV: "🇲🇻", AF: "🇦🇫",
  KZ: "🇰🇿", UZ: "🇺🇿", TJ: "🇹🇯", KG: "🇰🇬", TM: "🇹🇲",
  GE: "🇬🇪", AM: "🇦🇲", AZ: "🇦🇿",
  // Oceania
  AU: "🇦🇺", NZ: "🇳🇿", FJ: "🇫🇯", PG: "🇵🇬", SB: "🇸🇧", VU: "🇻🇺",
  TO: "🇹🇴", WS: "🇼🇸", KI: "🇰🇮", TV: "🇹🇻", NR: "🇳🇷", PW: "🇵🇼",
  FM: "🇫🇲", MH: "🇲🇭",
};

export const Country = {
  fromCode(code: string): Country {
    const upper = code.toUpperCase();
    return { code: upper, flag: FLAG_MAP[upper] ?? "🌍" };
  },
};
