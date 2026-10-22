import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceQueueHead,
  changedPaths,
  commitAllowed,
  decide,
  failureDetails,
  hasCompletedReview,
  liveMatches,
  mayGenerateProposal,
  runBudgetedProposal,
  recoveryHold,
  resultBody,
  selectNumbers,
  selectPendingQueue,
  sourceMatches,
} from "./cloud-suggestion-review.mjs";
import { versionOf } from "./github-suggestion-bridge.mjs";

test("queue advances only after a confirmed terminal report, not a failed report or manual skip", () => {
  assert.equal(advanceQueueHead(null, 6, undefined), 6);
  for (const status of [
    "published",
    "existing",
    "review-held",
    "review-failed",
    "needs-information",
  ])
    assert.equal(advanceQueueHead(6, 9, status), 9);
  for (const status of [
    undefined,
    "review-queued",
    "source-unavailable",
    "approved",
    "deployment-pending",
  ])
    assert.equal(advanceQueueHead(6, 9, status), 6);
});

test("queue pages past unrelated and terminal entries without losing the oldest pending version", async () => {
  const issue = (number) => ({
    number,
    title: `[Project suggestion] Tool ${number}`,
    body: "original",
    state: "open",
  });
  const first = Array.from({ length: 100 }, (_, index) => issue(index + 1));
  const final = (i, status) => [
    {
      user: { login: "github-actions[bot]", type: "Bot" },
      body: `Your No.1 · Cloud review · ${versionOf(i).slice(0, 16)}\nPolicy: p\nStatus: ${status}`,
    },
  ];
  for (const kind of ["unrelated", "terminal"]) {
    const pages = [];
    const result = await selectPendingQueue({
      fetchPage: async (page) => {
        pages.push(page);
        if (page > 1) return [issue(101)];
        return kind === "unrelated"
          ? first.map((i, n) => (n % 2 ? { ...i, pull_request: {} } : { ...i, title: "other" }))
          : first;
      },
      readComments: async (i) => (i.number <= 100 ? final(i, "published") : []),
      policy: "p",
    });
    assert.deepEqual(pages, [1, 2]);
    assert.deepEqual(result, [101]);
  }
  assert.deepEqual(
    await selectPendingQueue({
      fetchPage: async () => [issue(1), issue(2), { ...issue(3), body: "edited" }, issue(4)],
      readComments: async (i) =>
        final(issue(i.number), i.number === 1 ? "review-held" : "review-failed"),
      policy: "p",
    }),
    [3],
  );
});

