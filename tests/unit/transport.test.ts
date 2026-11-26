import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dbConnection, main, runners } from "../../src/server.ts";

function spyOnTransports() {
  return {
    stdio: vi.spyOn(runners, "runStdio").mockResolvedValue(),
    sse: vi.spyOn(runners, "runSse").mockResolvedValue(),
    http: vi.spyOn(runners, "runStreamableHttp").mockResolvedValue(),
  };
}

const URL_ARG = "postgresql://user:password@localhost/db";

beforeEach(() => {
  vi.stubEnv("DATABASE_URI", undefined);
  vi.spyOn(dbConnection, "poolConnect").mockResolvedValue({
    connect: vi.fn(),
    end: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("transport selection", () => {
  it("--transport=stdio runs only the stdio transport", async () => {
    const spies = spyOnTransports();

    await main([URL_ARG, "--transport=stdio"]);

    expect(spies.stdio).toHaveBeenCalledOnce();
    expect(spies.sse).not.toHaveBeenCalled();
    expect(spies.http).not.toHaveBeenCalled();
  });

  it("--transport=sse runs only the SSE transport", async () => {
    const spies = spyOnTransports();

    await main([URL_ARG, "--transport=sse"]);

    expect(spies.stdio).not.toHaveBeenCalled();
    expect(spies.sse).toHaveBeenCalledOnce();
    expect(spies.http).not.toHaveBeenCalled();
  });

  it("--transport=streamable-http runs only the streamable HTTP transport", async () => {
    const spies = spyOnTransports();

    await main([URL_ARG, "--transport=streamable-http"]);

    expect(spies.stdio).not.toHaveBeenCalled();
    expect(spies.sse).not.toHaveBeenCalled();
    expect(spies.http).toHaveBeenCalledOnce();
  });

  it("defaults to the stdio transport", async () => {
    const spies = spyOnTransports();

    await main([URL_ARG]);

    expect(spies.stdio).toHaveBeenCalledOnce();
    expect(spies.sse).not.toHaveBeenCalled();
    expect(spies.http).not.toHaveBeenCalled();
  });

  it("accepts a separate value for --transport", async () => {
    const spies = spyOnTransports();

    await main([URL_ARG, "--transport", "sse"]);

    expect(spies.sse).toHaveBeenCalledOnce();
  });
});

describe("transport host and port", () => {
  it("passes the streamable HTTP host and port to the transport", async () => {
    const spies = spyOnTransports();

    await main([
      URL_ARG,
      "--transport=streamable-http",
      "--streamable-http-host=0.0.0.0",
      "--streamable-http-port=9000",
    ]);

    expect(spies.http).toHaveBeenCalledWith(
      expect.any(Function),
      "0.0.0.0",
      9000
    );
  });

  it("passes the SSE host and port to the transport", async () => {
    const spies = spyOnTransports();

    await main([
      URL_ARG,
      "--transport=sse",
      "--sse-host=0.0.0.0",
      "--sse-port=8080",
    ]);

    expect(spies.sse).toHaveBeenCalledWith(
      expect.any(Function),
      "0.0.0.0",
      8080
    );
  });
});
