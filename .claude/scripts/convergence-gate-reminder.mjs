#!/usr/bin/env node

/**
 * SubagentStop hook: Convergence Gate Reminder
 *
 * Reads SubagentStop event data from stdin and, based on the agent type,
 * outputs a JSON object with `additionalContext` reminding the main agent
 * to update the relevant convergence gate in the spec group manifest.
 *
 * Agent type -> convergence gate mapping:
 *   implementer       -> all_acs_implemented
 *   test-writer       -> all_tests_passing
 *   unifier           -> unifier_passed
 *   code-reviewer     -> code_review_passed
 *   security-reviewer -> security_review_passed
 *   browser-tester    -> browser_tests_passed
 *   documenter        -> docs_generated
 *
 * For any other agent type, outputs empty JSON ({}).
 *
 * Usage (via SubagentStop hook):
 *   echo '{"agent_type":"implementer"}' | node convergence-gate-reminder.mjs
 *
 * Exit codes:
 *   0 - Always (hooks must not block)
 *
 * Implements: REQ-1, AC1.1-AC1.10 from as-001-subagent-stop-hook
 */

const GATE_MAP = {
  implementer: {
    field: 'all_acs_implemented',
    label: 'implementer',
  },
  'test-writer': {
    field: 'all_tests_passing',
    label: 'test-writer',
  },
  unifier: {
    field: 'unifier_passed',
    label: 'unifier',
  },
  'code-reviewer': {
    field: 'code_review_passed',
    label: 'code-reviewer',
  },
  'security-reviewer': {
    field: 'security_review_passed',
    label: 'security-reviewer',
  },
  'browser-tester': {
    field: 'browser_tests_passed',
    label: 'browser-tester',
  },
  documenter: {
    field: 'docs_generated',
    label: 'documenter',
  },
};

// AC1.10: All 8 canonical convergence gate fields (DEC-002).
// GATE_MAP has 7 entries because spec_complete has no corresponding subagent
// (it is set by the spec-authoring workflow, not by a SubagentStop event).
const CANONICAL_FIELDS = [
  'spec_complete',
  'all_acs_implemented',
  'all_tests_passing',
  'unifier_passed',
  'code_review_passed',
  'security_review_passed',
  'browser_tests_passed',
  'docs_generated',
];

function buildReminder(agentType) {
  const gate = GATE_MAP[agentType];
  if (!gate) {
    return null;
  }

  return (
    `CONVERGENCE GATE REMINDER: The ${gate.label} subagent just completed. ` +
    `You should now update the spec group manifest's convergence object to set "${gate.field}": true. ` +
    `Find the active spec group manifest at .claude/specs/groups/<spec-group-id>/manifest.json and update the convergence object. ` +
    `The 8 canonical gate fields are: ${CANONICAL_FIELDS.join(', ')}.`
  );
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', (chunk) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      resolve(data);
    });

    // If stdin is not piped / empty, resolve after a short timeout
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

async function main() {
  try {
    const raw = await readStdin();

    if (!raw || !raw.trim()) {
      console.log('{}');
      process.exit(0);
    }

    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      // AC1.6: Malformed JSON -- no reminder
      console.log('{}');
      process.exit(0);
    }

    // AC1.2: Extract agent_type field (DEC-001)
    const agentType = input.agent_type || '';
    const reminder = buildReminder(agentType);

    if (reminder) {
      // AC1.4: Output additionalContext for mapped subagent types
      console.log(JSON.stringify({ additionalContext: reminder }));
    } else {
      // AC1.5: Output {} for unmapped subagent types
      console.log('{}');
    }
  } catch {
    // AC1.7: Any unexpected error -- output empty JSON and exit cleanly
    console.log('{}');
  }

  process.exit(0);
}

main();
