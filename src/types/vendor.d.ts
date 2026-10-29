declare module "hyperdht" {
  const value: unknown;
  export default value;
}

declare module "hypercore-crypto" {
  const value: {
    randomBytes(size: number): Buffer;
  };
  export default value;
}

declare module "fs-native-extensions" {
  export function tryLock(
    fd: number,
    offset?: number,
    length?: number,
    options?: { shared?: boolean },
  ): boolean;
  export function unlock(fd: number, offset?: number, length?: number): void;
}
