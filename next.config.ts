import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` (the cross-process advisory lock in src/loop/lock.ts) is a Node package whose optional
  // pg-native / pg-connection-string code references `fs`/`pg-native`. Leave it as a runtime require
  // instead of webpack-bundling it, or the bundler can't resolve those and every route 500s.
  serverExternalPackages: ["pg"],
  // The chat UI polls the outbound-delivery endpoint frequently; mute its access-log line so the
  // meaningful traffic (model/loop/tool telemetry) stays legible. The endpoint still works.
  logging: {
    incomingRequests: {
      ignore: [/\/api\/outbound\/pending/],
    },
  },
};

export default nextConfig;
