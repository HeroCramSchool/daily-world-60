import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useVideoConfig, Loop } from "remotion";
import { Hook } from "./scenes/Hook";
import { Section } from "./scenes/Section";
import { Outro } from "./scenes/Outro";
import { T } from "./lib/theme";
import type { LongformProps } from "./lib/types";

export const segmentFrames = (durationSec: number, fps: number) => Math.max(1, Math.round(durationSec * fps));

export const totalFrames = (props: LongformProps, fps: number) =>
  Math.max(1, props.segments.reduce((a, s) => a + segmentFrames(s.durationSec, fps), 0));

export const Longform: React.FC<LongformProps> = props => {
  const { fps } = useVideoConfig();
  const sections = props.segments.filter(s => s.kind === "section");
  const chapters = sections.map(s => ({ heading: s.heading, durationSec: s.durationSec }));

  let cursor = 0;
  let sectionOrdinal = 0;
  const total = totalFrames(props, fps);

  return (
    <AbsoluteFill style={{ backgroundColor: T.bg }}>
      {props.bgm ? (
        <Loop durationInFrames={Math.round(props.bgmDurationSec ? props.bgmDurationSec * fps : total)}>
          <Audio src={staticFile(props.bgm)} volume={0.09} />
        </Loop>
      ) : null}

      {props.segments.map(seg => {
        const dur = segmentFrames(seg.durationSec, fps);
        const from = cursor;
        cursor += dur;
        const idx = seg.kind === "section" ? sectionOrdinal++ : -1;
        return (
          <Sequence key={seg.index} from={from} durationInFrames={dur} name={`${seg.kind}:${seg.heading}`}>
            <Audio src={staticFile(seg.audio)} />
            {seg.kind === "hook" ? (
              <Hook seg={seg} title={props.title} topic={props.topic} />
            ) : seg.kind === "outro" ? (
              <Outro seg={seg} />
            ) : (
              <Section seg={seg} chapters={chapters} chapterIndex={idx} />
            )}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
