// ISO 3166-1 alpha-2 code + flag emoji + short English name
export interface Country {
  readonly code: string;
  readonly flag: string;
  readonly name?: string;
}

// Short, speakable English names (avoid "Democratic Republic of the Congo" — use "Congo")
const NAME_MAP: Record<string, string> = {
  US: "the U.S.", CA: "Canada", MX: "Mexico", CU: "Cuba", HT: "Haiti", DO: "the Dominican Republic",
  PR: "Puerto Rico", JM: "Jamaica", PA: "Panama", CR: "Costa Rica", GT: "Guatemala",
  HN: "Honduras", NI: "Nicaragua", SV: "El Salvador", BZ: "Belize",
  BR: "Brazil", AR: "Argentina", CL: "Chile", CO: "Colombia", PE: "Peru", VE: "Venezuela",
  EC: "Ecuador", BO: "Bolivia", PY: "Paraguay", UY: "Uruguay", GY: "Guyana", SR: "Suriname",
  GB: "the U.K.", IE: "Ireland", FR: "France", DE: "Germany", IT: "Italy", ES: "Spain",
  PT: "Portugal", NL: "the Netherlands", BE: "Belgium", LU: "Luxembourg", CH: "Switzerland",
  AT: "Austria", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland", IS: "Iceland",
  PL: "Poland", CZ: "the Czech Republic", SK: "Slovakia", HU: "Hungary", RO: "Romania",
  BG: "Bulgaria", GR: "Greece", HR: "Croatia", SI: "Slovenia", RS: "Serbia",
  BA: "Bosnia", AL: "Albania", MK: "North Macedonia", ME: "Montenegro", XK: "Kosovo",
  UA: "Ukraine", BY: "Belarus", MD: "Moldova", LT: "Lithuania", LV: "Latvia", EE: "Estonia",
  RU: "Russia",
  IL: "Israel", PS: "Palestine", LB: "Lebanon", JO: "Jordan", SY: "Syria", IQ: "Iraq",
  IR: "Iran", TR: "Turkey", SA: "Saudi Arabia", AE: "the U.A.E.", QA: "Qatar", KW: "Kuwait",
  BH: "Bahrain", OM: "Oman", YE: "Yemen",
  EG: "Egypt", LY: "Libya", TN: "Tunisia", DZ: "Algeria", MA: "Morocco",
  SD: "Sudan", SS: "South Sudan", ET: "Ethiopia", ER: "Eritrea", SO: "Somalia", DJ: "Djibouti",
  KE: "Kenya", TZ: "Tanzania", UG: "Uganda", RW: "Rwanda", BI: "Burundi",
  ZA: "South Africa", NA: "Namibia", BW: "Botswana", ZW: "Zimbabwe", ZM: "Zambia",
  MZ: "Mozambique", AO: "Angola", CD: "Congo", CG: "the Republic of Congo", CM: "Cameroon",
  CF: "the Central African Republic", TD: "Chad", NG: "Nigeria", GH: "Ghana", CI: "Ivory Coast",
  SN: "Senegal", ML: "Mali", BF: "Burkina Faso", NE: "Niger", MR: "Mauritania",
  LR: "Liberia", SL: "Sierra Leone", GN: "Guinea", GW: "Guinea-Bissau",
  MG: "Madagascar", MU: "Mauritius",
  JP: "Japan", KR: "South Korea", KP: "North Korea", CN: "China", TW: "Taiwan",
  HK: "Hong Kong", MO: "Macau", MN: "Mongolia", VN: "Vietnam", LA: "Laos", KH: "Cambodia",
  TH: "Thailand", MM: "Myanmar", SG: "Singapore", MY: "Malaysia", ID: "Indonesia",
  PH: "the Philippines", BN: "Brunei", TL: "East Timor",
  IN: "India", PK: "Pakistan", BD: "Bangladesh", LK: "Sri Lanka", NP: "Nepal", BT: "Bhutan",
  MV: "the Maldives", AF: "Afghanistan",
  KZ: "Kazakhstan", UZ: "Uzbekistan", TJ: "Tajikistan", KG: "Kyrgyzstan", TM: "Turkmenistan",
  GE: "Georgia", AM: "Armenia", AZ: "Azerbaijan",
  AU: "Australia", NZ: "New Zealand", FJ: "Fiji", PG: "Papua New Guinea",
  SB: "the Solomon Islands", VU: "Vanuatu", TO: "Tonga", WS: "Samoa", KI: "Kiribati",
  TV: "Tuvalu", NR: "Nauru", PW: "Palau", FM: "Micronesia", MH: "the Marshall Islands",
};

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
    return {
      code: upper,
      flag: FLAG_MAP[upper] ?? "🌍",
      name: NAME_MAP[upper] ?? upper,
    };
  },
  nameOf(code: string): string {
    return NAME_MAP[code.toUpperCase()] ?? code.toUpperCase();
  },
};
