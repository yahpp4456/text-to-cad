import React from "react";
import { Composition, registerRoot } from "remotion";
import tl from "./timeline.json";
import { Main } from "./Main";

const Root: React.FC = () => (
  <Composition id="Demo" component={Main} durationInFrames={tl.total} fps={tl.fps} width={tl.width} height={tl.height} />
);
registerRoot(Root);
