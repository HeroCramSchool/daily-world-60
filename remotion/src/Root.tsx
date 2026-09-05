import React from "react";
import { Composition } from "remotion";
import { Longform, totalFrames } from "./Longform";
import { Short, totalShortFrames } from "./short/Short";
import rawProps from "../props.json";
import rawShort from "../props-short.json";
import type { LongformProps } from "./lib/types";
import type { ShortProps } from "./lib/shortTypes";

const FPS = 30;
const defaultProps = rawProps as LongformProps;
const shortProps = rawShort as unknown as ShortProps;

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Longform"
      component={Longform}
      width={1920}
      height={1080}
      fps={FPS}
      durationInFrames={totalFrames(defaultProps, FPS)}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: totalFrames(props, props.fps || FPS),
        fps: props.fps || FPS,
      })}
    />

    {(shortProps.videos ?? []).map((v, i) => (
      <Composition
        key={v.code}
        id={`Short-${i + 1}-${v.code}`}
        component={Short}
        width={1080}
        height={1920}
        fps={FPS}
        durationInFrames={totalShortFrames({ ...shortProps, pick: i }, FPS)}
        defaultProps={{ ...shortProps, pick: i }}
        calculateMetadata={({ props }) => ({
          durationInFrames: totalShortFrames(props, props.fps || FPS),
          fps: props.fps || FPS,
        })}
      />
    ))}
  </>
);
