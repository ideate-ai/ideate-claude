import * as fs from "fs";
import * as path from "path";
import type { ToolContext } from "../types.js";
import {
  createIdeateProject,
  IdeateConfigJson,
  IDEATE_SUBDIRS,
  DEFAULT_ARTIFACT_DIRECTORY,
} from "../config.js";

// ---------------------------------------------------------------------------
// handleBootstrapWorkspace — create .ideate.json + artifact directory structure
// ---------------------------------------------------------------------------

export async function handleBootstrapWorkspace(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const projectName = args.project_name as string | undefined;
  const artifactDirectoryName =
    typeof args.artifact_directory_name === "string" && args.artifact_directory_name.trim() !== ""
      ? args.artifact_directory_name.trim()
      : DEFAULT_ARTIFACT_DIRECTORY;

  // Derive the project root from the ideateDir (strip trailing artifact dir component).
  // ctx.ideateDir is the artifact directory; the project root is one level up.
  const projectRoot = path.dirname(ctx.ideateDir);

  // Idempotency: if .ideate.json already exists do not overwrite it, but still
  // ensure all subdirectories exist inside the (possibly pre-existing) artifact dir.
  const ideateJsonPath = path.join(projectRoot, ".ideate.json");
  if (fs.existsSync(ideateJsonPath)) {
    // Ensure all subdirectories exist (idempotent directory creation).
    for (const sub of IDEATE_SUBDIRS) {
      fs.mkdirSync(path.join(ctx.ideateDir, sub), { recursive: true });
    }
    return JSON.stringify(
      { status: "initialized", subdirectories: [...IDEATE_SUBDIRS] },
      null,
      2
    );
  }

  // Build config for .ideate.json — only include project_name when provided.
  const configFields: Omit<IdeateConfigJson, "schema_version" | "artifact_directory"> = {};
  if (projectName) {
    configFields.project_name = projectName;
  }

  createIdeateProject(projectRoot, configFields, artifactDirectoryName);

  return JSON.stringify(
    {
      status: "initialized",
      subdirectories: [...IDEATE_SUBDIRS],
    },
    null,
    2
  );
}
