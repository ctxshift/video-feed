import { describe, expect, test } from "bun:test";

import { cacheHome, configHome, dataHome } from "../src/paths";
import { hintFor, shellCommand } from "../src/proc";
import { unicodeSupported } from "../src/ui";
import { expandHome, isBareName } from "../src/workdir";

const win = { platform: "win32" as const, home: "C:\\Users\\dev" };
const winEnv = { APPDATA: "C:\\Users\\dev\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" };
const posix = { platform: "linux" as const, home: "/home/dev", env: {} };

describe("platform directories", () => {
  test("Windows uses roaming AppData for settings and Local for bulk data", () => {
    expect(configHome({ ...win, env: winEnv })).toBe("C:\\Users\\dev\\AppData\\Roaming\\video-feed");
    expect(dataHome({ ...win, env: winEnv })).toBe("C:\\Users\\dev\\AppData\\Local\\video-feed\\data");
    expect(cacheHome({ ...win, env: winEnv })).toBe("C:\\Users\\dev\\AppData\\Local\\video-feed\\cache");
  });

  test("work dirs and the sidecar cache never share a directory", () => {
    expect(dataHome({ ...win, env: winEnv })).not.toBe(cacheHome({ ...win, env: winEnv }));
  });

  test("POSIX keeps the XDG layout it already had", () => {
    expect(configHome(posix)).toBe("/home/dev/.config/video-feed");
    expect(dataHome(posix)).toBe("/home/dev/.local/share/video-feed");
    expect(cacheHome(posix)).toBe("/home/dev/.cache/video-feed");
  });

  test("XDG_* wins everywhere it is set, Windows included", () => {
    const env = { ...winEnv, XDG_CONFIG_HOME: "X:\\cfg", XDG_DATA_HOME: "X:\\data" };
    expect(configHome({ ...win, env })).toBe("X:\\cfg\\video-feed");
    expect(dataHome({ ...win, env })).toBe("X:\\data\\video-feed");
    expect(configHome({ ...posix, env: { XDG_CONFIG_HOME: "/tmp/cfg" } })).toBe("/tmp/cfg/video-feed");
  });

  test("Windows without the AppData variables still lands somewhere real", () => {
    expect(configHome({ ...win, env: {} })).toBe("C:\\Users\\dev\\.config\\video-feed");
  });
});

describe("shellCommand", () => {
  test("POSIX gets sh, not bash", () => {
    expect(shellCommand("op read x", { platform: "linux" })).toEqual(["/bin/sh", "-c", "op read x"]);
  });

  test("Windows gets the interpreter ComSpec names", () => {
    expect(shellCommand("op read x", { platform: "win32", env: { ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" } }))
      .toEqual(["C:\\WINDOWS\\system32\\cmd.exe", "/d", "/s", "/c", "op read x"]);
  });

  test("Windows falls back to cmd.exe when ComSpec is unset", () => {
    expect(shellCommand("x", { platform: "win32", env: {} })[0]).toBe("cmd.exe");
  });
});

describe("hintFor", () => {
  test("advice matches the platform the user is actually on", () => {
    expect(hintFor("ffmpeg", "win32")).toContain("winget");
    expect(hintFor("ffmpeg", "darwin")).toContain("brew");
    expect(hintFor("ffmpeg", "linux")).toContain("apt");
    expect(hintFor("uv", "win32")).toContain("winget");
  });

  test("no apt advice ever reaches a Windows user", () => {
    for (const tool of ["uv", "ffmpeg", "yt-dlp"]) {
      expect(hintFor(tool, "win32")).not.toContain("apt");
    }
  });
});

describe("isBareName", () => {
  test("a name from `vid ls` is a name", () => {
    expect(isBareName("some-talk-abc123", "win32")).toBe(true);
    expect(isBareName("some-talk-abc123", "linux")).toBe(true);
  });

  test("a Windows path is a path, backslashes and all", () => {
    expect(isBareName("C:\\Users\\dev\\vids\\talk", "win32")).toBe(false);
    expect(isBareName("vids\\talk", "win32")).toBe(false);
    expect(isBareName("vids/talk", "win32")).toBe(false);
  });

  test("a backslash is a legal POSIX filename character, not a separator", () => {
    expect(isBareName("odd\\name", "linux")).toBe(true);
    expect(isBareName("/home/dev/talk", "linux")).toBe(false);
  });
});

describe("expandHome", () => {
  test("~ expands only as a whole first segment", () => {
    expect(expandHome("~/videos", "/home/dev")).toBe("/home/dev/videos");
    expect(expandHome("~", "/home/dev")).toBe("/home/dev");
    expect(expandHome("~files", "/home/dev")).toBe("~files");
    expect(expandHome("~\\videos", "C:\\Users\\dev")).toBe("C:\\Users\\dev\\videos");
  });
});

describe("unicodeSupported", () => {
  test("box-drawing everywhere but the legacy Windows console", () => {
    expect(unicodeSupported({}, "linux")).toBe(true);
    expect(unicodeSupported({}, "darwin")).toBe(true);
    expect(unicodeSupported({}, "win32")).toBe(false);
    expect(unicodeSupported({ WT_SESSION: "1" }, "win32")).toBe(true);
    expect(unicodeSupported({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true);
  });
});
