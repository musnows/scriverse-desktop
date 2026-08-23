import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(join(root, "src", "renderer", "selector", "icon.svg"));
const assets = join(root, "assets");
const iconset = join(assets, "icon.iconset");
await mkdir(assets, { recursive: true });
await mkdir(iconset, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const pngs = new Map();
for (const size of sizes) {
  const png = await sharp(source).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  pngs.set(size, png);
  await writeFile(join(assets, `icon-${size}.png`), png);
}

const iconsetFiles = new Map([
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
]);
for (const [filename, size] of iconsetFiles) await writeFile(join(iconset, filename), pngs.get(size));

const icoSizes = [16, 32, 48, 64, 128, 256];
const icoHeader = Buffer.alloc(6 + (icoSizes.length * 16));
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(icoSizes.length, 4);
let offset = icoHeader.length;
const icoImages = [];
icoSizes.forEach((size, index) => {
  const image = pngs.get(size);
  const entry = 6 + (index * 16);
  icoHeader.writeUInt8(size === 256 ? 0 : size, entry);
  icoHeader.writeUInt8(size === 256 ? 0 : size, entry + 1);
  icoHeader.writeUInt8(0, entry + 2);
  icoHeader.writeUInt8(0, entry + 3);
  icoHeader.writeUInt16LE(1, entry + 4);
  icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(image.length, entry + 8);
  icoHeader.writeUInt32LE(offset, entry + 12);
  icoImages.push(image);
  offset += image.length;
});
await writeFile(join(assets, "icon.ico"), Buffer.concat([icoHeader, ...icoImages]));

if (process.platform === "darwin") {
  const result = spawnSync("/usr/bin/iconutil", ["--convert", "icns", "--output", join(assets, "icon.icns"), iconset], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("iconutil failed");
}

process.stdout.write("Desktop icons generated\n");
