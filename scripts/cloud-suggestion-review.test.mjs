import assert from "node:assert/strict";
import test from "node:test";
import {
  decide,
  sourceMatches,
  resultBody,
  commitAllowed,
  selectNumbers,
  changedPaths,
  liveMatches,
  recoveryHold,
} from "./cloud-suggestion-review.mjs";

const source = {
  name: "Example",
  source: "https://github.com/example/tool",
  id: 123,
  ownerId: 45,
  fullName: "example/tool",
  branch: "main",
  commit: "a".repeat(40),
  readmeSha: "b".repeat(40),
  licenseSha: "c".repeat(40),
  license: "MIT",
  summaries: { en: "A code formatter." },
  review: {
    decision: "accepted-static-project-profile-only",
    category: "software-development-tool",
    political: false,
    highRisk: false,
    privatePerson: false,
    uncertain: false,
  },
};
const facts = {
  repo: {
    id: 123,
    owner: { id: 45 },
    full_name: "example/tool",
    default_branch: "main",
    private: false,
    archived: false,
    disabled: false,
    fork: false,
    license: { spdx_id: "MIT" },
  },
  commit: { sha: "a".repeat(40) },
  readme: { sha: "b".repeat(40) },
  license: { sha: "c".repeat(40) },
};
const input = {
  number: 6,
  version: "d".repeat(64),
  name: "Example",
  sourceUrl: source.source,
  locale: "en",
  noneOfTheseConfirmed: true,
};
test("unpublished acceptance cannot recover under a changed policy or new risk flags", () => {
  const record = { policy: "old-policy" };
  assert.equal(recoveryHold(record, "old-policy", source, facts), null);
  const risky = structuredClone(source);
  risky.review.highRisk = true;
  assert.equal(recoveryHold(record, "new-policy", risky, facts), "source-changed");
  assert.equal(recoveryHold(record, "new-policy", source, facts), "source-changed");
  assert.equal(recoveryHold(record, "old-policy", risky, facts), "source-changed");
  assert.equal(recoveryHold(record, "old-policy", undefined, facts), "source-changed");
  assert.equal(recoveryHold(record, "old-policy", source, null), "source-unavailable");
  assert.equal(recoveryHold(record, "new-policy", source, null), "source-changed");
});
test("only exact reviewed identity and snapshot can pass", () => {
  assert.equal(sourceMatches(source, facts), true);
  for (const mutate of [
    (x) => x.repo.id++,
    (x) => x.repo.owner.id++,
    (x) => (x.repo.full_name = "other/tool"),
    (x) => (x.repo.default_branch = "unreviewed"),
    (x) => (x.repo.archived = true),
    (x) => (x.repo.fork = true),
    (x) => (x.repo.private = true),
    (x) => (x.repo.disabled = true),
    (x) => (x.repo.license.spdx_id = "UNKNOWN"),
    (x) => (x.commit.sha = "e".repeat(40)),
    (x) => (x.readme.sha = "e".repeat(40)),
    (x) => (x.license.sha = "e".repeat(40)),
  ]) {
    const changed = structuredClone(facts);
    mutate(changed);
    assert.equal(sourceMatches(source, changed), false);
  }
});
test("unknown and lookalike sources never publish", () => {
  for (const url of [
    "https://evil.test/",
    source.source + "?x=1",
    source.source + "/issues",
    "https://github.com/example/other",
  ])
    assert.equal(
      decide({ ...input, sourceUrl: url }, [source], { projects: [] }, facts).status,
      "out-of-scope",
    );
});

