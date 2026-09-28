import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import config from "../../forge.config.js";
import { shouldRemovePackagedElectronLocale } from "../../scripts/prune-packaged-locales.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Packaged Electron locales", () => {
  it("keeps Chinese and English locale files and the Desktop display-name bundle", () => {
    for (const fileName of ["zh-CN.pak", "zh-TW.pak", "en-US.pak", "en-GB.pak", "en.lproj", "en_GB.lproj", "zh_CN.lproj", "zh_TW.lproj", "zh-Hans.lproj", "Base.lproj", "resources.pak", "chrome_100_percent.pak"]) {
      expect(shouldRemovePackagedElectronLocale(fileName)).toBe(false);
    }
    for (const fileName of ["fr.pak", "fil.pak", "es-419.pak", "de.lproj", "pt_BR.lproj", "ja.lproj"]) {
      expect(shouldRemovePackagedElectronLocale(fileName)).toBe(true);
    }
  });

  it("prunes unused locale packs from an extracted Electron tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-locales-"));
    temporaryRoots.push(root);
    const locales = join(root, "locales");
    const framework = join(root, "Electron.app", "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources");
    const displayName = join(root, "Electron.app", "Contents", "Resources", "zh-Hans.lproj");
    mkdirSync(locales, { recursive: true });
    mkdirSync(join(framework, "en.lproj"), { recursive: true });
    mkdirSync(join(framework, "en_GB.lproj"), { recursive: true });
    mkdirSync(join(framework, "zh_CN.lproj"), { recursive: true });
    mkdirSync(join(framework, "zh_TW.lproj"), { recursive: true });
    mkdirSync(join(framework, "fr.lproj"), { recursive: true });
    mkdirSync(join(framework, "Base.lproj"), { recursive: true });
    mkdirSync(displayName, { recursive: true });
    for (const fileName of ["en-US.pak", "en-GB.pak", "zh-CN.pak", "zh-TW.pak", "fr.pak", "fil.pak", "es-419.pak"]) {
      writeFileSync(join(locales, fileName), "pak");
    }
    writeFileSync(join(root, "chrome_100_percent.pak"), "chrome");
    writeFileSync(join(framework, "en.lproj", "locale.pak"), "en");
    writeFileSync(join(framework, "fr.lproj", "locale.pak"), "fr");
    writeFileSync(join(framework, "Base.lproj", "MainMenu.nib"), "nib");
    writeFileSync(join(displayName, "InfoPlist.strings"), "name");

    const hook = config.hooks?.packageAfterExtract;
    expect(hook).toBeTypeOf("function");
    await hook?.({} as never, root, "43.4.1", "linux", "x64");

    expect(readdirSync(locales).toSorted()).toEqual(["en-GB.pak", "en-US.pak", "zh-CN.pak", "zh-TW.pak"]);
    expect(readdirSync(framework).toSorted()).toEqual(["Base.lproj", "en.lproj", "en_GB.lproj", "zh_CN.lproj", "zh_TW.lproj"]);
    expect(existsSync(join(framework, "fr.lproj"))).toBe(false);
    expect(existsSync(join(displayName, "InfoPlist.strings"))).toBe(true);
    expect(existsSync(join(root, "chrome_100_percent.pak"))).toBe(true);
  });
});
