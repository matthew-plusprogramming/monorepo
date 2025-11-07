export const ensureDefined = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) {
    throw new Error(`${name} was not initialized`);
  }

  return value;
};
