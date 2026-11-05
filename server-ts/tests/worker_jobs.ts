// Functions src/lag.test.ts runs in worker threads (see src/worker.ts). Here, as releases carry src/ without its tests.
export function add(a: number, b: number) {
  return { sum: a + b };
}

export async function later(v: string) {
  await new Promise((r) => setTimeout(r, 10));
  return v;
}

export function fails() {
  throw new Error("outer", { cause: new Error("inner") });
}
