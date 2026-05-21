/**
 * Tests for the active shared DAG module.
 *
 * Run with: npx vitest run --config .claude/scripts/vitest.config.mjs workflow-dag
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MODULE_PATH = join(__dirname, '..', 'lib', 'workflow-dag.mjs');

async function loadModule() {
  const url = new URL(`file://${MODULE_PATH}`);
  return await import(url.href);
}

function hasConvergencePrereq(prereqs, gate) {
  return prereqs.some((p) => p?.type === 'convergence' && p?.gate === gate);
}

describe('workflow-dag active exports', () => {
  it('exports oneoff-spec predecessor graph and active workflow enums', async () => {
    const mod = await loadModule();

    expect(mod.ONEOFF_SPEC_PREDECESSORS).toBeDefined();
    expect(mod.VALID_WORKFLOWS).toEqual([
      'oneoff-vibe',
      'oneoff-spec',
      'refactor',
      'journal-only',
    ]);
    expect(mod.VALID_PHASES).not.toContain('atomizing');
    expect(mod.VALID_PHASES).not.toContain('enforcing');
    expect(mod.VALID_SUBSTAGES).toEqual(['pre-impl']);
  });

  it('defaults missing workflow to oneoff-spec', async () => {
    const mod = await loadModule();

    expect(mod.getWorkflowType({ active_work: {} })).toBe('oneoff-spec');
    expect(mod.getWorkflowType({})).toBe('oneoff-spec');
    expect(mod.getWorkflowTypeStrict({ active_work: {} })).toBeNull();
  });

  it('returns null predecessor graph for exempt workflows', async () => {
    const mod = await loadModule();

    for (const workflow of ['oneoff-vibe', 'refactor', 'journal-only']) {
      expect(mod.isExemptWorkflow(workflow)).toBe(true);
      expect(mod.getPredecessorGraph(workflow)).toBeNull();
    }
    expect(mod.getPredecessorGraph('oneoff-spec')).toBe(mod.ONEOFF_SPEC_PREDECESSORS);
  });
});

describe('workflow-dag prerequisites', () => {
  it('requires investigation and challenger convergence before implementer', async () => {
    const mod = await loadModule();
    const prereqs = mod.getPrerequisites('oneoff-spec', 'implementer');

    expect(hasConvergencePrereq(prereqs, 'investigation')).toBe(true);
    expect(hasConvergencePrereq(prereqs, 'challenger')).toBe(true);
  });

  it('keeps test-writer and e2e-test-writer free of ordering prerequisites', async () => {
    const mod = await loadModule();

    expect(mod.getPrerequisites('oneoff-spec', 'test-writer')).toEqual([]);
    expect(mod.getPrerequisites('oneoff-spec', 'e2e-test-writer')).toEqual([]);
  });

  it('requires unifier dispatch before reviewers', async () => {
    const mod = await loadModule();

    expect(mod.getPrerequisites('oneoff-spec', 'code-reviewer')).toContainEqual(
      expect.objectContaining({ type: 'dispatch', subagent_type: 'unifier' })
    );
    expect(mod.getPrerequisites('oneoff-spec', 'security-reviewer')).toContainEqual(
      expect.objectContaining({ type: 'dispatch', subagent_type: 'unifier' })
    );
  });

  it('checks convergence counts for prerequisite satisfaction', async () => {
    const mod = await loadModule();
    const prereqs = mod.getPrerequisites('oneoff-spec', 'implementer');

    expect(mod.werePrerequisitesMet({
      subagent_tasks: { in_flight: [], completed_this_session: [] },
      history: [],
      convergence: {
        investigation: { clean_pass_count: 2 },
        challenger: { clean_pass_count: 2 },
      },
    }, prereqs)).toEqual({ met: true, missing: [] });

    expect(mod.werePrerequisitesMet({
      subagent_tasks: { in_flight: [], completed_this_session: [] },
      history: [],
      convergence: {
        investigation: { clean_pass_count: 2 },
        challenger: { clean_pass_count: 1 },
      },
    }, prereqs).met).toBe(false);
  });
});

describe('workflow-dag predecessor visitation', () => {
  it('matches challenger predecessor keys by stage', async () => {
    const mod = await loadModule();
    const session = {
      subagent_tasks: {
        in_flight: [],
        completed_this_session: [
          { subagent_type: 'challenger', stage: 'pre-implementation', status: 'completed' },
        ],
      },
      history: [],
    };

    expect(mod.wasPredecessorVisited('challenging:pre-implementation', session)).toBe(true);
    expect(mod.wasPredecessorVisited('challenging:pre-test', session)).toBe(false);
  });

  it('matches plain predecessor keys from phase-transition history', async () => {
    const mod = await loadModule();
    const session = {
      subagent_tasks: { in_flight: [], completed_this_session: [] },
      history: [
        { event_type: 'phase_transition', details: { to_phase: 'spec_authoring' } },
      ],
    };

    expect(mod.wasPredecessorVisited('spec_authoring', session)).toBe(true);
    expect(mod.wasPredecessorVisited('implementing', session)).toBe(false);
  });
});
