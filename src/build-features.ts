import { readFeatures, type Features } from "./features.js";

declare const __ALICE_FEATURES__: Features | undefined;

/**
 * The optional features this UI was built with (see features.ts). vite.config.ts replaces the constant at build time.
 * Outside Vite (unit tests run under Node) it reads the same switches from the environment.
 */
export const features: Features =
  typeof __ALICE_FEATURES__ !== "undefined"
    ? __ALICE_FEATURES__
    : readFeatures(globalThis.process?.env ?? {});
