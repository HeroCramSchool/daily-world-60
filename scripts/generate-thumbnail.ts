import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

async function main() {
  const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const dir = path.join("output", date);
  const script = JSON.parse(await fs.readFile(path.join(dir, "script-en.json"), "utf-8"));

  const flags: string[] = script.stories.map((s: { country: { flag: string } }) => s.country.flag);
  const svg = buildSvg(date, flags);
  const svgPath = path.join(dir, "_thumb.svg");
  const pngPath = path.join(dir, "thumbnail.png");

  await fs.writeFile(svgPath, svg, "utf-8");
  await run("rsvg-convert", ["-w", "1080", "-h", "1920", svgPath, "-o", pngPath]);
  await fs.unlink(svgPath).catch(() => {});

  const stat = await fs.stat(pngPath);
  console.log(`[thumbnail] ${pngPath} (${stat.size} bytes)`);
}

function buildSvg(date: string, flags: string[]): string {
  const mmdd = date.slice(5).replace("-", "/");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FB923C"/>
      <stop offset="60%" stop-color="#DC2626"/>
      <stop offset="100%" stop-color="#7F1D1D"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  <g transform="translate(540 720)">
    <circle r="260" fill="#FFFFFF"/>
    <g stroke="#0F172A" stroke-width="8" fill="none">
      <circle r="195"/>
      <ellipse rx="195" ry="65"/>
      <ellipse rx="195" ry="130"/>
      <ellipse rx="65" ry="195"/>
      <ellipse rx="130" ry="195"/>
    </g>
    <text y="60" text-anchor="middle" font-family="Helvetica, Arial Black, sans-serif"
          font-size="200" font-weight="900" fill="#DC2626"
          stroke="#FFFFFF" stroke-width="8" paint-order="stroke">60</text>
  </g>
  <text x="540" y="1180" text-anchor="middle"
        font-family="Helvetica, Arial Black, sans-serif"
        font-size="100" font-weight="900" fill="#FFFFFF" letter-spacing="8">DAILY WORLD</text>
  <text x="540" y="1280" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif"
        font-size="56" font-weight="700" fill="#FBBF24" letter-spacing="4">${mmdd}</text>
  <text x="540" y="1550" text-anchor="middle"
        font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif"
        font-size="160">${flags.join("  ")}</text>
</svg>
`;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("error", reject);
    proc.on("close", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
