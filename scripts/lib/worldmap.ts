/**
 * 手続き的ドット世界地図 (オフライン・ダウンロード不要・米国ニュース風モーショングラフィックス用)。
 * equirectangular: lon[-180,180] → x, lat[90,-90] → y。マーカーはドットと同じ写像なので相対位置は正確。
 * 実写ラスター地図に差し替えたい場合は別途 assets/world-map.jpg を用意して切替可能 (将来余地)。
 */

export const MAP_W = 1440;
export const MAP_H = 720;

// 大陸を緯度経度の楕円で近似 (中心 lon,lat と半径 rx,ry [度])。複数で形を作る。
const LAND: Array<[number, number, number, number]> = [
  // North America
  [-100, 45, 30, 18], [-115, 60, 20, 13], [-95, 30, 16, 9], [-75, 49, 17, 13], [-105, 38, 14, 10],
  // Greenland
  [-42, 72, 17, 9],
  // Central America
  [-86, 14, 9, 5],
  // South America
  [-60, -8, 17, 16], [-64, -32, 11, 14], [-72, -2, 8, 9], [-50, -20, 9, 12],
  // Europe
  [12, 49, 20, 11], [22, 60, 15, 8], [-3, 52, 8, 7],
  // Africa
  [18, 8, 20, 16], [24, -18, 15, 16], [8, 9, 12, 9], [38, 0, 9, 12],
  // Middle East
  [45, 28, 14, 11],
  // Russia / North Asia
  [95, 62, 58, 13], [140, 65, 22, 9],
  // Central / South Asia
  [65, 43, 16, 9], [78, 23, 12, 11],
  // East Asia
  [108, 36, 16, 12], [140, 38, 5, 8], [127, 37, 3, 4],
  // SE Asia
  [102, 14, 11, 9], [118, -1, 18, 6], [122, 12, 5, 6],
  // Australia / NZ
  [134, -25, 18, 11], [172, -42, 4, 7],
  // India subcontinent tip / Sri Lanka, Japan south already covered
];

function isLand(lon: number, lat: number): boolean {
  for (const [clon, clat, rx, ry] of LAND) {
    const dx = (lon - clon) / rx;
    const dy = (lat - clat) / ry;
    if (dx * dx + dy * dy <= 1) return true;
  }
  return false;
}

/** 国コード → [lon, lat] (近似中心)。未知コードは null (マーカーなし=全体ショット)。 */
const COUNTRY: Record<string, [number, number]> = {
  US: [-98, 39], CA: [-106, 56], MX: [-102, 23], BR: [-51, -10], AR: [-64, -34], CO: [-74, 4],
  VE: [-66, 8], PE: [-75, -10], CL: [-71, -35],
  GB: [-2, 54], FR: [2, 47], DE: [10, 51], ES: [-4, 40], IT: [12, 42], UA: [31, 49], RU: [90, 62],
  PL: [19, 52], NL: [5, 52], SE: [16, 62], NO: [9, 61], CH: [8, 47], TR: [35, 39], GR: [22, 39],
  IR: [53, 32], IL: [35, 31], PS: [35, 31.9], LB: [35.8, 33.9], SY: [38, 35], IQ: [44, 33], SA: [45, 24],
  AE: [54, 24], QA: [51, 25], YE: [48, 15], EG: [30, 27], JO: [36, 31],
  CN: [104, 35], JP: [138, 37], KR: [128, 36], KP: [127, 40], IN: [79, 22], PK: [70, 30], BD: [90, 24],
  ID: [118, -2], PH: [122, 13], VN: [106, 16], TH: [101, 15], MY: [102, 4], SG: [104, 1.3], MM: [96, 21],
  AU: [134, -25], NZ: [172, -42],
  NG: [8, 9], ZA: [25, -29], KE: [38, 0], ET: [40, 9], GH: [-1, 8], DRC: [23, -2], CD: [23, -2], SD: [30, 15],
  SO: [46, 6], LY: [17, 27], DZ: [3, 28], MA: [-6, 32], TN: [9, 34],
  // 非国トピックの近似 (海域/大会など)
  SCS: [114, 12], EU: [10, 50], UK: [-2, 54],
};

/** 国コード → [lon,lat]。未知なら null。 */
export function countryLonLat(code: string): [number, number] | null {
  const c = code.toUpperCase();
  return COUNTRY[c] ?? null;
}

export function lonLatToXY(lon: number, lat: number): [number, number] {
  return [((lon + 180) / 360) * MAP_W, ((90 - lat) / 180) * MAP_H];
}

/** 陸地ドット群を <circle> で返す (viewBox 0 0 MAP_W MAP_H 内)。 */
export function worldDots(stepDeg = 3, r = 3.4, fill = "#5B7290", opacity = 0.9): string {
  let s = `<g fill="${fill}" opacity="${opacity}">`;
  for (let lat = 88; lat >= -88; lat -= stepDeg) {
    for (let lon = -180; lon <= 180; lon += stepDeg) {
      if (!isLand(lon, lat)) continue;
      const [x, y] = lonLatToXY(lon, lat);
      s += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`;
    }
  }
  return s + `</g>`;
}
