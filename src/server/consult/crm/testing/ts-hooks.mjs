// Test support: lets plain `node` import this repo's extensionless TypeScript modules (Node >= 22.18 strips types).
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    if (existsSync(base + ".ts")) return next(pathToFileURL(base + ".ts").href, context);
  }
  return next(specifier, context);
}
