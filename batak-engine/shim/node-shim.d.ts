// Yalnizca BU ortamda derleme icin minimal shim.
// Gercek projede @types/node kurulur ve bu dosya silinir.
declare module "node:crypto" {
  interface Hash { update(d: string, e?: string): Hash; digest(enc: string): string;
    digest(): Buf; }
  interface Buf { readUInt32BE(o: number): number; toString(e: string): string; }
  export function createHash(alg: string): Hash;
  export function randomBytes(n: number): Buf;
}
declare module "node:test" {
  const t: (name: string, fn: () => void | Promise<void>) => void;
  export default t;
}
declare module "node:assert/strict" {
  const a: {
    equal(a: unknown, b: unknown, m?: string): void;
    notEqual(a: unknown, b: unknown, m?: string): void;
    deepEqual(a: unknown, b: unknown, m?: string): void;
    notDeepEqual(a: unknown, b: unknown, m?: string): void;
    ok(v: unknown, m?: string): void;
  };
  export default a;
}
