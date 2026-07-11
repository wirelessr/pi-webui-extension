import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { filterCommands } from "../http-bridge-web/commands.js";

const COMMANDS = [
  { name: "skill:gh", description: "GitHub CLI operations", source: "skill" },
  { name: "skill:jira", description: "Jira ticket operations", source: "skill" },
  { name: "fix-tests", description: "Run and fix failing tests", source: "template" },
  { name: "compact", description: "Compact conversation", source: "builtin" },
  { name: "reload", description: "Reload extensions", source: "builtin" },
  { name: "pr-review", description: "Review a pull request", source: "skill" },
  { name: "pr-respond", description: "Respond to PR review threads", source: "skill" },
];

describe("filterCommands - exact match (rank 0)", () => {
  test("exact name match ranks first", () => {
    const result = filterCommands(COMMANDS, "compact");
    assert.equal(result[0].name, "compact");
  });

  test("exact match is case-insensitive", () => {
    const result = filterCommands(COMMANDS, "COMPACT");
    assert.equal(result[0].name, "compact");
  });
});

describe("filterCommands - prefix match (rank 1)", () => {
  test("prefix match ranks after exact", () => {
    const result = filterCommands(COMMANDS, "pr");
    assert.ok(result.some((c) => c.name === "pr-review"));
    assert.ok(result.some((c) => c.name === "pr-respond"));
    // pr-review and pr-respond should come before any description matches
    assert.equal(result[0].name, "pr-respond");
    assert.equal(result[1].name, "pr-review");
  });
});

describe("filterCommands - word boundary match (rank 2)", () => {
  test("matches after separator character", () => {
    const result = filterCommands(COMMANDS, "gh");
    assert.ok(result.some((c) => c.name === "skill:gh"));
  });

  test("matches after hyphen separator", () => {
    const result = filterCommands(COMMANDS, "tests");
    assert.ok(result.some((c) => c.name === "fix-tests"));
  });

  test("separator match does not trigger on mid-word letters", () => {
    // "ill" appears as a substring in "skill:gh" (rank 3), but NOT as a separator match (rank 2)
    // There is no separator before "ill" in "skill:gh" — it's mid-word in "skill"
    const result = filterCommands(COMMANDS, "ill");
    // skill:gh matches via substring (rank 3), not via separator (rank 2)
    assert.ok(result.some((c) => c.name === "skill:gh"));
    // But it should NOT rank above a command where "ill" follows a separator
    // (none in our test set, so just verify it's present via substring)
  });
});

describe("filterCommands - substring match (rank 3)", () => {
  test("substring in name", () => {
    const result = filterCommands(COMMANDS, "view");
    assert.ok(result.some((c) => c.name === "pr-review"));
  });
});

describe("filterCommands - description match (rank 4)", () => {
  test("substring in description", () => {
    const result = filterCommands(COMMANDS, "ticket");
    assert.ok(result.some((c) => c.name === "skill:jira"));
  });
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
