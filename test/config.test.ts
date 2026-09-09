import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configPath, writeApiKey } from "../src/config";

let dir: string;
const saved = process.env.XDG_CONFIG_HOME;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vid-config-"));
  process.env.XDG_CONFIG_HOME = dir;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
  await rm(dir, { recursive: true, force: true });
});

const read = () => Bun.file(configPath()).text();

describe("writeApiKey", () => {
  test("creates the config file and stores the key as real TOML", async () => {
    const { created } = await writeApiKey("AIzaTESTKEY0123456789");
    expect(created).toBe(true);

    const text = await read();
    expect(Bun.TOML.parse(text)).toMatchObject({ gemini: { api_key: "AIzaTESTKEY0123456789" } });
  });

  test("replaces the commented example rather than sitting above it", async () => {
    await writeApiKey("AIzaTESTKEY0123456789");
    const text = await read();

    // The line must be live TOML, and the explanation above it must survive.
    expect(text).toContain('api_key = "AIzaTESTKEY0123456789"');
    expect(text).toContain("vid config --set-key");
    expect(text).not.toContain('# api_key = "..."');
  });

  test("a second key updates the first instead of adding a duplicate", async () => {
    await writeApiKey("AIzaFIRST0123456789");
    const { created } = await writeApiKey("AIzaSECOND0123456789");
    expect(created).toBe(false);

    const text = await read();
    const live = text.split("\n").filter((l) => /^[ \t]*api_key[ \t]*=/.test(l));
    expect(live).toHaveLength(1);
    expect(Bun.TOML.parse(text)).toMatchObject({ gemini: { api_key: "AIzaSECOND0123456789" } });
  });

  test("the comments documenting every other setting are kept", async () => {
    await writeApiKey("AIzaTESTKEY0123456789");
    const text = await read();
    expect(text).toContain("[whisper]");
    expect(text).toContain("[vision]");
    expect(text).toContain("api_key_command");
  });

  test("a key with TOML-special characters survives the round trip", async () => {
    const awkward = 'quote"and\\backslash';
    await writeApiKey(awkward);
    expect(Bun.TOML.parse(await read())).toMatchObject({ gemini: { api_key: awkward } });
  });

  test.skipIf(process.platform === "win32")("the file is not readable by anyone else", async () => {
    await writeApiKey("AIzaTESTKEY0123456789");
    const s = await stat(configPath());
    expect(s.mode & 0o077).toBe(0);
  });
});
