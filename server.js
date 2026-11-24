import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

const server = new McpServer({ name: "code-reviewer-tools", version: "2.0.0" });

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 120000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr ? "\n" + r.stderr : ""), err: r.error };
}
const text = (t) => ({ content: [{ type: "text", text: t }] });
const cap = (s, n) => (s.length > n ? s.slice(0, n) + "\n...[TRUNCATED]" : s);

function safePath(repo, rel) {
  const root = fs.realpathSync(repo);
  const full = path.resolve(root, rel);
  const real = fs.existsSync(full) ? fs.realpathSync(full) : full;
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error("path is outside the repo");
  return real;
}
const readPkg = (repo) => {
  const pj = path.join(repo, "package.json");
  if (!fs.existsSync(pj)) return null;
  try { return JSON.parse(fs.readFileSync(pj, "utf8")); } catch { return null; }
};

server.tool("list_changed_files",
  "List changed files in the git repo including NEW untracked files. Status codes: M=modified, A=added, D=deleted, ??=new untracked file.",
  { repo_path: z.string().describe("Absolute path to the git repo") },
  async ({ repo_path }) => {
    const r = sh("git", ["status", "--porcelain"], repo_path);
    return text(r.out.trim() || "No changes.");
  });

server.tool("get_diff",
  "Git diff vs HEAD for tracked files (one file or whole repo). For untracked (??) files use read_file instead.",
  { repo_path: z.string(), file: z.string().optional().describe("Relative file path") },
  async ({ repo_path, file }) => {
    const args = ["diff", "HEAD", "--unified=3"];
    if (file) args.push("--", file);
    const r = sh("git", args, repo_path);
    return text(cap(r.out.trim() || "No diff.", 20000));
  });

server.tool("read_file",
  "Read a file inside the repo (use for new untracked files or surrounding context). Optional line range.",
  {
    repo_path: z.string(),
    file: z.string().describe("Relative path inside the repo"),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  },
  async ({ repo_path, file, start_line, end_line }) => {
    try {
      const full = safePath(repo_path, file);
      if (!fs.statSync(full).isFile()) return text("ERROR: not a file");
      let lines = fs.readFileSync(full, "utf8").split("\n");
      const s = (start_line || 1) - 1;
      lines = lines.slice(s, end_line || lines.length);
      return text(cap(lines.map((l, i) => `${s + i + 1}: ${l}`).join("\n"), 20000));
    } catch (e) { return text("ERROR: " + e.message); }
  });

server.tool("search_code",
  "Search the repo for a literal string (git grep). Use to find callers/usages of changed functions.",
  { repo_path: z.string(), pattern: z.string().describe("Literal text to find") },
  async ({ repo_path, pattern }) => {
    const r = sh("git", ["grep", "-n", "-I", "-F", "-e", pattern], repo_path);
    if (r.code === 1) return text("No matches.");
    return text(cap(r.out.trim(), 8000));
  });

server.tool("git_log",
  "Recent commit messages (oneline) for context.",
  { repo_path: z.string(), count: z.number().int().min(1).max(50).optional() },
  async ({ repo_path, count }) => {
    const r = sh("git", ["log", "--oneline", "-n", String(count || 10)], repo_path);
    return text(r.out.trim() || "No commits.");
  });

server.tool("run_tests",
  "Run 'npm test' if package.json has a real test script. Returns NO_TESTS if there is none.",
  { repo_path: z.string() },
  async ({ repo_path }) => {
    const pkg = readPkg(repo_path);
    const t = pkg?.scripts?.test;
    if (!t || t.includes("no test specified")) return text("NO_TESTS: no real test script. Not a failure.");
    const r = sh("npm", ["test", "--silent"], repo_path);
    return text(`EXIT ${r.code}\n` + cap(r.out, 6000));
  });

server.tool("run_lint",
  "Run 'npm run lint' if package.json has a lint script. Returns NO_LINT if there is none.",
  { repo_path: z.string() },
  async ({ repo_path }) => {
    const pkg = readPkg(repo_path);
    if (!pkg?.scripts?.lint) return text("NO_LINT: no lint script. Not a failure.");
    const r = sh("npm", ["run", "lint", "--silent"], repo_path);
    return text(`EXIT ${r.code}\n` + cap(r.out, 6000));
  });

server.tool("write_review",
  "Save the final review report as a markdown file in ~/code-reviewer-agent/reviews/ (never inside the reviewed repo).",
  { repo_path: z.string(), content: z.string().describe("Full review report text") },
  async ({ repo_path, content }) => {
    const dir = path.join(os.homedir(), "code-reviewer-agent", "reviews");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${stamp}-${path.basename(repo_path).replace(/[^\w.-]/g, "_")}.md`;
    const out = path.join(dir, name);
    fs.writeFileSync(out, `# Review of ${repo_path}\n\n${content}\n`);
    return text("Saved: " + out);
  });

await server.connect(new StdioServerTransport());
console.error("CodeReviewer tools server v2 running on stdio");