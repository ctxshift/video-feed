import { describe, expect, test } from "bun:test";

import { cacheHome, configHome, dataHome } from "../src/paths";
import { hintFor, shellCommand } from "../src/proc";
import { unicodeSupported } from "../src/ui";
import { expandHome, isBareName } from "../src/workdir";

const home = { home: "/home/dev", env: {} };

describe("platform directories", () => {
  test("one layout everywhere: XDG, and no per-platform special case", () => {
    expect(configHome(home)).toBe("/home/dev/.config/video-feed");
    expect(dataHome(home)).toBe("/home/dev/.local/share/video-feed");
    expect(cacheHome(home)).toBe("/home/dev/.cache/video-feed");
  });

  test("each XDG variable overrides its own directory", () => {
    expect(configHome({ home: "/home/dev", env: { XDG_CONFIG_HOME: "/tmp/cfg" } }))
      .toBe("/tmp/cfg/video-feed");
    expect(dataHome({ home: "/home/dev", env: { XDG_DATA_HOME: "/tmp/data" } }))
      .toBe("/tmp/data/video-feed");
    expect(cacheHome({ home: "/home/dev", env: { XDG_CACHE_HOME: "/tmp/cache" } }))
      .toBe("/tmp/cache/video-feed");
  });

  test("an override to one directory leaves the others alone", () => {
    const env = { XDG_CONFIG_HOME: "/tmp/cfg" };
    expect(dataHome({ home: "/home/dev", env })).toBe("/home/dev/.local/share/video-feed");
  });

  test("work dirs and the sidecar cache never share a directory", () => {
    expect(dataHome(home)).not.toBe(cacheHome(home));
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
