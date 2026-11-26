import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

// Vitest preset rules switched off for this project. They are switched off inside the
// preset's overrides because a later override or a top-level entry cannot switch off a rule the
// preset enables in its own override.
const disabledVitestRules = new Set([
  // Test files group tests without a top-level describe (106 findings).
  "vitest/require-top-level-describe",
  // toBe(true) / toBe(false) states the exact value and keeps the assertions strict (86 + 12).
  "vitest/prefer-to-be-truthy",
  "vitest/prefer-to-be-falsy",
  // toEqual vs toStrictEqual would change what the ported tests assert (44).
  "vitest/prefer-strict-equal",
  // Table-style tests assert several fields per test (18).
  "vitest/max-expects",
  // test and it are both used (18).
  "vitest/consistent-test-it",
  // Mock type parameters would need type changes across the tests (10).
  "vitest/require-mock-type-parameters",
  // vi.mock(import(...)) autofix breaks the partial mock typing.
  "vitest/prefer-import-in-mock",
]);

const vitestOverrides = vitest.overrides.map((override) => ({
  ...override,
  rules: Object.fromEntries(
    Object.entries(override.rules).map(([rule, level]) => [
      rule,
      disabledVitestRules.has(rule) ? "off" : level,
    ])
  ),
}));

export default defineConfig({
  extends: [core],
  overrides: vitestOverrides,
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ".claude",
    "**/*.md",
    ".github",
  ],
  rules: {
    // Database calls on one connection are sequential by design.
    "no-await-in-loop": "off",
    // Methods are overridden or replaced per instance.
    "class-methods-use-this": "off",
    // Modules group related classes.
    "max-classes-per-file": "off",

    // The rules below would need restructuring or change semantics to satisfy.
    // Function declarations and expressions are mixed deliberately (217 findings).
    "func-style": "off",
    // Trailing explanatory comments are used throughout (86).
    "no-inline-comments": "off",
    // The pg CommonJS default export is used as a namespace (7).
    "import/no-named-as-default-member": "off",
    // Helpers are declared after use in modules ordered by importance (7).
    "no-use-before-define": "off",
    // Array#sort/reverse mutation is intended and arrays are local (5 + 2).
    "unicorn/no-array-sort": "off",
    "unicorn/no-array-reverse": "off",
    // Promise constructors and callbacks wrap node APIs and timers (5 + 5 + 1).
    "promise/avoid-new": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-catch": "off",
    // Small readability preferences that would need code rewrites (1-4 findings each).
    "unicorn/no-await-expression-member": "off",
    "unicorn/prefer-number-coercion": "off",
    "unicorn/prefer-math-trunc": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/prefer-add-event-listener": "off",
    "unicorn/import-style": "off",
    "unicorn/prefer-ternary": "off",
    "unicorn/prefer-native-coercion-functions": "off",
    "unicorn/no-array-reduce": "off",
    "unicorn/custom-error-definition": "off",
    "unicorn/no-unreadable-array-destructuring": "off",
    // The autofix turns deliberate Error throws into TypeError, which changes the error class.
    "unicorn/prefer-type-error": "off",
    // Ported upstream TODO comments are kept (2).
    "no-warning-comments": "off",
    // Type and value share the AccessMode name on purpose (1).
    "no-redeclare": "off",
    // Generators are internal and documented in prose (2).
    "jsdoc/require-yields": "off",
  },
});