test("queue scan is bounded and rejects incomplete or unordered pages", async () => {
  let pages = 0;
  await assert.rejects(
    selectPendingQueue({
      fetchPage: async (page) => {
        pages++;
        return Array.from({ length: 100 }, (_, i) => ({
          number: (page - 1) * 100 + i + 1,
          title: "unrelated",
          state: "open",
        }));
      },
      readComments: async () => {
        throw Error("must not read unrelated comments");
      },
      policy: "p",
    }),
    /queue-scan-limit/,
  );
  assert.equal(pages, 10);
  const issue = (number) => ({
    number,
    title: "[Project suggestion] Tool",
    body: "",
    state: "open",
  });
  const result = await selectPendingQueue({
    fetchPage: async () => Array.from({ length: 100 }, (_, i) => issue(i + 1)),
    readComments: async () => [],
    policy: "p",
  });
  assert.deepEqual(
    result,
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  await assert.rejects(
    selectPendingQueue({
      fetchPage: async () => [issue(2), issue(1)],
      readComments: async () => [],
      policy: "p",
    }),
    /queue-order-invalid/,
  );
});

test("cloud failure diagnostics expose only fixed stage, class and code", () => {
  const error = new TypeError("private message with credentials");
  error.cause = { code: "UND_ERR_SOCKET", message: "private response" };
  assert.deepEqual(failureDetails(error, "confirm-submission-version"), {
    event: "cloud-review-failure",
    stage: "confirm-submission-version",
    name: "TypeError",
    code: "UND_ERR_SOCKET",
  });
  assert.deepEqual(
    failureDetails(
      { name: "private name", code: "private code", stack: "private stack" },
      "private source",
    ),
    {
      event: "cloud-review-failure",
      stage: "other",
      name: "other",
      code: "other",
    },
  );
  for (const stage of ["initial-source-fetch", "report-source-unavailable"])
    assert.deepEqual(failureDetails(error, stage), {
      event: "cloud-review-failure",
      stage,
      name: "TypeError",
      code: "UND_ERR_SOCKET",
    });
});

test("failed model diagnostics preserve safe stage without leaking worker output", () => {
  const error = Object.assign(new Error("private secret"), {
    modelFailure: {
      status: "FAIL_STOP_ROUTE",
      failedStage: "inference-source",
      errorType: "TimeoutError",
      cleanupVerified: true,
      serverStopped: true,
      proposal: "secret",
      stderr: "credentials",
    },
  });
  assert.deepEqual(failureDetails(error, "model-review").model, {
    status: "FAIL_STOP_ROUTE",
    failedStage: "inference-source",
    errorType: "TimeoutError",
    cleanupVerified: true,
    serverStopped: true,
  });
  assert.ok(!/secret|credentials/.test(JSON.stringify(failureDetails(error, "model-review"))));
  error.modelFailure.failedStage = "private stage";
  error.modelFailure.errorType = "private type";
  assert.equal(failureDetails(error, "model-review").model.failedStage, "other");
  assert.equal(failureDetails(error, "model-review").model.errorType, "other");
  assert.equal(failureDetails(error, "finish").model, undefined);
});

test("only bounded submission, scheduled or manual review can invoke the model", () => {
  for (const event of ["", "push"]) assert.equal(mayGenerateProposal(event, 0), false);
  for (const event of ["issues", "schedule", "workflow_dispatch"]) {
    assert.equal(mayGenerateProposal(event, 0), true);
    assert.equal(mayGenerateProposal(event, 1), false);
  }
});

test("every trigger shares a durable UTC-hour allowance before model execution", async () => {
  let budget = { version: 1, hour: "2026-10-20T14" };
  const order = [];
  const attempt = (eventName, now, calls = 0, number = 9) =>
    runBudgetedProposal({
      eventName,
      calls,
      number,
      queueHead: 9,
      budget,
      now,
      persist: async (next) => {
        order.push("persist");
        budget = next;
      },
      generate: async () => {
        order.push("model");
        return { checked: true };
      },
    });
  assert.deepEqual(await attempt("issues", "2026-10-20T15:00:00.000Z"), {
    checked: true,
  });
  assert.deepEqual(order, ["persist", "model"]);
  assert.deepEqual(budget, { version: 1, hour: "2026-10-20T15" });
  for (const event of ["issues", "schedule", "workflow_dispatch"])
    assert.equal(await attempt(event, "2026-10-20T15:59:59.999Z"), null);
  assert.equal(await attempt("issues", "2026-10-20T16:00:00.000Z", 1), null);
  assert.equal(await attempt("workflow_dispatch", "2026-10-20T16:00:00.000Z", 0, 10), null);
  assert.deepEqual(order, ["persist", "model"]);
  assert.deepEqual(await attempt("schedule", "2026-10-20T16:00:00.000Z"), {
    checked: true,
  });
  assert.deepEqual(order, ["persist", "model", "persist", "model"]);
});

test("bad budgets and failed persistence never invoke the model; model failure never refunds", async () => {
  let calls = 0;
  let budget = { version: 1, hour: "2026-10-20T14" };
  const options = {
    eventName: "issues",
    calls: 0,
    number: 9,
    queueHead: 9,
    now: "2026-10-20T15:00:00.000Z",
    persist: async () => {
      throw Error("push failed");
    },
    generate: async () => {
      calls++;
      throw Error("model failed");
    },
  };
  for (const invalid of [
    null,
    {},
    { version: 2, hour: "2026-10-20T14" },
    { version: 1, hour: "2026-02-30T14" },
    { version: 1, hour: "2026-10-20T16" },
    { version: 1, hour: "2026-10-20T14", issue: 9 },
  ])
    await assert.rejects(runBudgetedProposal({ ...options, budget: invalid }), {
      name: "ModelBudgetError",
    });
  await assert.rejects(runBudgetedProposal({ ...options, budget }), {
    name: "ModelBudgetError",
  });
  assert.equal(calls, 0);
  const persist = async (next) => {
    budget = next;
  };
  await assert.rejects(runBudgetedProposal({ ...options, budget, persist }), /model failed/);
  assert.equal(calls, 1);
  assert.equal(await runBudgetedProposal({ ...options, budget, persist }), null);
  assert.equal(calls, 1);
});

test("failed model versions stop retrying until the submission changes", () => {
  const comment = (status) => ({
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `Your No.1 · Cloud review · abc\nPolicy: policy\nStatus: ${status}`,
  });
  assert.equal(hasCompletedReview([comment("review-failed")], "abc", "policy"), true);
  assert.equal(hasCompletedReview([comment("review-failed")], "edited", "policy"), false);
  assert.equal(hasCompletedReview([comment("review-failed")], "abc", "new-policy"), false);
  for (const status of ["review-queued", "source-unavailable", "deployment-pending"])
    assert.equal(hasCompletedReview([comment(status)], "abc", "policy"), false);
  const spoof = comment("review-failed");
  spoof.user.type = "User";
  assert.equal(hasCompletedReview([spoof], "abc", "policy"), false);
  assert.equal(
    hasCompletedReview(
      [{ user: { login: "gfy0" }, body: "Your No.1 · Review result · abc\nReviewed and listed" }],
      "abc",
      "policy",
    ),
    true,
  );
  for (const status of ["review-held", "published", "existing"])
    assert.equal(hasCompletedReview([comment(status)], "abc", "policy"), true);
});

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
  assert.deepEqual(selectNumbers([issues[4], issues[1], issues[0]]), [1, 2, 5]);
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
