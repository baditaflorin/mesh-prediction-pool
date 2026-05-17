import { createMeshConfig } from "@baditaflorin/mesh-common";

export const config = createMeshConfig({
  appName: "mesh-prediction-pool",
  description:
    "Imaginary-token futures market. Open, bet, creator resolves, winners split the pool.",
  accentHex: "#88dd88",
  version: __APP_VERSION__,
  commit: __GIT_COMMIT__,
});
