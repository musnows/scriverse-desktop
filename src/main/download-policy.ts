import { app, type BrowserWindow, type Session, type WebContents } from "electron";
import { join } from "node:path";
import { sanitizeDownloadFilename } from "../shared/download-filename.js";

export function registerDownloadPolicy(
  electronSession: Session,
  getWorkspaceWindow: () => BrowserWindow | null
): () => void {
  const handleDownload = (event: Electron.Event, item: Electron.DownloadItem, webContents: WebContents): void => {
    const owner = getWorkspaceWindow();
    if (!owner || owner.isDestroyed() || webContents.id !== owner.webContents.id) {
      event.preventDefault();
      return;
    }
    const filename = sanitizeDownloadFilename(item.getFilename());
    item.setSaveDialogOptions({
      title: "保存 Scriverse 下载文件",
      defaultPath: join(app.getPath("downloads"), filename),
      buttonLabel: "保存",
      showsTagField: false,
      properties: ["createDirectory", "showOverwriteConfirmation"]
    });
  };
  electronSession.on("will-download", handleDownload);
  return () => electronSession.removeListener("will-download", handleDownload);
}
