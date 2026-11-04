// @vitest-environment node

import { translateFor } from "@openbot/i18n";
import type { MessageBoxOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showArchiveChanged } from "./app-archive-watch";

const { showMessageBox, openExternal } = vi.hoisted(() => ({
  showMessageBox: vi.fn<(options: MessageBoxOptions) => Promise<{ response: number; checkboxChecked: boolean }>>(),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock("electron", () => ({ dialog: { showMessageBox }, shell: { openExternal } }));

describe("archive recovery navigation policy", () => {
  const translate = translateFor("en");

  beforeEach(() => {
    showMessageBox.mockReset().mockResolvedValue({ response: 0, checkboxChecked: false });
    openExternal.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    "",
    "not a URL",
    "http://recovery.example/installer",
    "file:///tmp/installer",
    "javascript:alert(1)",
    "https://user:secret@recovery.example/installer",
    "https://recovery.example/installer?token=secret",
    "https://recovery.example/installer#secret",
    "https://openbot.run/download",
    "https://OPENBOT.RUN./download",
    "https://download.openbot.run/installer",
    "https://openbot.site/installer",
    "https://download.openbot.site./installer",
    "https://github.com/nightly-labs/openbot/releases/latest",
    "https://github.com./nightly-labs/openbot/releases/latest",
    "https://www.github.com/nightly-labs/openbot/releases/latest",
    "https://github.com/%6eightly-labs/openbot/releases/latest",
    "https://api.github.com/repos/nightly-labs/openbot/releases/latest",
    "https://codeload.github.com/nightly-labs/openbot/zip/main",
    "https://raw.githubusercontent.com/nightly-labs/openbot/main/install.sh",
  ])("does not offer or open an absent, unsafe, or upstream source: %s", async (source) => {
    await showArchiveChanged(translate, source);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ buttons: [translate("common.close")], defaultId: 0, cancelId: 0 }),
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens an explicitly configured HTTPS source only after its action is selected", async () => {
    const source = "https://recovery.example/independent/installer";
    await showArchiveChanged(translate, source);
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: [translate("startup.archiveChangedDownload"), translate("common.close")],
        defaultId: 1,
        cancelId: 1,
      }),
    );
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(source);
  });

  it("does not open the configured source when the dialog is closed", async () => {
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false });
    await showArchiveChanged(translate, "https://recovery.example/independent/installer");
    expect(openExternal).not.toHaveBeenCalled();
  });
});
