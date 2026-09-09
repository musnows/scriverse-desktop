import { cpSync, mkdirSync } from "node:fs";
import { desktopBuildIconName } from "../build/shared/branding.js";

const source = new URL("../src/renderer/", import.meta.url);
const target = new URL("../build/renderer/", import.meta.url);

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
const iconName = desktopBuildIconName();
if (iconName === "icon-dev") {
  cpSync(new URL("../assets/icon-dev.svg", import.meta.url), new URL("selector/icon.svg", target));
}

const assetTarget = new URL("../build/assets/", import.meta.url);
mkdirSync(assetTarget, { recursive: true });
cpSync(new URL(`../assets/${iconName}-32.png`, import.meta.url), new URL("icon-32.png", assetTarget));
const rendererFontTarget = new URL("../build/renderer/fonts/", import.meta.url);
mkdirSync(rendererFontTarget, { recursive: true });
cpSync(new URL("../assets/fonts/", import.meta.url), rendererFontTarget, { recursive: true });
cpSync(new URL("../assets/desktop-fonts.css", import.meta.url), new URL("desktop-fonts.css", target));
