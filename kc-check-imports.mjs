#!/usr/bin/env node
// kc-check-imports: TypeScript-aware cherry-pick validation for KissClaw/KissClawJJ
// Validates that cherry-picked commits don't reference symbols missing from the baseline.

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";

const IMPORT_DIAG_CODES = new Set([
  2304, // Cannot find name
  2305, // Module has no exported member
  2307, // Cannot find module
  2724, // No exported member (did you mean?)
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { baseline: null, candidates: null, staged: false, finalTree: null, repo: "." };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--baseline": opts.baseline = args[++i]; break;
      case "--candidates": opts.candidates = args[++i]; break;
      case "--staged": opts.staged = true; break;
      case "--final-tree": opts.finalTree = args[++i]; break;
      case "--repo": opts.repo = args[++i]; break;
      case "--help":
        console.log(`Usage: kc-check-imports [options]
  --baseline <ref>        Baseline ref (required)
  --candidates <range>    Candidate SHA(s) or range (e.g. sha1 sha2 or ga/1.0..HEAD)
  --staged                Check staged changes against baseline
  --final-tree <range>    Check accumulated diff for a range
  --repo <path>           Repository path (default: CWD)`);
        process.exit(0);
    }
  }
  if (!opts.baseline) { console.error("ERROR: --baseline is required"); process.exit(2); }
  if (!opts.candidates && !opts.staged && !opts.finalTree) {
    console.error("ERROR: one of --candidates, --staged, or --final-tree is required");
    process.exit(2);
  }
  opts.repo = resolve(opts.repo);
  return opts;
}

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }).trim();
}

function resolveSHAs(candidatesArg, repo) {
  if (candidatesArg.includes("..")) {
    const lines = git(`rev-list --reverse ${candidatesArg}`, repo);
    return lines ? lines.split("\n") : [];
  }
  return candidatesArg.split(/[\s,]+/).filter(Boolean);
}

