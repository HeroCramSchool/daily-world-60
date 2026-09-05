import { Easing, interpolate, spring } from "remotion";

/** 0→1 の入場、終端で 1→0 の退場。frames 単位。 */
export const inOut = (frame: number, total: number, inF = 10, outF = 10) =>
  Math.min(
    interpolate(frame, [0, inF], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
    interpolate(frame, [total - outF, total], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  );

/** 重すぎないバネ。数字やカードの入場に使う。 */
export const pop = (frame: number, fps: number, delay = 0) =>
  spring({ frame: frame - delay, fps, config: { damping: 200, mass: 0.6, stiffness: 120 } });

/** カードの入場。過減衰 spring だと収束が読めないので、明示のイージングで 10 フレームに固定する。 */
export const enter = (frame: number, frames = 10) =>
  interpolate(frame, [0, frames], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
