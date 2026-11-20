import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  channelFromExeName,
  findInstalls,
  inspectInstall,
  installDirFromCommand,
  parseRegistryInstallLocations,
} from "../src/installs.js";
import { createFakeInstall, type FakeInstall } from "./fake-install.js";

const roots: string[] = [];
const trees: FakeInstall[] = [];

async function newRoot(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t3p-find-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const tree of trees) tree.cleanup();
  trees.length = 0;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("channelFromExeName", () => {
  it("maps exe names to channels", () => {
    expect(channelFromExeName("T3 Code (Beta).exe")).toBe("beta");
    expect(channelFromExeName("T3 Code (Nightly).exe")).toBe("nightly");
    expect(channelFromExeName("T3 Code.exe")).toBe("stable");
    expect(channelFromExeName("something-else.exe")).toBe("unknown");
  });
});

describe("inspectInstall", () => {
  it("reads the version from the asar and the channel from the exe", async () => {
    const tree = await createFakeInstall();
    trees.push(tree);

    const info = inspectInstall(tree.installDir);

    expect(info?.installDir).toBe(tree.installDir);
    expect(info?.resourcesDir).toBe(tree.resourcesDir);
    expect(info?.exePath).toBe(tree.exePath);
    expect(info?.version).toBe("0.1.10");
    expect(info?.channel).toBe("beta");
  });

  it("rejects a directory without a resources asar", async () => {
    const root = await newRoot();
    expect(inspectInstall(root)).toBeNull();
  });
});

describe("parseRegistryInstallLocations", () => {
  it("keeps only the T3 Code uninstall keys", () => {
    const stdout = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{guid-1}",
      "    DisplayName    REG_SZ    T3 Code (Beta) 0.1.10",
      "    InstallLocation    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\T3 Code (Beta)",
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{guid-2}",
      "    DisplayName    REG_SZ    Not Our App",
      "    InstallLocation    REG_SZ    C:\\Other",
      "",
    ].join("\r\n");

    expect(parseRegistryInstallLocations(stdout)).toEqual([
      "C:\\Users\\me\\AppData\\Local\\Programs\\T3 Code (Beta)",
    ]);
  });

  it("falls back to the uninstaller or the icon when InstallLocation is missing", () => {
    // electron-builder's T3 Code entry has no InstallLocation: unlike most installers it only
    // writes UninstallString, QuietUninstallString and DisplayIcon.
    const stdout = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{guid-1}",
      "    DisplayName    REG_SZ    T3 Code (Beta) 0.1.10",
      '    UninstallString    REG_SZ    "C:\\Users\\me\\AppData\\Local\\Programs\\t3code\\Uninstall T3 Code (Beta).exe" /currentuser',
      "    QuietUninstallString    REG_SZ    \"C:\\Users\\me\\AppData\\Local\\Programs\\t3code\\Uninstall T3 Code (Beta).exe\" /currentuser /S",
      "    DisplayIcon    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\t3code\\T3 Code (Beta).exe,0",
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{guid-2}",
      "    DisplayName    REG_SZ    T3 Code (Nightly) 0.1.11",
      "    DisplayIcon    REG_SZ    C:\\Elsewhere\\T3 Code (Nightly).exe,0",
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{guid-3}",
      "    DisplayName    REG_SZ    Not Our App",
      '    UninstallString    REG_SZ    "C:\\Other\\Uninstall.exe"',
      "",
    ].join("\r\n");

    expect(parseRegistryInstallLocations(stdout)).toEqual([
      "C:\\Users\\me\\AppData\\Local\\Programs\\t3code",
      "C:\\Elsewhere",
    ]);
  });
});

describe("installDirFromCommand", () => {
  it("reads the exe directory from uninstall strings and icons", () => {
    expect(installDirFromCommand('"C:\\Apps\\t3code\\Uninstall T3 Code (Beta).exe" /currentuser')).toBe("C:\\Apps\\t3code");
    expect(installDirFromCommand('"C:\\Apps\\t3code\\Uninstall T3 Code (Beta).exe" /currentuser /S')).toBe("C:\\Apps\\t3code");
    expect(installDirFromCommand("C:\\Apps\\t3code\\T3 Code (Beta).exe,0")).toBe("C:\\Apps\\t3code");
    expect(installDirFromCommand("C:\\Apps\\t3code\\T3 Code.exe --uninstall")).toBe("C:\\Apps\\t3code");
  });

  it("ignores values that are not a Windows executable path", () => {
    expect(installDirFromCommand(null)).toBeNull();
    expect(installDirFromCommand("")).toBeNull();
    expect(installDirFromCommand("t3 code")).toBeNull();
    expect(installDirFromCommand("C:\\Apps\\t3code\\readme.txt")).toBeNull();
  });
});

describe("findInstalls", () => {
  it("finds installs under LOCALAPPDATA/Programs and dedupes registry hits", async () => {
    const root = await newRoot();
    const beta = await createFakeInstall({ root, dirName: "T3 Code (Beta)", exeName: "T3 Code (Beta).exe" });
    const nightly = await createFakeInstall({
      root,
      dirName: "T3 Code (Nightly)",
      exeName: "T3 Code (Nightly).exe",
      version: "0.1.11",
    });
    trees.push(beta, nightly);

    const registry = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{guid}",
      `    DisplayName    REG_SZ    T3 Code (Beta) 0.1.10`,
      `    InstallLocation    REG_SZ    ${beta.installDir}`,
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{other}",
      "    DisplayName    REG_SZ    Not Our App",
      "    InstallLocation    REG_SZ    C:\\Other",
      "",
    ].join("\r\n");

    const found = await findInstalls({
      localAppDataDir: root,
      platform: "win32",
      registryQuery: () => registry,
    });

    expect(found.map((install) => install.installDir).sort()).toEqual([beta.installDir, nightly.installDir].sort());
    expect(found.find((install) => install.installDir === nightly.installDir)?.channel).toBe("nightly");
    expect(found.find((install) => install.installDir === nightly.installDir)?.version).toBe("0.1.11");
  });

  it("finds an install whose folder is named t3code (no space)", async () => {
    const root = await newRoot();
    const install = await createFakeInstall({ root, dirName: "t3code" });
    trees.push(install);

    const found = await findInstalls({
      localAppDataDir: root,
      platform: "win32",
      registryQuery: () => null,
    });

    expect(found).toHaveLength(1);
    expect(found[0].installDir).toBe(install.installDir);
    expect(found[0].channel).toBe("beta");
  });

  it("finds an install that only the registry knows about", async () => {
    const root = await newRoot();
    const localAppData = await newRoot();
    const beta = await createFakeInstall({ root });
    trees.push(beta);

    const found = await findInstalls({
      localAppDataDir: localAppData,
      platform: "win32",
      registryQuery: () =>
        [
          "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{guid}",
          "    DisplayName    REG_SZ    T3 Code (Beta) 0.1.10",
          `    InstallLocation    REG_SZ    ${beta.installDir}`,
        ].join("\r\n"),
    });

    expect(found).toHaveLength(1);
    expect(found[0].installDir).toBe(beta.installDir);
  });

  it("skips the registry off Windows and returns nothing for an empty machine", async () => {
    const localAppData = await newRoot();
    let queried = false;
    const found = await findInstalls({
      localAppDataDir: localAppData,
      platform: "darwin",
      registryQuery: () => {
        queried = true;
        return null;
      },
    });

    expect(found).toEqual([]);
    expect(queried).toBe(false);
  });
});
