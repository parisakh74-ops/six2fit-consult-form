"use strict";

import("./.output/server/index.mjs").catch((error) => {
  console.error("Failed to start Six2Fit Consult", error);
  process.exitCode = 1;
});
