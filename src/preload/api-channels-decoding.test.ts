import type { ApiChannelDefinition, ApiChannelRun, ApiChannelSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  decodeApiChannelDefinition,
  decodeApiChannelRun,
  decodeApiChannelSummaries,
  decodeApiChannelSummary,
  decodeApiChannelTemplates,
} from "./api-channels-decoding";

const definition: ApiChannelDefinition = {
  name: "Boundary fixture",
  description: "Public request metadata",
  baseUrl: "https://api.example.test",
  auth: { type: "bearer", name: "Authorization", prefix: "Bearer " },
  headers: [],
  artifactHosts: ["files.example.test"],
  operations: [
    {
      id: "recognize",
      name: "Recognize",
      description: "Fixture",
      method: "POST",
      path: "/ocr",
      bodyType: "json",
      body: JSON.stringify({ image: "{{image}}" }),
      query: [],
      parameters: [
        {
          name: "image",
          type: "file",
          required: true,
          description: "Image input",
          defaultJson: "",
          fileEncoding: "data-url",
        },
      ],
      readOnly: false,
      response: {
        format: "json",
        resultPath: "text",
        errorPath: "",
        okValues: [],
        fileName: "",
        mimeType: "",
        artifacts: [],
        statusPath: "",
        successValues: [],
        failureValues: [],
      },
      job: null,
    },
  ],
};
const summary: ApiChannelSummary = {
  id: "channel-fixture",
  definition,
  enabled: true,
  source: "user",
  credentialStatus: "saved",
  updatedAt: "2026-11-04T00:00:00.000Z",
};
const run: ApiChannelRun = {
  id: "run-fixture",
  channelId: "channel-fixture",
  operationId: "recognize",
  status: "completed",
  output: { text: "Recognized text", credential: "[redacted]" },
  artifacts: [{ id: "file-fixture", fileName: "result.txt", mimeType: "text/plain" }],
  message: null,
};

describe("API endpoint preload boundary", () => {
  it("admits public metadata and file-encoding declarations without a credential", () => {
    expect(decodeApiChannelSummary(summary)).toEqual(summary);
    expect(decodeApiChannelRun(run)).toEqual(run);
    expect(decodeApiChannelRun({ ...run, status: "unknown", output: null }).status).toBe("unknown");
    expect(decodeApiChannelRun({ ...run, outputTruncated: true }).outputTruncated).toBe(true);
    expect(() => decodeApiChannelRun({ ...run, outputTruncated: "yes" })).toThrow();
    expect(
      decodeApiChannelTemplates([
        { id: "fixture", name: "Fixture", description: "Example", docsUrl: "https://example.test/docs", definition },
      ]),
    ).toHaveLength(1);
    expect(
      decodeApiChannelTemplates([
        { id: "custom", name: "Custom", description: "User-defined", docsUrl: "", definition },
      ]),
    ).toHaveLength(1);
    expect(() =>
      decodeApiChannelTemplates([
        { id: "custom", name: "Custom", description: "User-defined", docsUrl: "javascript:alert(1)", definition },
      ]),
    ).toThrow();
  });
  it.each(["apiKey", "sealedKey", "password", "token", "credentialValue"])(
    "refuses an unexpected %s field at credential-bearing boundaries",
    (field) => {
      expect(() => decodeApiChannelSummary({ ...summary, [field]: "do-not-expose" })).toThrow();
      expect(() =>
        decodeApiChannelDefinition({ ...definition, auth: { ...definition.auth, [field]: "do-not-expose" } }),
      ).toThrow();
      expect(() => decodeApiChannelRun({ ...run, [field]: "do-not-expose" })).toThrow();
    },
  );
  it("refuses private URLs, paths, and authentication headers sent by a faulty adapter", () => {
    for (const baseUrl of [
      "file:///etc/passwd",
      "http://remote.example.test",
      "https://user:secret@example.test",
      "https://example.test?token=secret",
    ]) {
      expect(() => decodeApiChannelDefinition({ ...definition, baseUrl })).toThrow();
    }
    expect(() =>
      decodeApiChannelDefinition({
        ...definition,
        headers: [{ name: "Authorization", value: "Bearer do-not-expose" }],
      }),
    ).toThrow();
    expect(() =>
      decodeApiChannelRun({ ...run, artifacts: [{ ...run.artifacts[0], path: "/private/result.txt" }] }),
    ).toThrow();
    expect(() =>
      decodeApiChannelRun({
        ...run,
        artifacts: [{ ...run.artifacts[0], url: "https://files.example.test?token=secret" }],
      }),
    ).toThrow();
    expect(() =>
      decodeApiChannelRun({
        ...run,
        artifacts: [{ id: "file-fixture", fileName: "../secret", mimeType: "text/plain" }],
      }),
    ).toThrow();
  });
  it("refuses a secret in nested result JSON but accepts an explicit redaction", () => {
    expect(() => decodeApiChannelRun({ ...run, output: { account: { apiKey: "do-not-expose" } } })).toThrow(
      "Invalid public API endpoint result.",
    );
    expect(decodeApiChannelRun({ ...run, output: { account: { apiKey: "[redacted]" } } }).output).toEqual({
      account: { apiKey: "[redacted]" },
    });
    for (const key of ["task_token", "accessToken", "oauth_access_token"])
      expect(() => decodeApiChannelRun({ ...run, output: { [key]: "do-not-expose" } })).toThrow();
  });
  it("rejects malformed and oversized definitions, lists, and unsupported file encoding", () => {
    const operation = definition.operations[0];
    expect(() =>
      decodeApiChannelDefinition({ ...definition, operations: [{ ...operation, body: "x".repeat(64_001) }] }),
    ).toThrow();
    expect(() =>
      decodeApiChannelDefinition({ ...definition, operations: Array.from({ length: 97 }, () => operation) }),
    ).toThrow();
    expect(() =>
      decodeApiChannelDefinition({
        ...definition,
        operations: Array.from({ length: 9 }, (_, index) => ({
          ...operation,
          id: `op${index}`,
          description: "x".repeat(64_000),
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeApiChannelDefinition({
        ...definition,
        operations: [{ ...operation, parameters: [{ ...operation?.parameters[0], fileEncoding: "executable" }] }],
      }),
    ).toThrow();
    expect(() => decodeApiChannelSummaries(Array.from({ length: 129 }, () => summary))).toThrow();
    expect(() => decodeApiChannelSummary({ ...summary, updatedAt: "not-a-date" })).toThrow();
  });
  it("bounds result values and refuses non-JSON objects, prototype fields, and cycles", () => {
    interface CircularFixture {
      self?: CircularFixture;
    }
    const circular: CircularFixture = {};
    circular.self = circular;
    for (const output of [
      circular,
      new Date(),
      Infinity,
      "x".repeat(32_001),
      JSON.parse('{"__proto__":{"unsafe":true}}'),
    ]) {
      expect(() => decodeApiChannelRun({ ...run, output })).toThrow();
    }
    let deep: unknown = "value";
    for (let at = 0; at < 66; at += 1) deep = { child: deep };
    expect(() => decodeApiChannelRun({ ...run, output: deep })).toThrow();
  });
});
