import type { Layer } from 'effect';
import { Effect } from 'effect';

let defaultLayer: Layer.Layer<never, never, never> | null = null;

export const setDefaultLayer = (layer: Layer.Layer<never, never, never>) => {
  defaultLayer = layer;
};

export const applyDefaultLayer = <A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, never> => {
  return defaultLayer
    ? (eff.pipe(Effect.provide(defaultLayer)) as Effect.Effect<A, E, never>)
    : (eff as unknown as Effect.Effect<A, E, never>);
};
