// General
export const exists = (value: unknown) =>
  value !== null && typeof value !== 'undefined';

// TTL
export const secondsFromNowTimestamp = (seconds: number) =>
  Math.floor(Date.now() / 1000) + seconds;
export const isTTLExpiredSeconds = (ttl: number) => {
  const now = Math.floor(Date.now() / 1000);
  return now > ttl;
};
