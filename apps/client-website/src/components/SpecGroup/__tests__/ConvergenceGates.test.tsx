/**
 * ConvergenceGates Component Tests (AS-008)
 *
 * Tests for the convergence gate checklist display.
 * Covers AC8.1, AC8.2, AC8.3, AC8.4, AC8.5, AC8.6.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConvergenceGates } from '../ConvergenceGates';
import { GateItem } from '../GateItem';
import { StateTransitionButtons } from '../StateTransitionButtons';
import type { Gate, GateStatus } from '../types';
import { checkAllGatesPassed, createDefaultGates, GATE_ORDER } from '../types';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

/**
 * Helper to create a gate with specific status.
 */
const createGate = (
  id: Gate['id'],
  status: GateStatus,
  details?: Gate['details'],
): Gate => ({
  id,
  status,
  details,
  updatedAt: new Date().toISOString(),
});

/**
 * Helper to create mock gate response.
 */
const createGateResponse = (gates: Gate[]) => ({
  specGroupId: 'test-spec-group',
  gates,
  allGatesPassed: checkAllGatesPassed(gates),
  updatedAt: new Date().toISOString(),
});

describe('GateItem', () => {
  const defaultGate = createGate('spec_complete', 'pending');

  it('renders gate with correct label and description (AC8.1)', () => {
    render(
      <GateItem gate={defaultGate} isExpanded={false} onToggle={vi.fn()} />,
    );

    expect(screen.getByText('Spec complete')).toBeInTheDocument();
    expect(
      screen.getByText('All specification sections are filled out and approved'),
    ).toBeInTheDocument();
  });

  it('renders passed status with green check icon (AC8.2)', () => {
    const gate = createGate('spec_complete', 'passed');
    render(<GateItem gate={gate} isExpanded={false} onToggle={vi.fn()} />);

    const statusIcon = screen.getByRole('img', { name: 'Passed' });
    expect(statusIcon).toBeInTheDocument();
  });

  it('renders failed status with red X icon (AC8.2)', () => {
    const gate = createGate('tests_passing', 'failed');
    render(<GateItem gate={gate} isExpanded={false} onToggle={vi.fn()} />);

    const statusIcon = screen.getByRole('img', { name: 'Failed' });
    expect(statusIcon).toBeInTheDocument();
  });

  it('renders pending status with gray circle icon (AC8.2)', () => {
    const gate = createGate('code_review', 'pending');
    render(<GateItem gate={gate} isExpanded={false} onToggle={vi.fn()} />);

    const statusIcon = screen.getByRole('img', { name: 'Pending' });
    expect(statusIcon).toBeInTheDocument();
  });

  it('renders N/A status with dash icon (AC8.2)', () => {
    const gate = createGate('browser_tests', 'na');
    render(<GateItem gate={gate} isExpanded={false} onToggle={vi.fn()} />);

    const statusIcon = screen.getByRole('img', { name: 'Not applicable' });
    expect(statusIcon).toBeInTheDocument();
  });

  it('shows details when expanded (AC8.5)', async () => {
    const gate = createGate('tests_passing', 'failed', [
      {
        type: 'test_failure',
        message: 'Test "should render correctly" failed',
        location: 'src/components/Button.test.tsx:42',
        severity: 'error',
      },
    ]);

    render(<GateItem gate={gate} isExpanded={true} onToggle={vi.fn()} />);

    expect(
      screen.getByText('Test "should render correctly" failed'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('src/components/Button.test.tsx:42'),
    ).toBeInTheDocument();
  });

  it('calls onToggle when clicked (AC8.5)', async () => {
    const onToggle = vi.fn();
    const gate = createGate('tests_passing', 'failed');
    const user = userEvent.setup();

    render(<GateItem gate={gate} isExpanded={false} onToggle={onToggle} />);

    await user.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('is not clickable when passed without details', () => {
    const gate = createGate('spec_complete', 'passed');
    render(<GateItem gate={gate} isExpanded={false} onToggle={vi.fn()} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ConvergenceGates', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('displays all gates in checklist format (AC8.1, AC8.3)', async () => {
    const gates = GATE_ORDER.map((id) => createGate(id, 'pending'));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => createGateResponse(gates),
    });

    render(<ConvergenceGates specGroupId="test-spec-group" pollingInterval={60000} />);

    await waitFor(() => {
      expect(screen.getByText('Spec complete')).toBeInTheDocument();
    });

    // Verify all 8 gates are displayed (AC8.3)
    expect(screen.getByText('Spec complete')).toBeInTheDocument();
    expect(screen.getByText('ACs implemented')).toBeInTheDocument();
    expect(screen.getByText('Tests passing')).toBeInTheDocument();
    expect(screen.getByText('Unifier')).toBeInTheDocument();
    expect(screen.getByText('Code review')).toBeInTheDocument();
    expect(screen.getByText('Security review')).toBeInTheDocument();
    expect(screen.getByText('Browser tests')).toBeInTheDocument();
    expect(screen.getByText('Docs')).toBeInTheDocument();
  });

  it('shows loading state while fetching', () => {
    mockFetch.mockImplementation(
      () => new Promise(() => {}), // Never resolves
    );

    render(<ConvergenceGates specGroupId="test-spec-group" pollingInterval={60000} />);

    // Should show skeletons (8 of them for each gate)
    const skeletons = document.querySelectorAll('[class*="gateItemSkeleton"]');
    expect(skeletons.length).toBe(8);
  });

  it('shows error state and retry button on failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    render(<ConvergenceGates specGroupId="test-spec-group" pollingInterval={60000} />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load gates/)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('polls for updates automatically (AC8.4)', async () => {
    vi.useFakeTimers();
    const gates = GATE_ORDER.map((id) => createGate(id, 'pending'));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => createGateResponse(gates),
    });

    render(
      <ConvergenceGates specGroupId="test-spec-group" pollingInterval={5000} />,
    );

    // Wait for initial fetch by advancing timers and flushing promises
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance timer to trigger polling
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    // Should have polled again
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('shows summary badge with passed count', async () => {
    const gates = [
      createGate('spec_complete', 'passed'),
      createGate('acs_implemented', 'passed'),
      createGate('tests_passing', 'pending'),
      createGate('unifier', 'pending'),
      createGate('code_review', 'pending'),
      createGate('security_review', 'pending'),
      createGate('browser_tests', 'na'),
      createGate('docs', 'pending'),
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => createGateResponse(gates),
    });

    render(<ConvergenceGates specGroupId="test-spec-group" pollingInterval={60000} />);

    await waitFor(() => {
      expect(screen.getByText('2/7 gates passed')).toBeInTheDocument();
    });
  });

  it('shows "All gates passed" when complete', async () => {
    const gates = GATE_ORDER.map((id) =>
      id === 'browser_tests' ? createGate(id, 'na') : createGate(id, 'passed'),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...createGateResponse(gates),
        allGatesPassed: true,
      }),
    });

    render(<ConvergenceGates specGroupId="test-spec-group" pollingInterval={60000} />);

    await waitFor(() => {
      expect(screen.getByText('All gates passed')).toBeInTheDocument();
    });
  });
});

