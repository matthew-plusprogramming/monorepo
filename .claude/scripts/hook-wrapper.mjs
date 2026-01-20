#!/usr/bin/env node

/**
 * Hook Wrapper Script
 *
 * Reads JSON from stdin (as provided by Claude Code hooks), extracts the file path,
 * checks if it matches a pattern, and runs the specified command if it does.
 *
 * Usage:
 *   hook-wrapper.mjs <pattern> <command>
 *
 * The command can use {{file}} as a placeholder for the file path.
 *
 * Examples:
 *   hook-wrapper.mjs "*.json" "echo {{file}}"
 *   hook-wrapper.mjs "*.ts" "node .claude/scripts/workspace-tsc.mjs {{file}}"
 *
 * Pattern syntax:
 *   - * matches any characters except /
 *   - ** matches any characters including /
 *   - Patterns can match anywhere in the path
 */

import { spawn } from 'child_process';

// Read all stdin
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Convert a single glob pattern to regex string
 */
function globToRegex(pattern) {
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches anything including /
        regexStr += '.*';
        i += 2;
      } else {
        // * matches anything except /
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      // ? matches any single character except /
      regexStr += '[^/]';
      i += 1;
    } else if ('.+^${}()|[]\\'.includes(char)) {
      // Escape regex special characters
      regexStr += '\\' + char;
      i += 1;
    } else {
      regexStr += char;
      i += 1;
    }
  }

  return regexStr;
}

/**
 * Simple glob pattern matching (no external dependencies)
 * Supports: *, **, literal characters, and comma-separated OR patterns
 *
 * Examples:
 *   - "*.ts" matches files ending in .ts
 *   - "*.ts,*.tsx" matches files ending in .ts OR .tsx
 *   - ".claude/**" matches any file under .claude/
 */
function matchesPattern(filePath, pattern) {
  // Support comma-separated patterns (OR logic)
  const patterns = pattern.split(',').map(p => p.trim());

  for (const p of patterns) {
    const regexStr = globToRegex(p);
    // Pattern can match:
    // 1. The entire path
    // 2. The end of the path (for patterns like *.json)
    // 3. A suffix after / (for patterns like .claude/agents/*.md)
    const regex = new RegExp('(^|/)' + regexStr + '$');
    if (regex.test(filePath)) {
      return true;
    }
  }

  return false;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: hook-wrapper.mjs <pattern> <command>');
    console.error('Example: hook-wrapper.mjs "*.json" "node validate.mjs {{file}}"');
    process.exit(1);
  }

  const pattern = args[0];
  const commandTemplate = args.slice(1).join(' ');

  // Read and parse stdin JSON
  let inputData;
  try {
    const stdinContent = await readStdin();
    if (!stdinContent.trim()) {
      // No stdin, exit silently (graceful degradation)
      process.exit(0);
    }
    inputData = JSON.parse(stdinContent);
  } catch (e) {
    // Invalid JSON or no input, exit silently
    process.exit(0);
  }

  // Extract file path from tool_input
  const toolInput = inputData.tool_input || {};
  const filePath = toolInput.file_path;

  if (!filePath) {
    // No file path in input, exit silently
    process.exit(0);
  }

  // Check if file matches pattern
  if (!matchesPattern(filePath, pattern)) {
    // File doesn't match pattern, exit silently
    process.exit(0);
  }

  // Replace {{file}} placeholder with actual file path
  const command = commandTemplate.replace(/\{\{file\}\}/g, filePath);

  // Execute the command via shell
  const child = spawn('sh', ['-c', command], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd()
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  child.on('close', (code) => {
    // Output results (limited to avoid flooding)
    const output = (stdout + stderr).trim();
    if (output) {
      const lines = output.split('\n').slice(0, 20);
      console.log(lines.join('\n'));
      if (output.split('\n').length > 20) {
        console.log('... (output truncated)');
      }
    }
    // Always exit 0 for graceful degradation (hooks shouldn't block)
    process.exit(0);
  });

  child.on('error', (err) => {
    // Silently handle errors (graceful degradation)
    process.exit(0);
  });
}

main();
