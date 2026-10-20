/** Matches the bounded source extractor; evidence must not be silently truncated. */
export const CANDIDATE_REVIEW_SOURCE_MAX_CHARACTERS = 20_000;

export interface AutomatedCandidateReviewSource {
  readonly sourceId: string;
  readonly textPreview: string;
}

export type AutomatedCandidateReviewFailureReason =
  | "invalid-source-evidence"
  | "invalid-review-result"
  | "political-content"
  | "high-risk-content"
  | "eligibility-unknown"
  | "consent-unverified"
  | "review-uncertain"
  | "unsafe-proposed-text"
  | "source-citation-mismatch";

type AutomatedCandidateReviewQuarantineReason = Exclude<
  AutomatedCandidateReviewFailureReason,
  "political-content"
>;

export type AutomatedCandidateReviewResult =
  | {
      readonly status: "supported-proposal";
      readonly policyVersion: "1";
      readonly sourceId: string;
      readonly name: string;
      readonly summary: string;
      readonly publishable: false;
      readonly boostAvailable: false;
      readonly automaticMerge: false;
    }
  | {
      readonly status: "blocked";
      readonly reason: "political-content";
      readonly policyVersion: "1";
      readonly publishable: false;
      readonly boostAvailable: false;
      readonly automaticMerge: false;
    }
  | {
      readonly status: "quarantined";
      readonly reason: AutomatedCandidateReviewQuarantineReason;
      readonly policyVersion: "1";
      readonly publishable: false;
      readonly boostAvailable: false;
      readonly automaticMerge: false;
    };

type ReviewCategory = "general" | "political" | "high-risk" | "private-person" | "unknown";

interface DecodedReviewProposal {
  readonly category: ReviewCategory;
  readonly uncertain: boolean;
  readonly nameQuote: string;
  readonly summaryQuote: string;
}

const POLICY_VERSION = "1" as const;
const UUID_V1_TO_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CATEGORIES = new Set<ReviewCategory>([
  "general",
  "political",
  "high-risk",
  "private-person",
  "unknown",
]);
const PROPOSAL_FIELDS = ["category", "nameQuote", "summaryQuote", "uncertain"];
const REDACTION_MARKERS = ["[redacted-ip]", "[redacted-email]", "[redacted-token]"];

export function evaluateAutomatedCandidateReview(
  source: AutomatedCandidateReviewSource,
  proposal: unknown,
): AutomatedCandidateReviewResult {
  // Source evidence is supplied by a server boundary; this decoder never grants that boundary authority.
  if (!isValidSource(source)) return quarantine("invalid-source-evidence");

  const decoded = decodeProposal(proposal);
  if (decoded === undefined) return quarantine("invalid-review-result");

  switch (decoded.category) {
    case "political":
      return blockedPolitical();
    case "high-risk":
      return quarantine("high-risk-content");
    case "unknown":
      return quarantine("eligibility-unknown");
    case "private-person":
      return quarantine("consent-unverified");
    case "general":
      break;
  }
  if (decoded.uncertain) return quarantine("review-uncertain");

  if (isUnsafeProposedText(decoded.nameQuote) || isUnsafeProposedText(decoded.summaryQuote)) {
    return quarantine("unsafe-proposed-text");
  }
  if (!isWellFormedQuote(decoded.nameQuote, 200) || !isWellFormedQuote(decoded.summaryQuote, 500)) {
    return quarantine("source-citation-mismatch");
  }
  if (
    !source.textPreview.includes(decoded.nameQuote) ||
    !source.textPreview.includes(decoded.summaryQuote) ||
    !decoded.summaryQuote.includes(decoded.nameQuote)
  ) {
    return quarantine("source-citation-mismatch");
  }

  return {
    status: "supported-proposal",
    policyVersion: POLICY_VERSION,
    sourceId: source.sourceId,
    name: decoded.nameQuote,
    summary: decoded.summaryQuote,
    publishable: false,
    boostAvailable: false,
    automaticMerge: false,
  };
}

function isValidSource(source: AutomatedCandidateReviewSource): boolean {
  if (typeof source !== "object" || source === null) return false;
  const candidate = source as Partial<AutomatedCandidateReviewSource>;
  return (
    typeof candidate.sourceId === "string" &&
    UUID_V1_TO_V5.test(candidate.sourceId) &&
    typeof candidate.textPreview === "string" &&
    candidate.textPreview.length <= CANDIDATE_REVIEW_SOURCE_MAX_CHARACTERS &&
    candidate.textPreview.trim().length > 0
  );
}

function decodeProposal(value: unknown): DecodedReviewProposal | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const fields = Object.keys(value).sort();
  if (fields.length !== PROPOSAL_FIELDS.length) return undefined;
  if (!fields.every((field, index) => field === PROPOSAL_FIELDS[index])) return undefined;

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.category !== "string" ||
    !CATEGORIES.has(candidate.category as ReviewCategory) ||
    typeof candidate.uncertain !== "boolean" ||
    typeof candidate.nameQuote !== "string" ||
    typeof candidate.summaryQuote !== "string"
  ) {
    return undefined;
  }
  return candidate as unknown as DecodedReviewProposal;
}

function isWellFormedQuote(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.length <= maximumLength && value.trim() === value;
}

function isUnsafeProposedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f || value[index] === "<" || value[index] === ">") {
      return true;
    }
  }
  return REDACTION_MARKERS.some((marker) => value.includes(marker));
}

function blockedPolitical(): AutomatedCandidateReviewResult {
  return {
    status: "blocked",
    reason: "political-content",
    policyVersion: POLICY_VERSION,
    publishable: false,
    boostAvailable: false,
    automaticMerge: false,
  };
}

function quarantine(
  reason: AutomatedCandidateReviewQuarantineReason,
): AutomatedCandidateReviewResult {
  return {
    status: "quarantined",
    reason,
    policyVersion: POLICY_VERSION,
    publishable: false,
    boostAvailable: false,
    automaticMerge: false,
  };
}
