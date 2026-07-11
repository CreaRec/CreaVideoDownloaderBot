import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (parent of `src/` and `config/`). */
export const projectRoot = path.resolve(__dirname, "../..");

export function configPath(...segments: string[]): string {
  return path.resolve(projectRoot, "config", ...segments);
}
