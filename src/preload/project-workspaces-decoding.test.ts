import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { PROJECT_WORKSPACE_LIMITS } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  decodeOptionalProjectWorkspaceInfo,
  decodeProjectWorkspaceContext,
  decodeProjectWorkspaceInfo,
  decodeProjectWorkspaces,
} from "./project-workspaces-decoding";

const context = {
  path: "/projects/animation",
  name: "animation",
  available: true,
  git: { status: "repository", root: "/projects/animation", branch: "main", commit: "abc1234", worktree: false },
  instructions: [{ path: "/projects/animation/AGENTS.md", fileName: "AGENTS.md", scope: "project" }],
  skills: [
    {
      slug: "animation",
      path: "/projects/animation/.agents/skills/animation/SKILL.md",
      folder: ".agents/skills",
      scope: "project",
    },
  ],
  truncated: false,
};
describe("local project metadata response boundary", () => {
  it("retains useful metadata and discards unrelated secret fields", () => {
    expect(
      decodeProjectWorkspaceContext({
        ...context,
        secret: "fixture-secret",
        git: { ...context.git, token: "fixture-secret" },
      }),
    ).toEqual(context);
    expect(
      decodeProjectWorkspaceInfo({
        id: "one",
        name: "animation",
        path: context.path,
        context,
        password: "fixture-secret",
      }),
    ).toEqual({ id: "one", name: "animation", path: context.path, context });
    expect(decodeOptionalProjectWorkspaceInfo(null)).toBeNull();
  });
  it("rejects malformed or unbounded metadata before renderer use", () => {
    for (const value of [
      null,
      {},
      { ...context, available: "yes" },
      { ...context, path: "x".repeat(INPUT_LIMITS.path + 1) },
      { ...context, path: "/project\0bad" },
      { ...context, git: { status: "unknown" } },
      { ...context, git: { ...context.git, branch: 1 } },
      { ...context, skills: [{ ...context.skills[0], scope: "remote" }] },
      { ...context, skills: Array(PROJECT_WORKSPACE_LIMITS.skills + 1).fill(context.skills[0]) },
      { ...context, instructions: Array(PROJECT_WORKSPACE_LIMITS.instructions + 1).fill(context.instructions[0]) },
    ])
      expect(() => decodeProjectWorkspaceContext(value)).toThrow("Invalid project workspace response.");
    const project = { id: "one", name: "animation", path: context.path };
    expect(() => decodeProjectWorkspaces([project, project])).toThrow();
    expect(() => decodeProjectWorkspaces(Array(PROJECT_WORKSPACE_LIMITS.projects + 1).fill(project))).toThrow();
  });
});
