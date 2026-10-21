"use strict";

// Matches the file deployed on ShetabanHost (2026-10-11): requires the Nitro `node-middleware` build
// (`npm run build:shetaban`), which exports `middleware`.
const { createServer } = require("node:http");
const { loadPrivateEnv } = require("./load-private-env.cjs");

// Secrets come from a private file outside the web root (see load-private-env.cjs), BEFORE the bundle is imported.
loadPrivateEnv();

void import("./.output/server/index.mjs")
  .then(({ middleware }) => {
    const port = Number.parseInt(process.env.PORT || "3000", 10);
    createServer(middleware).listen(port);
  })
  .catch((error) => {
    console.error("Failed to start Six2Fit Consult", error);
    process.exitCode = 1;
  });
