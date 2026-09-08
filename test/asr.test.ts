import { describe, expect, test } from "bun:test";

import { isGpuFailure, sidecarFailure } from "../src/asr";

describe("isGpuFailure", () => {
  test("recognises the two shapes faster-whisper actually crashes with", () => {
    expect(isGpuFailure("RuntimeError: CUDA failed with error out of memory")).toBe(true);
    expect(isGpuFailure("what():  CUDA failed with error unknown error")).toBe(true);
  });

  test("recognises the neighbouring library failures", () => {
    expect(isGpuFailure("cuDNN error: CUDNN_STATUS_NOT_INITIALIZED")).toBe(true);
    expect(isGpuFailure("CUBLAS_STATUS_ALLOC_FAILED")).toBe(true);
  });

  test("leaves unrelated crashes alone", () => {
    expect(isGpuFailure("ValueError: The maximum decoding length must be > 0")).toBe(false);
    expect(isGpuFailure("FileNotFoundError: audio.m4a")).toBe(false);
  });
});

describe("sidecarFailure", () => {
  test("a GPU crash names the escape hatch", async () => {
    const msg = await sidecarFailure(
      { code: 1, stderr: "Traceback\nRuntimeError: CUDA failed with error out of memory" },
      "cuda",
    );
    expect(msg).toContain("-d cpu");
    expect(msg).toContain("GPU rejected");
    // The original traceback is still there to read.
    expect(msg).toContain("RuntimeError: CUDA failed with error out of memory");
  });

  test("an unrelated crash is reported plainly, not as a GPU problem", async () => {
    const msg = await sidecarFailure(
      { code: 1, stderr: "ValueError: The maximum decoding length must be > 0" },
      "cuda",
    );
    expect(msg).toContain("exited 1");
    expect(msg).toContain("maximum decoding length");
    expect(msg).not.toContain("-d cpu");
  });

  test("keeps only the tail of a long traceback", async () => {
    const stderr = Array.from({ length: 40 }, (_, i) => `frame ${i}`).join("\n");
    const msg = await sidecarFailure({ code: 1, stderr }, "cuda");
    expect(msg).toContain("frame 39");
    expect(msg).not.toContain("frame 5\n");
  });
});
