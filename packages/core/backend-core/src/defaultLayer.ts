import type { Layer } from 'effect';
import { Effect } from 'effect';

let defaultLayer: Layer.Layer<never, never, never> | null = null;

export const setDefaultLayer = (
  layer: Layer.Layer<never, never, never>,
): void => {
  defaultLayer = layer;
};

export const applyDefaultLayer = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, never> => {
  if (!defaultLayer) {
    throw new Error(
      'Default layer not set. Call setDefaultLayer(...) during app bootstrap.',
    );
  }
  return eff.pipe(Effect.provide(defaultLayer)) as Effect.Effect<A, E, never>;
};
