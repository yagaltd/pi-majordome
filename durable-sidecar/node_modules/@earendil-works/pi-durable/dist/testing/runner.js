import { createExpectAssertions } from "./assertions.js";
import { createStorageConformance } from "./storage-conformance.js";
/** Registers the runner-independent cases with a Vitest/Jest-compatible test runner. */
export function registerStorageConformance(runner, name, withStorage) {
    const cases = createStorageConformance({
        assertions: createExpectAssertions(runner.expect),
        withStorage,
    });
    runner.describe(name, () => {
        for (const testCase of cases)
            runner.it(testCase.name, testCase.run);
    });
}
//# sourceMappingURL=runner.js.map