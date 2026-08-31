import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { describe, expect, it, vi } from "vitest";

const preloadSources = [
  "src/preload/workspace-preload.cts",
  "src/preload/local-workspace-preload.cts"
].map((path) => [path, readFileSync(join(process.cwd(), path), "utf8")] as const);

function shortcutInstaller(source: string): string {
  const start = source.indexOf("function installEditorSaveShortcut(): void");
  const endMarker = "\n\ninstallEditorSaveShortcut();";
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("Desktop editor save shortcut installer is missing");
  return transpileModule(source.slice(start, end + endMarker.length), {
    compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2023 }
  }).outputText;
}

function runShortcut(source: string, options: {
  platform: NodeJS.Platform;
  classes?: string[];
  buttonDisabled?: boolean;
  event: Partial<KeyboardEvent>;
}) {
  class FakeElement {
    readonly classList = { contains: (name: string) => new Set(options.classes ?? []).has(name) };
  }
  class FakeButton extends FakeElement {
    disabled = options.buttonDisabled === true;
    click = vi.fn();
  }
  const editor = new FakeElement();
  const saveButton = new FakeButton();
  let listener: ((event: KeyboardEvent) => void) | null = null;
  const document = {
    addEventListener: vi.fn((_type: string, candidate: (event: KeyboardEvent) => void) => { listener = candidate; }),
    querySelector: vi.fn((selector: string) => selector === "#editor-view" ? editor : selector === "#save-button" ? saveButton : null)
  };
  const install = new Function("document", "process", "HTMLElement", "HTMLButtonElement", shortcutInstaller(source));
  install(document, { platform: options.platform }, FakeElement, FakeButton);
  if (!listener) throw new Error("Desktop editor save shortcut listener was not installed");
  const event = {
    key: "s",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...options.event
  } as unknown as KeyboardEvent;
  listener(event);
  return { event, saveButton };
}

describe.each(preloadSources)("Desktop editor save shortcut in %s", (_path, source) => {
  it("only handles Command+S on macOS", () => {
    const command = runShortcut(source, { platform: "darwin", event: { metaKey: true } });
    expect(command.event.preventDefault).toHaveBeenCalledOnce();
    expect(command.event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(command.saveButton.click).toHaveBeenCalledOnce();

    const control = runShortcut(source, { platform: "darwin", event: { ctrlKey: true } });
    expect(control.event.preventDefault).not.toHaveBeenCalled();
    expect(control.saveButton.click).not.toHaveBeenCalled();
  });

  it("only handles Ctrl+S on Windows and Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      const control = runShortcut(source, { platform, event: { ctrlKey: true } });
      expect(control.event.preventDefault).toHaveBeenCalledOnce();
      expect(control.saveButton.click).toHaveBeenCalledOnce();

      const meta = runShortcut(source, { platform, event: { metaKey: true } });
      expect(meta.event.preventDefault).not.toHaveBeenCalled();
      expect(meta.saveButton.click).not.toHaveBeenCalled();
    }
  });

  it("does not handle preview mode, hidden editors, mixed modifiers, or modified shortcuts", () => {
    for (const options of [
      { platform: "darwin" as const, classes: ["is-read-only"], event: { metaKey: true } },
      { platform: "win32" as const, classes: ["hidden"], event: { ctrlKey: true } },
      { platform: "darwin" as const, classes: [], event: { metaKey: true, ctrlKey: true } },
      { platform: "linux" as const, classes: [], event: { ctrlKey: true, shiftKey: true } },
      { platform: "win32" as const, classes: [], event: { ctrlKey: true, altKey: true } }
    ]) {
      const result = runShortcut(source, options);
      expect(result.event.preventDefault).not.toHaveBeenCalled();
      expect(result.saveButton.click).not.toHaveBeenCalled();
    }
  });

  it("suppresses key repeat without saving another version", () => {
    const result = runShortcut(source, { platform: "darwin", event: { metaKey: true, repeat: true } });
    expect(result.event.preventDefault).toHaveBeenCalledOnce();
    expect(result.event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(result.saveButton.click).not.toHaveBeenCalled();
  });
});
