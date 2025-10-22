export const hoistUnbundledRuntime = (): void => {
  Reflect.set(globalThis, '__BUNDLED__', false);
};

export const hoistBundledRuntime = (): void => {
  Reflect.set(globalThis, '__BUNDLED__', true);
};

export const setBundledRuntime = (value: boolean): void => {
  Reflect.set(globalThis, '__BUNDLED__', value);
};

export const clearBundledRuntime = (): void => {
  Reflect.deleteProperty(globalThis, '__BUNDLED__');
};
