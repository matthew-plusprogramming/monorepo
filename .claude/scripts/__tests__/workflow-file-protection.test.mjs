/**
 * Integration tests for Write and Bash protection of enforcement files
 *
 * Spec: sg-coercive-gate-enforcement
 * Component 3: Agent Write Protection
 *
 * Covers: AC-3.1, AC-3.2, AC-3.3, AC-3.4, Bash tool defense-in-depth
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs workflow-file-protection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const CLAUDE_DIR = join(PROJECT_ROOT, ".claude");
const COORDINATION_DIR = join(CLAUDE_DIR, "coordination");
const KILL_SWITCH_PATH = join(COORDINATION_DIR, "gate-enforcement-disabled");

/**
 * The write protection may be a separate script or part of gate enforcement.
 * Try the dedicated script first, then fall back.
 */
const WRITE_HOOK_SCRIPT = join(__dirname, "..", "workflow-file-protection.mjs");
const GATE_HOOK_SCRIPT = join(
  __dirname,
  "..",
  "workflow-gate-enforcement.mjs",
);

function getHookScript() {
  if (existsSync(WRITE_HOOK_SCRIPT)) return WRITE_HOOK_SCRIPT;
  if (existsSync(GATE_HOOK_SCRIPT)) return GATE_HOOK_SCRIPT;
  return WRITE_HOOK_SCRIPT;
}

