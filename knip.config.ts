import type { KnipConfig } from "knip";

const config: KnipConfig = {
  project: ["src/**/*.ts"],
  ignoreDependencies: [
    // Transitive deps re-exported by @slack/bolt and @earendil-works/pi-coding-agent
    "@slack/web-api",
    "@slack/types",
    "@sinclair/typebox",
    "@earendil-works/pi-ai",
  ],
};

export default config;
