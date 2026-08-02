import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repoRoot, "plugins", "glitch-lens");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("codex plugin packaging", () => {
  it("has a valid plugin manifest pointing at an existing skills directory", async () => {
    const manifest = await json(join(pluginRoot, ".codex-plugin", "plugin.json"));

    expect(manifest.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(typeof manifest.version).toBe("string");
    expect(typeof manifest.description).toBe("string");
    expect(manifest.skills).toBe("./skills/");
    expect(existsSync(join(pluginRoot, "skills"))).toBe(true);

    for (const field of ["homepage", "repository", "license"] ) {
      expect(typeof manifest[field], field).toBe("string");
    }
  });

  it("ships a skill whose frontmatter satisfies the agent skills standard", async () => {
    const skillPath = join(pluginRoot, "skills", "glitch-lens", "SKILL.md");
    const source = await readFile(skillPath, "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter, "SKILL.md must start with frontmatter").toBeTruthy();

    const name = frontmatter?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    expect(name).toBe("glitch-lens");
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(description?.length).toBeGreaterThan(20);
    expect(description?.length ?? 0).toBeLessThanOrEqual(1024);
  });

  it("exposes the plugin through the repo marketplace with required policy fields", async () => {
    const marketplace = await json(join(repoRoot, ".agents", "plugins", "marketplace.json"));
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    expect(Array.isArray(plugins)).toBe(true);

    const entry = plugins.find((plugin) => plugin.name === "glitch-lens");
    expect(entry, "marketplace must list glitch-lens").toBeTruthy();

    const source = entry?.source as Record<string, unknown>;
    expect(source.path).toBe("./plugins/glitch-lens");
    expect(String(source.path).startsWith("./")).toBe(true);
    // source.path resolves relative to the marketplace root (the repo root here)
    expect(existsSync(join(repoRoot, String(source.path)))).toBe(true);

    const policy = entry?.policy as Record<string, unknown>;
    expect(policy.installation).toBe("AVAILABLE");
    expect(policy.authentication).toBe("ON_INSTALL");
    expect(typeof entry?.category).toBe("string");
  });

  it("keeps the plugin version in sync with package.json", async () => {
    const manifest = await json(join(pluginRoot, ".codex-plugin", "plugin.json"));
    const pkg = await json(join(repoRoot, "package.json"));
    expect(manifest.version).toBe(pkg.version);
  });
});
