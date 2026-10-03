// Minimal typing for the Node APIs used by tests (the project doesn't depend on @types/node).
declare module 'node:fs' {
  export function readFileSync(path: string | URL): Uint8Array<ArrayBuffer>;
}
