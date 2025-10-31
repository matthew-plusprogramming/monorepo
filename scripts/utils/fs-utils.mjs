import { spawnSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, relative } from 'node:path';

export const ensureDir = async (targetDir) => {
  await mkdir(targetDir, { recursive: true });
};

export const fileExists = async (filePath) => {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

export const replaceTokens = (template, tokens) => {
  let output = template;
  for (const [token, value] of Object.entries(tokens)) {
    const pattern = new RegExp(token, 'g');
    output = output.replace(pattern, value);
  }
  return output;
};

export const writeFileSafely = async (
  targetPath,
  content,
  { dryRun, force, cwd } = {},
) => {
  const exists = await fileExists(targetPath);
  if (exists && !force) {
    const displayPath = cwd ? relative(cwd, targetPath) : targetPath;
    throw new Error(
      `Refusing to overwrite existing file without --force: ${displayPath}`,
    );
  }

  if (dryRun) {
    return { action: exists ? 'would-overwrite' : 'would-create', skipped: true };
  }

  await ensureDir(dirname(targetPath));
  await writeFile(targetPath, content);
  return {
    action: exists ? 'overwritten' : 'created',
    skipped: false,
  };
};

export const runCommand = (command, args, { cwd, dryRun } = {}) => {
  if (dryRun) {
    return { status: 'skipped', code: 0 };
  }

  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with status ${result.status}`,
    );
  }

  return { status: 'executed', code: result.status };
};