describe('StateTransitionButtons', () => {
  const defaultTransitions = [
    {
      toState: 'CONVERGED',
      description: 'Mark implementation as converged',
      enabled: true,
    },
  ];

  it('renders transition buttons', () => {
    const gates = createDefaultGates();
    render(
      <StateTransitionButtons
        availableTransitions={defaultTransitions}
        currentState="IN_PROGRESS"
        gates={gates}
        onTransition={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /CONVERGED/i })).toBeInTheDocument();
    expect(
      screen.getByText('Mark implementation as converged'),
    ).toBeInTheDocument();
  });

  it('disables transition button when gates not passed (AC8.6)', () => {
    const gates = createDefaultGates(); // All pending
    render(
      <StateTransitionButtons
        availableTransitions={defaultTransitions}
        currentState="IN_PROGRESS"
        gates={gates}
        onTransition={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: /CONVERGED/i });
    expect(button).toBeDisabled();
  });

  it('enables transition button when all gates pass (AC8.6)', () => {
    const gates = GATE_ORDER.map((id) => createGate(id, 'passed'));
    render(
      <StateTransitionButtons
        availableTransitions={defaultTransitions}
        currentState="IN_PROGRESS"
        gates={gates}
        onTransition={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: /CONVERGED/i });
    expect(button).not.toBeDisabled();
  });

  it('enables transition when gates include N/A status (AC8.6)', () => {
    const gates = GATE_ORDER.map((id) =>
      id === 'browser_tests' ? createGate(id, 'na') : createGate(id, 'passed'),
    );
    render(
      <StateTransitionButtons
        availableTransitions={defaultTransitions}
        currentState="IN_PROGRESS"
        gates={gates}
        onTransition={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: /CONVERGED/i });
    expect(button).not.toBeDisabled();
  });

  it('shows tooltip when button is disabled (AC8.6)', async () => {
    const gates = createDefaultGates(); // All pending
    render(
      <StateTransitionButtons
        availableTransitions={defaultTransitions}
        currentState="IN_PROGRESS"
        gates={gates}
        onTransition={vi.fn()}
      />,
    );

    // Tooltip should be in the document (hidden by CSS initially)
    expect(
      screen.getByText('All convergence gates must pass before this transition'),
    ).toBeInTheDocument();
  });

  it('calls onTransition when enabled button clicked', async () => {
    const gates = GATE_ORDER.map((id) => createGate(id, 'passed'));
    const onTransition = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <StateTransitionButtons
        availableTransitions={defaultTransitions}
        currentState="IN_PROGRESS"
        gates={gates}
        onTransition={onTransition}
      />,
    );

    await user.click(screen.getByRole('button', { name: /CONVERGED/i }));
    expect(onTransition).toHaveBeenCalledWith('CONVERGED');
  });

  it('does not render when no transitions available', () => {
    const gates = createDefaultGates();
    const { container } = render(
      <StateTransitionButtons
        availableTransitions={[]}
        currentState="MERGED"
        gates={gates}
        onTransition={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});

describe('types and utilities', () => {
  it('checkAllGatesPassed returns true when all gates passed', () => {
    const gates = GATE_ORDER.map((id) => createGate(id, 'passed'));
    expect(checkAllGatesPassed(gates)).toBe(true);
  });

  it('checkAllGatesPassed returns true when gates are passed or N/A', () => {
    const gates = GATE_ORDER.map((id) =>
      id === 'browser_tests' ? createGate(id, 'na') : createGate(id, 'passed'),
    );
    expect(checkAllGatesPassed(gates)).toBe(true);
  });

  it('checkAllGatesPassed returns false when any gate is pending', () => {
    const gates = GATE_ORDER.map((id, index) =>
      index === 0 ? createGate(id, 'pending') : createGate(id, 'passed'),
    );
    expect(checkAllGatesPassed(gates)).toBe(false);
  });

  it('checkAllGatesPassed returns false when any gate is failed', () => {
    const gates = GATE_ORDER.map((id, index) =>
      index === 0 ? createGate(id, 'failed') : createGate(id, 'passed'),
    );
    expect(checkAllGatesPassed(gates)).toBe(false);
  });

  it('createDefaultGates creates all gates with pending status', () => {
    const gates = createDefaultGates();
    expect(gates.length).toBe(8);
    gates.forEach((gate) => {
      expect(gate.status).toBe('pending');
    });
  });

  it('GATE_ORDER contains all required gates (AC8.3)', () => {
    expect(GATE_ORDER).toContain('spec_complete');
    expect(GATE_ORDER).toContain('acs_implemented');
    expect(GATE_ORDER).toContain('tests_passing');
    expect(GATE_ORDER).toContain('unifier');
    expect(GATE_ORDER).toContain('code_review');
    expect(GATE_ORDER).toContain('security_review');
    expect(GATE_ORDER).toContain('browser_tests');
    expect(GATE_ORDER).toContain('docs');
  });
});
