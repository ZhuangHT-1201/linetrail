import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staticFiles = ["line-art.js", "app.js", "line-art-worker.js"];

await mkdir(resolve(projectRoot, "dist"), { recursive: true });
await Promise.all(
  staticFiles.map((file) =>
    copyFile(resolve(projectRoot, file), resolve(projectRoot, "dist", file))
  )
);
