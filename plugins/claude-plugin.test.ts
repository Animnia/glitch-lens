import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = join(repoRoot, "plugins", "glitch-lens-claude");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("claude code plugin packaging", () => {
  it("has a valid plugin manifest pointing at an existing skills directory", async () => {
    const manifest = await json(join(pluginRoot, ".claude-plugin", "plugin.json"));

    expect(manifest.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(typeof manifest.version).toBe("string");
    expect(typeof manifest.description).toBe("string");
    expect(manifest.skills).toBe("./skills/");
    expect(existsSync(join(pluginRoot, "skills"))).toBe(true);

    for (const field of ["homepage", "repository", "license"]) {
      expect(typeof manifest[field], field).toBe("string");
    }
  });

  it("ships a skill whose frontmatter satisfies the agent skills standard", async () => {
    const skillPath = join(pluginRoot, "skills", "glitch-lens", "SKILL.md");
    const source = await readFile(skillPath, "utf8");
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(frontmatter, "SKILL.md must start with frontmatter").toBeTruthy();

    const name = frontmatter?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    expect(name).toBe("glitch-lens");
    expect(description?.length).toBeGreaterThan(20);
    expect(description?.length ?? 0).toBeLessThanOrEqual(1024);
  });

  it("exposes the plugin through the repo marketplace with required owner and policy fields", async () => {
    const marketplace = await json(join(repoRoot, ".claude-plugin", "marketplace.json"));

    expect(marketplace.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const owner = marketplace.owner as Record<string, unknown> | undefined;
    expect(typeof owner?.name, "marketplace owner.name is required").toBe("string");

    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    const entry = plugins.find((plugin) => plugin.name === "glitch-lens");
    expect(entry, "marketplace must list glitch-lens").toBeTruthy();

    expect(entry?.source).toBe("./plugins/glitch-lens-claude");
    // relative sources resolve against the marketplace root (the repo root here)
    expect(existsSync(join(repoRoot, String(entry?.source)))).toBe(true);
    expect(typeof entry?.description).toBe("string");
  });

  it("keeps the plugin and marketplace versions in sync with package.json", async () => {
    const manifest = await json(join(pluginRoot, ".claude-plugin", "plugin.json"));
    const marketplace = await json(join(repoRoot, ".claude-plugin", "marketplace.json"));
    const pkg = await json(join(repoRoot, "package.json"));
    const entry = (marketplace.plugins as Array<Record<string, unknown>>).find((plugin) => plugin.name === "glitch-lens");

    expect(manifest.version).toBe(pkg.version);
    expect(entry?.version).toBe(pkg.version);
  });
});
