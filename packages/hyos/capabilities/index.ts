export * from "./browser.js";

import { browserCapability } from "./browser.js";

export const applicationCapabilities = [browserCapability] as const;
