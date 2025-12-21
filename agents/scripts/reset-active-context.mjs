#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const TASK_SPECS_DIR = "agents/specs/task-specs";

const USAGE = `Usage: node agents/scripts/reset-active-context.mjs --slug "<task-slug>" [options]

Create a new per-task spec (Requirements, Design, Implementation Planning, Execution).

Options
  --slug "<task-slug>"     Required slug used in the task spec filename
  --title "<text>"        Optional human-friendly title for the task
  --date "<YYYY-MM-DD>"   Override the review date (default: today UTC)
  -h, --help              Show this help message
`;

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
  console.log(USAGE.trimEnd());
  process.exit(0);
}

const options = {
  date: null,
  slug: null,
  title: null,
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];

  if (!arg.startsWith("--")) {
    console.error(`❌ Unexpected argument: ${arg}`);
    process.exit(1);
  }

  const [flag, inlineValue] = arg.split("=");
  const nextValue = args[index + 1];
  const value = inlineValue ?? nextValue;

  switch (flag) {
    case "--date": {
      if (!value) {
        console.error("❌ Missing value for --date");
        process.exit(1);
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        console.error("❌ --date must follow YYYY-MM-DD format");
        process.exit(1);
      }

      options.date = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    case "--slug": {
      if (!value) {
        console.error("❌ Missing value for --slug");
        process.exit(1);
      }

      if (!/^[a-z0-9-]+$/.test(value)) {
        console.error(
          "❌ --slug must use lowercase letters, numbers, or dashes only",
        );
        process.exit(1);
      }

      options.slug = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    case "--title": {
      if (!value) {
        console.error("❌ Missing value for --title");
        process.exit(1);
      }

      options.title = value;
      if (inlineValue === undefined) index += 1;
      break;
    }
    default:
      console.error(`❌ Unknown option: ${flag}`);
      process.exit(1);
  }
}

if (!options.slug) {
  console.error("❌ --slug is required");
  process.exit(1);
}

const formatDate = (inputDate) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(inputDate);

const toTitleCase = (value) =>
  value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const buildTaskSpecTemplate = ({ title, slug, date }) => `---
task: ${title}
slug: ${slug}
date: ${date}
status: draft
---

# ${title}

## Requirements
- [ ] EARS user stories and acceptance criteria captured.
- Non-goals:
- Constraints / Risks:
- Invariants:
- Interfaces / files / tests to touch:

## Design
- Architecture (logical, data, control flows):
- Sequence diagram(s):
\`\`\`mermaid
sequenceDiagram
  autonumber
  %% Fill in the primary flow
\`\`\`
- Interfaces / contracts:
- Edge / failure behaviors:

## Implementation Planning
- Tasks and outcomes:
- Dependencies / blockers:
- Test plan mapped to acceptance criteria:

## Execution
- Progress log:
- Evidence / tests:
- Follow-ups:
`;

const main = async () => {
  const reviewDate = options.date ?? formatDate(new Date());
  const title = options.title ?? toTitleCase(options.slug);
  const taskSpecFile = `${reviewDate}-${options.slug}.md`;
  const taskSpecPath = `${TASK_SPECS_DIR}/${taskSpecFile}`;

  const absoluteTaskSpecPath = resolve(process.cwd(), taskSpecPath);

  const taskSpecContent = buildTaskSpecTemplate({
    title,
    slug: options.slug,
    date: reviewDate,
  });

  await mkdir(dirname(absoluteTaskSpecPath), { recursive: true });

  const taskSpecExists = await access(absoluteTaskSpecPath)
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });

  if (!taskSpecExists) {
    await writeFile(absoluteTaskSpecPath, taskSpecContent, "utf8");
    console.log(`✅ Created task spec at ${taskSpecPath}`);
  } else {
    console.log(
      `ℹ️  Task spec already exists at ${taskSpecPath}; left unchanged.`,
    );
  }

  console.log(
    `ℹ️  Load context with: node agents/scripts/load-context.mjs --task ${taskSpecPath}`,
  );
};

main().catch((error) => {
  console.error("❌ Failed to create the task spec.");
  console.error(error);
  process.exit(1);
});
