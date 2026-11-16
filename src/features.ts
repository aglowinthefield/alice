/**
 * Optional Bakery features, chosen when Bakery is built and started. Each is off unless its switch is set to 1.
 * The server reads the switches from its environment at startup (server/index.ts), and vite.config.ts bakes the same
 * reading into the UI when it builds or dev-serves it (src/build-features.ts). Build the UI and start the server with
 * the same switches. Turning a feature off hides and refuses it but keeps its stored data, so turning it back on
 * restores it.
 */
export type Feature = "sentinels" | "pullRequests";
export type Features = Record<Feature, boolean>;

export const featureSwitches: Record<Feature, string> = {
  sentinels: "BAKERY_FEATURE_SENTINELS",
  pullRequests: "BAKERY_FEATURE_PULL_REQUESTS",
};
const featureNames: Record<Feature, string> = {
  sentinels: "Sentinels are",
  pullRequests: "GitHub pull requests are",
};

/** Reads the switches. Unset or empty is off; anything other than 0 or 1 is a typo, so it throws instead of guessing. */
export function readFeatures(
  env: Record<string, string | undefined>,
): Features {
  const read = (feature: Feature) => {
    const value = env[featureSwitches[feature]]?.trim() ?? "";
    if (value !== "" && value !== "0" && value !== "1")
      throw new Error(
        `${featureSwitches[feature]} must be 0 or 1, not "${value}"`,
      );
    return value === "1";
  };
  return { sentinels: read("sentinels"), pullRequests: read("pullRequests") };
}

/** Why a feature's screen or action is unavailable, and how to get it back. */
export function featureOffMessage(feature: Feature): string {
  return `${featureNames[feature]} turned off in this Bakery build. Build and start Bakery with ${featureSwitches[feature]}=1 to use them.`;
}
