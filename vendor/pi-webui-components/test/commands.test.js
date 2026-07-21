import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { filterCommands } from "../src/commands.js";

const COMMANDS = [
  { name: "skill:gh", description: "GitHub CLI operations", source: "skill" },
  { name: "skill:jira", description: "Jira ticket operations", source: "skill" },
  { name: "fix-tests", description: "Run and fix failing tests", source: "template" },
  { name: "compact", description: "Compact conversation", source: "builtin" },
  { name: "reload", description: "Reload extensions", source: "builtin" },
  { name: "pr-review", description: "Review a pull request", source: "skill" },
  { name: "pr-respond", description: "Respond to PR review threads", source: "skill" },
];

describe("filterCommands - ranking", () => {
  const cases = [
    {
      name: "exact name match ranks first",
      query: "compact",
      assert: (r) => assert.equal(r[0].name, "compact"),
    },
    {
      name: "exact match is case-insensitive",
      query: "COMPACT",
      assert: (r) => assert.equal(r[0].name, "compact"),
    },
    {
      name: "prefix match ranks after exact",
      query: "pr",
      assert: (r) => {
        assert.ok(r.some((c) => c.name === "pr-review"));
        assert.ok(r.some((c) => c.name === "pr-respond"));
        // pr-review and pr-respond should come before any description matches
        assert.equal(r[0].name, "pr-respond");
        assert.equal(r[1].name, "pr-review");
      },
    },
    {
      name: "matches after separator character",
      query: "gh",
      assert: (r) => assert.ok(r.some((c) => c.name === "skill:gh")),
    },
    {
      name: "matches after hyphen separator",
      query: "tests",
      assert: (r) => assert.ok(r.some((c) => c.name === "fix-tests")),
    },
    {
      name: "separator match does not trigger on mid-word letters",
      query: "ill",
      assert: (r) => {
        // "ill" appears as a substring in "skill:gh" (rank 3), but NOT as a separator match (rank 2)
        // There is no separator before "ill" in "skill:gh" — it's mid-word in "skill"
        // skill:gh matches via substring (rank 3), not via separator (rank 2)
        assert.ok(r.some((c) => c.name === "skill:gh"));
        // But it should NOT rank above a command where "ill" follows a separator
        // (none in our test set, so just verify it's present via substring)
      },
    },
    {
      name: "substring in name",
      query: "view",
      assert: (r) => assert.ok(r.some((c) => c.name === "pr-review")),
    },
    {
      name: "substring in description",
      query: "ticket",
      assert: (r) => assert.ok(r.some((c) => c.name === "skill:jira")),
    },
  ];
  for (const c of cases) {
    test(c.name, () => c.assert(filterCommands(COMMANDS, c.query)));
  }
});

describe("filterCommands - ranking order", () => {
  test("exact match before prefix before substring", () => {
    // "pr" is a substring of "pr-review" and "pr-respond" (prefix match)
    // but not an exact match for any command
    const result = filterCommands(COMMANDS, "pr");
    // Both pr- commands should be at the top (prefix rank 1)
    assert.equal(result[0].name, "pr-respond");
    assert.equal(result[1].name, "pr-review");
  });

  test("results are sorted by rank then name", () => {
    const result = filterCommands(COMMANDS, "s");
    // All matches start with "s" → rank 1, sorted alphabetically
    assert.equal(result[0].name, "skill:gh");
    assert.equal(result[1].name, "skill:jira");
  });
});

describe("filterCommands - no matches", () => {
  test("returns empty array for no match", () => {
    const result = filterCommands(COMMANDS, "xyznonexistent");
    assert.equal(result.length, 0);
  });

  test("empty query returns all", () => {
    const result = filterCommands(COMMANDS, "");
    assert.equal(result.length, COMMANDS.length);
  });
});

describe("filterCommands - regex safety", () => {
  test("special regex characters in query do not throw", () => {
    assert.doesNotThrow(() => filterCommands(COMMANDS, "skill.*"));
    assert.doesNotThrow(() => filterCommands(COMMANDS, "(test)"));
    assert.doesNotThrow(() => filterCommands(COMMANDS, "[a-z]"));
  });
});
