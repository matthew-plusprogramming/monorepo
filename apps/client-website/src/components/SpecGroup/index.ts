/**
 * SpecGroup Components Module (AS-008)
 *
 * Exports components for displaying spec group convergence gates and
 * state transitions.
 */

// Components
export { ConvergenceGates, type ConvergenceGatesProps } from './ConvergenceGates';
export { GateItem, type GateItemProps } from './GateItem';
export {
  StateTransitionButtons,
  type AvailableTransition,
  type StateTransitionButtonsProps,
} from './StateTransitionButtons';

// Hooks
export {
  useConvergenceGates,
  type UseConvergenceGatesConfig,
  type UseConvergenceGatesResult,
} from './useConvergenceGates';

// Types
export {
  checkAllGatesPassed,
  createDefaultGates,
  GATE_DISPLAY_CONFIG,
  GATE_ORDER,
  type ConvergenceGateState,
  type Gate,
  type GateDetail,
  type GateDisplayConfig,
  type GateId,
  type GateStatus,
} from './types';