function createBaselineWorktree(repo, baseline) {
  const dir = mkdtempSync(join(tmpdir(), "kc-baseline-"));
  try {
    git(`worktree add --detach "${dir}" ${baseline}`, repo);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Failed to create baseline worktree at ${baseline}: ${e.message}`);
  }
  return dir;
}

function cleanupWorktree(repo, dir) {
  try { git(`worktree remove --force "${dir}"`, repo); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

function cherryPickInWorktree(worktreeDir, candidate) {
  try {
    execSync(`git cherry-pick -n ${candidate}`, {
      cwd: worktreeDir, encoding: "utf-8", stdio: "pipe", maxBuffer: 50 * 1024 * 1024
    });
    // Check for conflict markers
    try {
      git("diff --check --cached", worktreeDir);
    } catch {
      return { ok: false, reason: "conflict-markers-detected" };
    }
    return { ok: true };
  } catch (e) {
    const msg = e.stderr || e.stdout || e.message || "";
    if (msg.includes("CONFLICT") || msg.includes("could not apply")) {
      return { ok: false, reason: "cherry-pick-conflict" };
    }
    // Fallback: try patch apply
    try {
      const patchFile = join(tmpdir(), `kc-candidate-${candidate.slice(0, 8)}.patch`);
      const patch = git(`diff --binary ${candidate}^ ${candidate}`, worktreeDir);
      writeFileSync(patchFile, patch);
      execSync(`git apply --index --3way "${patchFile}"`, {
        cwd: worktreeDir, encoding: "utf-8", stdio: "pipe"
      });
      rmSync(patchFile, { force: true });
      return { ok: true };
    } catch {
      return { ok: false, reason: "apply-failed" };
    }
  }
}

function getTouchedFiles(worktreeDir) {
  try {
    const out = git("diff --cached --name-only", worktreeDir);
    return out ? out.split("\n") : [];
  } catch { return []; }
}

function findTsConfig(dir) {
  const tsconfig = join(dir, "tsconfig.json");
  if (existsSync(tsconfig)) {
    const parsed = ts.readConfigFile(tsconfig, p => readFileSync(p, "utf-8"));
    if (parsed.config) {
      const result = ts.parseJsonConfigFileContent(parsed.config, ts.sys, dir);
      return result.options;
    }
  }
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    allowJs: true,
    resolveJsonModule: true,
    strict: false,
  };
}

function runTypeScriptCheck(worktreeDir, touchedFiles) {
  const testFiles = touchedFiles.filter(f => /\.test\.tsx?$/.test(f));
  if (testFiles.length === 0) return { pass: true, diagnostics: [] };

  const fullPaths = testFiles
    .map(f => join(worktreeDir, f))
    .filter(f => existsSync(f));

  if (fullPaths.length === 0) return { pass: true, diagnostics: [] };

  const options = findTsConfig(worktreeDir);
  const program = ts.createProgram(fullPaths, { ...options, noEmit: true });
  const allDiags = ts.getPreEmitDiagnostics(program);

  const importDiags = allDiags.filter(d => IMPORT_DIAG_CODES.has(d.code));
  const formatted = importDiags.map(d => {
    const file = d.file ? d.file.fileName.replace(worktreeDir + "/", "") : "<unknown>";
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    const line = d.file && d.start !== undefined
      ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
      : 0;
    return { file, line, code: d.code, message: msg };
  });

  return { pass: formatted.length === 0, diagnostics: formatted };
}

function checkCandidate(repo, baseline, candidate, worktreeDir) {
  // Reset worktree to baseline
  git(`reset --hard ${baseline}`, worktreeDir);
  git("clean -fd", worktreeDir);

  const applyResult = cherryPickInWorktree(worktreeDir, candidate);
  if (!applyResult.ok) {
    return {
      candidate,
      verdict: "needs-conflict-resolution",
      reason: applyResult.reason,
      diagnostics: [],
    };
  }

  const touched = getTouchedFiles(worktreeDir);
  const tsResult = runTypeScriptCheck(worktreeDir, touched);

  return {
    candidate,
    verdict: tsResult.pass ? "pass" : "fail",
    touchedFiles: touched.length,
    testFiles: touched.filter(f => /\.test\.tsx?$/.test(f)).length,
    diagnostics: tsResult.diagnostics,
  };
}

function checkStaged(repo, baseline, worktreeDir) {
  // Reset worktree to baseline
  git(`reset --hard ${baseline}`, worktreeDir);
  git("clean -fd", worktreeDir);

  // Get the staged diff from the actual repo and apply it
  try {
    const patch = git("diff --cached --binary", repo);
    if (!patch) return { verdict: "pass", reason: "no-staged-changes", diagnostics: [] };
    const patchFile = join(tmpdir(), "kc-staged.patch");
    writeFileSync(patchFile, patch);
    execSync(`git apply --index --3way "${patchFile}"`, {
      cwd: worktreeDir, encoding: "utf-8", stdio: "pipe"
    });
    rmSync(patchFile, { force: true });
  } catch {
    return { verdict: "needs-conflict-resolution", reason: "staged-patch-apply-failed", diagnostics: [] };
  }

  const touched = getTouchedFiles(worktreeDir);
  const tsResult = runTypeScriptCheck(worktreeDir, touched);

  return {
    mode: "staged",
    verdict: tsResult.pass ? "pass" : "fail",
    touchedFiles: touched.length,
    diagnostics: tsResult.diagnostics,
  };
}

function checkFinalTree(repo, baseline, range, worktreeDir) {
  // Reset worktree to baseline
  git(`reset --hard ${baseline}`, worktreeDir);
  git("clean -fd", worktreeDir);

  // Apply the full accumulated diff
  try {
    const patch = git(`diff --binary ${range}`, repo);
    if (!patch) return { verdict: "pass", reason: "no-diff-in-range", diagnostics: [] };
    const patchFile = join(tmpdir(), "kc-final-tree.patch");
    writeFileSync(patchFile, patch);
    execSync(`git apply --index --3way "${patchFile}"`, {
      cwd: worktreeDir, encoding: "utf-8", stdio: "pipe"
    });
    rmSync(patchFile, { force: true });
  } catch {
    return { verdict: "needs-conflict-resolution", reason: "final-tree-patch-apply-failed", diagnostics: [] };
  }

  const touched = getTouchedFiles(worktreeDir);
  const tsResult = runTypeScriptCheck(worktreeDir, touched);

  return {
    mode: "final-tree",
    range,
    verdict: tsResult.pass ? "pass" : "fail",
    touchedFiles: touched.length,
    diagnostics: tsResult.diagnostics,
  };
}

async function main() {
  const opts = parseArgs();
  const results = [];
  let worktreeDir;

  try {
    worktreeDir = createBaselineWorktree(opts.repo, opts.baseline);

    if (opts.candidates) {
      const shas = resolveSHAs(opts.candidates, opts.repo);
      console.error(`Checking ${shas.length} candidate(s) against baseline ${opts.baseline}...`);
      for (const sha of shas) {
        const shortSha = sha.slice(0, 12);
        console.error(`  ${shortSha}...`);
        const result = checkCandidate(opts.repo, opts.baseline, sha, worktreeDir);
        results.push(result);
        const icon = result.verdict === "pass" ? "OK" : result.verdict === "fail" ? "FAIL" : "CONFLICT";
        console.error(`  ${shortSha}: ${icon}${result.diagnostics.length > 0 ? ` (${result.diagnostics.length} diagnostic(s))` : ""}`);
      }
    } else if (opts.staged) {
      console.error(`Checking staged changes against baseline ${opts.baseline}...`);
      const result = checkStaged(opts.repo, opts.baseline, worktreeDir);
      results.push(result);
    } else if (opts.finalTree) {
      console.error(`Checking final tree for range ${opts.finalTree} against baseline ${opts.baseline}...`);
      const result = checkFinalTree(opts.repo, opts.baseline, opts.finalTree, worktreeDir);
      results.push(result);
    }
  } finally {
    if (worktreeDir) cleanupWorktree(opts.repo, worktreeDir);
  }

  const report = { baseline: opts.baseline, results };
  console.log(JSON.stringify(report, null, 2));

  const anyFail = results.some(r => r.verdict !== "pass");
  process.exit(anyFail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
