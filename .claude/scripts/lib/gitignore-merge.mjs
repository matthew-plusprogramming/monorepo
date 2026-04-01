import { readFileSync, existsSync } from 'node:fs';

export const GITIGNORE_BLOCK_BEGIN = '# metaclaude:begin (managed by metaclaude sync - do not edit)';
export const GITIGNORE_BLOCK_END = '# metaclaude:end';

/**
 * Merge gitignore entries using a comment-delimited managed block.
 *
 * Strategy:
 * 1. If no existing target .gitignore, create file with just the managed block
 * 2. If existing file with no metaclaude block, append block to end
 * 3. If existing file with metaclaude block, replace block contents wholesale
 *
 * Edge cases handled:
 * - Missing # metaclaude:end (malformed): replace from begin to EOF
 * - Target file without trailing newline: add separator newline before block
 * - Source content with trailing newline: strip to avoid double-newline
 * - CRLF line endings: preserve target file's line ending style
 *
 * @param {string} sourceContent - Content of gitignore-patch.txt (the managed entries)
 * @param {string} targetPath - Path to the target .gitignore file
 * @returns {{ merged: string, report: string[] }} Merged content and report messages
 */
export function mergeGitignore(sourceContent, targetPath) {
  const report = [];

  // Strip trailing newline from source to avoid double-newline in block
  const trimmedSource = sourceContent.replace(/\n$/, '');

  // Build the managed block
  const block = `${GITIGNORE_BLOCK_BEGIN}\n${trimmedSource}\n${GITIGNORE_BLOCK_END}`;

  // If target doesn't exist, create with just the block
  if (!existsSync(targetPath)) {
    report.push('No existing .gitignore, creating with metaclaude block');
    return { merged: block + '\n', report };
  }

  const targetContent = readFileSync(targetPath, 'utf-8');

  // Detect line ending style from target
  const usesCrlf = targetContent.includes('\r\n');
  const lineEnding = usesCrlf ? '\r\n' : '\n';

  const lines = targetContent.split(/\r?\n/);

  // Find the begin marker
  const beginIdx = lines.findIndex(line => line.trim() === GITIGNORE_BLOCK_BEGIN);

  if (beginIdx !== -1) {
    // Find the end marker
    const endIdx = lines.findIndex((line, i) => i > beginIdx && line.trim() === GITIGNORE_BLOCK_END);

    let beforeBlock = lines.slice(0, beginIdx);
    let afterBlock;

    if (endIdx !== -1) {
      // Normal case: replace everything between begin and end (inclusive)
      afterBlock = lines.slice(endIdx + 1);
      report.push('Replaced existing metaclaude block');
    } else {
      // Malformed: no end marker, replace from begin to EOF
      afterBlock = [];
      report.push('Warning: Found # metaclaude:begin without # metaclaude:end, replacing to end of file');
    }

    // Rebuild with new block
    const blockLines = block.split('\n');
    const merged = [...beforeBlock, ...blockLines, ...afterBlock].join(lineEnding);

    // Ensure trailing newline
    const finalContent = merged.endsWith(lineEnding) ? merged : merged + lineEnding;
    return { merged: finalContent, report };
  }

  // No existing block: append to end
  // Ensure there's a newline separator before the block
  let separator = '';
  if (targetContent.length > 0 && !targetContent.endsWith('\n') && !targetContent.endsWith('\r\n')) {
    separator = lineEnding;
  }

  // Add an extra blank line before the block for readability if the file has content
  if (targetContent.trim().length > 0) {
    separator += lineEnding;
  }

  const blockWithLineEndings = block.split('\n').join(lineEnding);
  const merged = targetContent + separator + blockWithLineEndings + lineEnding;

  report.push('Appended metaclaude block to .gitignore');
  return { merged, report };
}