function runHook(stdinData) {
  const hookScript = getHookScript();
  return new Promise((resolve) => {
    const child = spawn("node", [hookScript], { cwd: PROJECT_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
    const input =
      typeof stdinData === "string" ? stdinData : JSON.stringify(stdinData);
    child.stdin.write(input);
    child.stdin.end();
  });
}

function makeWriteStdin(sessionId, filePath) {
  return {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath },
  };
}

function makeBashStdin(sessionId, command) {
  return {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
}

function createKillSwitch() {
  mkdirSync(COORDINATION_DIR, { recursive: true });
  writeFileSync(KILL_SWITCH_PATH, "");
}

let killSwitchExisted = false;

beforeEach(() => {
  killSwitchExisted = existsSync(KILL_SWITCH_PATH);
});

afterEach(() => {
  if (!killSwitchExisted && existsSync(KILL_SWITCH_PATH)) {
    rmSync(KILL_SWITCH_PATH);
  }
});

// ============================================================
// AC-3.1: Blocks writes to gate-override.json
// ============================================================

describe("AC-3.1: Blocks write to gate-override.json", () => {
  it("should exit 2 when agent writes to gate-override.json", async () => {
    // Arrange
    const filePath = join(COORDINATION_DIR, "gate-override.json");

    // Act
    const result = await runHook(makeWriteStdin("test-session", filePath));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/gate-override|blocked|protection/i);
  });
});

// ============================================================
// AC-3.2: Blocks writes to gate-enforcement-disabled
// ============================================================

describe("AC-3.2: Blocks write to gate-enforcement-disabled", () => {
  it("should exit 2 when agent writes to gate-enforcement-disabled", async () => {
    // Arrange
    const filePath = join(COORDINATION_DIR, "gate-enforcement-disabled");

    // Act
    const result = await runHook(makeWriteStdin("test-session", filePath));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(
      /gate-enforcement-disabled|blocked|protection/i,
    );
  });
});

// ============================================================
// AC-3.3: Allows writes to all other files
// ============================================================

describe("AC-3.3: Allows writes to other files", () => {
  it("should exit 0 for normal source code files", async () => {
    // Arrange
    const filePath = join(PROJECT_ROOT, "src", "service.mjs");

    // Act
    const result = await runHook(makeWriteStdin("test-session", filePath));

    // Assert
    expect(result.exitCode).toBe(0);
  });

  it("should exit 2 for session.json in context/ (protected)", async () => {
    // Arrange -- session.json in context/ is a protected enforcement file
    const filePath = join(CLAUDE_DIR, "context", "session.json");

    // Act
    const result = await runHook(makeWriteStdin("test-session", filePath));

    // Assert
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/session\.json|blocked|protected/i);
  });

  it("should exit 0 for other coordination files", async () => {
    // Arrange
    const filePath = join(COORDINATION_DIR, "trace-reads.json");

    // Act
    const result = await runHook(makeWriteStdin("test-session", filePath));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// AC-3.4: Kill switch does NOT disable write protection
// ============================================================

describe("AC-3.4: Kill switch does NOT disable write protection", () => {
  afterEach(() => {
    if (existsSync(KILL_SWITCH_PATH)) rmSync(KILL_SWITCH_PATH);
  });

  it("should STILL block write to gate-override.json with kill switch active", async () => {
    // Arrange
    createKillSwitch();
    const filePath = join(COORDINATION_DIR, "gate-override.json");

    // Act
    const result = await runHook(makeWriteStdin("test-session", filePath));

    // Assert
    expect(result.exitCode).toBe(2);
  });

  it("should STILL block write to gate-enforcement-disabled with kill switch active", async () => {
    // Arrange
    createKillSwitch();
    const filePath = join(COORDINATION_DIR, "gate-enforcement-disabled");

    // Act
    const result = await runHook(makeWriteStdin("test-session", filePath));

    // Assert
    expect(result.exitCode).toBe(2);
  });

  it("should allow writes to normal files with kill switch active", async () => {
    // Arrange
    createKillSwitch();
    const filePath = join(PROJECT_ROOT, "src", "normal-file.mjs");

    // Act
    const result = await runHook(makeWriteStdin("test-session", filePath));

    // Assert
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================
// Bash tool: Blocks write-like commands targeting protected files
// ============================================================

describe("Bash tool: Blocks write operations to protected files", () => {
  it("should block cp to gate-override.json", async () => {
    const result = await runHook(
      makeBashStdin(
        "test-session",
        "cp /tmp/bad.json .claude/coordination/gate-override.json",
      ),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/gate-override\.json/);
  });

  it("should block mv to gate-enforcement-disabled", async () => {
    const result = await runHook(
      makeBashStdin(
        "test-session",
        "mv /tmp/x .claude/coordination/gate-enforcement-disabled",
      ),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/gate-enforcement-disabled/);
  });

  it("should block tee to session.json", async () => {
    const result = await runHook(
      makeBashStdin(
        "test-session",
        "echo data | tee .claude/context/session.json",
      ),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/session\.json/);
  });

  it("should block redirect to gate-override.json", async () => {
    const result = await runHook(
      makeBashStdin(
        "test-session",
        "echo {} > .claude/coordination/gate-override.json",
      ),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/gate-override\.json/);
  });

  it("should block node -e writing to gate-override.json", async () => {
    const result = await runHook(
      makeBashStdin(
        "test-session",
        'node -e "fs.writeFileSync(\'gate-override.json\', data)"',
      ),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/gate-override\.json/);
  });

  it("should block touch gate-enforcement-disabled", async () => {
    const result = await runHook(
      makeBashStdin(
        "test-session",
        "touch .claude/coordination/gate-enforcement-disabled",
      ),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/gate-enforcement-disabled/);
  });

  it("should block sed -i on session.json", async () => {
    const result = await runHook(
      makeBashStdin(
        "test-session",
        "sed -i s/old/new/ .claude/context/session.json",
      ),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/session\.json/);
  });

  it("should block rm gate-override.json", async () => {
    const result = await runHook(
      makeBashStdin(
        "test-session",
        "rm .claude/coordination/gate-override.json",
      ),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/gate-override\.json/);
  });
});

// ============================================================
// Bash tool: Allows safe commands
// ============================================================

describe("Bash tool: Allows safe commands", () => {
  it("should allow commands with no protected files", async () => {
    const result = await runHook(makeBashStdin("test-session", "ls -la /tmp/"));
    expect(result.exitCode).toBe(0);
  });

  it("should allow cat of normal files", async () => {
    const result = await runHook(
      makeBashStdin("test-session", "cat .claude/scripts/workflow-dag.mjs"),
    );
    expect(result.exitCode).toBe(0);
  });

  it("should allow session-checkpoint.mjs CLI (the approved write path)", async () => {
    const result = await runHook(
      makeBashStdin(
        "test-session",
        "node .claude/scripts/session-checkpoint.mjs transition-phase implementing",
      ),
    );
    expect(result.exitCode).toBe(0);
  });

  it("should allow read-only cat of session.json (no redirect)", async () => {
    const result = await runHook(
      makeBashStdin("test-session", "cat .claude/context/session.json"),
    );
    expect(result.exitCode).toBe(0);
  });

  it("should allow grep on session.json", async () => {
    const result = await runHook(
      makeBashStdin(
        "test-session",
        "grep phase .claude/context/session.json",
      ),
    );
    expect(result.exitCode).toBe(0);
  });

  it("should allow jq on session.json", async () => {
    const result = await runHook(
      makeBashStdin("test-session", "jq .phase .claude/context/session.json"),
    );
    expect(result.exitCode).toBe(0);
  });

  it("should allow empty command (fail-open)", async () => {
    const result = await runHook(makeBashStdin("test-session", ""));
    expect(result.exitCode).toBe(0);
  });

  it("should allow git status (no protected files)", async () => {
    const result = await runHook(makeBashStdin("test-session", "git status"));
    expect(result.exitCode).toBe(0);
  });

  it("should fail-open on malformed input", async () => {
    const result = await runHook("not-json");
    expect(result.exitCode).toBe(0);
  });
});
