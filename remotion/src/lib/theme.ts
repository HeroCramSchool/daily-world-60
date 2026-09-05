import { loadFont } from "@remotion/google-fonts/Inter";

const { fontFamily } = loadFont("normal", {
  weights: ["400", "600", "800", "900"],
  subsets: ["latin"],
});

export const FONT = fontFamily;

export const T = {
  bg: "#0B1220",
  bgLift: "#111C31",
  ink: "#FFFFFF",
  muted: "#9FB3D8",
  dim: "#5B6E8F",
  accent: "#F5E63B",
  hot: "#FF6B6B",
  rule: "rgba(159,179,216,0.22)",
} as const;

export const SAFE = 96;
