// Yalnizca BU ortamda derleme icin minimal shim.
// Gercek projede @types/node kurulur ve bu dosya silinir.
declare module "node:crypto" {
  interface Hash { update(d: string, e?: string): Hash; digest(enc: string): string;
    digest(): Buf; }
  interface Buf { readUInt32BE(o: number): number; toString(e: string): string; }
  export function createHash(alg: string): Hash;
  export function createHmac(alg: string, key: string): Hash;
  export function randomBytes(n: number): Buf;
  export function randomUUID(): string;
  export function timingSafeEqual(a: unknown, b: unknown): boolean;
  export function scrypt(...a: unknown[]): void;
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

declare module "node:buffer" { }
declare const Buffer: {
  from(s: string, enc?: string): { length: number; toString(e?: string): string };
  concat(a: unknown[]): { toString(e: string): string };
};
declare module "@muhabbetly/batak-engine" {
  export type Seat = 0 | 1 | 2 | 3;
  export type Suit = 0 | 1 | 2 | 3;
  export type Move = any;
}
declare function fetch(...a: unknown[]): Promise<any>;
declare class AbortController { signal: unknown; abort(): void }
declare function setTimeout(fn: () => void, ms: number): any;
declare function clearTimeout(t: unknown): void;
declare const Date: any;
declare const Math: any;
declare const JSON: any;
declare const Number: any;
declare const Map: any;
declare const Set: any;
declare const Error: any;
declare const String: any;

declare module "@muhabbetly/batak-engine" {
  export type Seat = 0 | 1 | 2 | 3;
  export type Suit = 0 | 1 | 2 | 3;
  export type Move = any;
  export type TableState = any;
  export type TableInput = any;
  export type TableEvent = any;
  export type StepResult = any;
  export type Effect = any;
  export type RuntimeConfig = any;
  export function createTable(o: any): any;
  export function step(s: any, i: any): any;
  export function viewFor(s: any, seat: any): any;
  export function defaultConfig(): any;
  export function merge(a: any, b: any): any;
  export function validate(a: any): any[];
}
declare namespace NodeJS { type Timeout = any }
declare const Buffer: any;
type Buffer = any;
declare const console: any;
declare const process: any;

declare module "pg" { export type Pool = any; const d: any; export default d; }

declare module "node:util" { export function promisify(f: unknown): any; }
declare module "jose" { export class SignJWT { constructor(p?: any); setProtectedHeader(a: any): this; setSubject(a: any): this; setIssuer(a: any): this; setAudience(a: any): this; setIssuedAt(): this; setExpirationTime(a: any): this; sign(k: any): Promise<string>; }
  export function jwtVerify(...a: any[]): Promise<any>;
  export function importSPKI(...a: any[]): Promise<any>;
  export type KeyLike = any;
}
declare const TextEncoder: any;
