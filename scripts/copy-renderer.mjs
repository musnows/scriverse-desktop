import { cpSync, mkdirSync } from "node:fs";

const source = new URL("../src/renderer/", import.meta.url);
const target = new URL("../build/renderer/", import.meta.url);

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
