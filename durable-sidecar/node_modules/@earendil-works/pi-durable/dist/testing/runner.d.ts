import { type ExpectLike } from "./assertions.ts";
import type { StorageConformanceProvider } from "./types.ts";
export interface StorageConformanceRunner {
    readonly describe: (name: string, suite: () => void) => unknown;
    readonly expect: ExpectLike;
    readonly it: (name: string, test: () => Promise<void>) => unknown;
}
/** Registers the runner-independent cases with a Vitest/Jest-compatible test runner. */
export declare function registerStorageConformance(runner: StorageConformanceRunner, name: string, withStorage: StorageConformanceProvider): void;
//# sourceMappingURL=runner.d.ts.map