test("unapproved or uncertain source decisions cannot pass metadata checks", () => {
  for (const change of [
    (x) => delete x.review,
    (x) => (x.review.decision = "rejected"),
    (x) => (x.review.political = true),
    (x) => (x.review.highRisk = true),
    (x) => (x.review.privatePerson = true),
    (x) => (x.review.uncertain = true),
    (x) => delete x.review.uncertain,
  ]) {
    const changed = structuredClone(source);
    change(changed);
    assert.equal(sourceMatches(changed, facts), false);
  }
});
test("accepted projection uses reviewed text and deterministic slug", () => {
  const result = decide(input, [source], { projects: [] }, facts);
  assert.equal(result.status, "approved");
  assert.equal(result.source.name, "Example");
  assert.match(result.slug, /^candidate-[a-f0-9-]{36}$/);
  assert.equal(
    decide({ ...input, number: 7 }, [source], { projects: [] }, facts).slug,
    result.slug,
  );
  assert.equal(
    decide({ ...input, name: "<script>bad</script>" }, [source], { projects: [] }, facts).status,
    "name-mismatch",
  );
});
test("stale evidence is quarantined and exact duplicates use existing path", () => {
  assert.equal(decide(input, [source], { projects: [] }, null).status, "source-unavailable");
  const changed = structuredClone(facts);
  changed.commit.sha = "e".repeat(40);
  assert.equal(decide(input, [source], { projects: [] }, changed).status, "source-changed");
  const result = decide(
    input,
    [source],
    {
      projects: [
        {
          source: source.source,
          path: "candidate-00000000-0000-4000-8000-000000000000",
          name: "Example",
        },
      ],
    },
    facts,
  );
  assert.equal(result.status, "existing");
});
test("similar names with another source stay held", () => {
  assert.equal(
    decide(
      input,
      [source],
      { projects: [{ name: "Example", source: "https://different.test/", path: "existing" }] },
      facts,
    ).status,
    "duplicate-uncertain",
  );
});
test("published wording cannot appear before deployment verification", () => {
  assert.doesNotMatch(resultBody(input, "approved", source), /Reviewed and listed/);
  assert.match(
    resultBody(input, "published", source, "candidate-00000000-0000-4000-8000-000000000000"),
    /Reviewed and listed/,
  );
  assert.doesNotMatch(resultBody(input, "deployment-pending", source), /Reviewed and listed/);
  assert.doesNotMatch(resultBody(input, "out-of-scope", source), /Reviewed and listed/);
});
test("commit accepts generated site data only, never workflows or credentials", () => {
  assert.equal(
    commitAllowed("en/candidates/candidate-00000000-0000-4000-8000-000000000000/index.html"),
    true,
  );
  for (const name of [".github/workflows/evil.yml", ".env", "en/../../secret", "scripts/a.mjs"])
    assert.equal(commitAllowed(name), false);
});
test("queue is bounded and ignores PRs and non-suggestions", () => {
  const issues = Array.from({ length: 120 }, (_, i) => ({
    number: i + 1,
    title: "[Project suggestion] Example",
    state: "open",
  }));
  assert.equal(selectNumbers(issues).length, 100);
  assert.deepEqual(
    selectNumbers([
      { ...issues[0], pull_request: {} },
      { ...issues[0], title: "other" },
    ]),
    [],
  );
});

test("porcelain parsing preserves tracked and untracked filenames", () => {
  assert.deepEqual(
    changedPaths(
      " M published-directory.json\n?? en/candidates/candidate-00000000-0000-4000-8000-000000000000/index.html\n",
    ),
    [
      "published-directory.json",
      "en/candidates/candidate-00000000-0000-4000-8000-000000000000/index.html",
    ],
  );
  assert.throws(() => changedPaths(" D published-directory.json"));
});

test("live acceptance requires the actual reviewed summary and both source links", () => {
  const item = { source, slug: "candidate-00000000-0000-4000-8000-000000000000" };
  const page =
    '<h1><bdi>Example</bdi></h1><p class="candidate-summary"><bdi>A code formatter.</bdi></p><a class="primary-link visit-source" href="https://github.com/example/tool"><a class="source-link" href="https://github.com/example/tool">';
  const directory =
    '<li class="project-card"><a href="/gfy0/en/candidates/candidate-00000000-0000-4000-8000-000000000000?from=discover"><bdi>Example</bdi></a><p><bdi>A code formatter.</bdi></p></li>';
  assert.equal(liveMatches(page, directory, item, "en"), true);
  assert.equal(
    liveMatches(page, directory, { ...item, source: { ...source, summaries: {} } }, "en"),
    false,
  );
  assert.equal(
    liveMatches(page.replace("A code formatter.", "Wrong summary"), directory, item, "en"),
    false,
  );
  assert.equal(
    liveMatches(
      page.replaceAll("https://github.com/example/tool", "https://evil.test/"),
      directory,
      item,
      "en",
    ),
    false,
  );
  assert.equal(
    liveMatches(page, directory.replace("A code formatter.", "Wrong summary"), item, "en"),
    false,
  );
});
