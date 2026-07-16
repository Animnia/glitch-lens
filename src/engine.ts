export interface Fingerprint {
  token: string;
  vendor: string;
}

export type ProbeResponse =
  | { kind: "success"; content: string }
  | { kind: "error"; message: string };

export type ProbeOutcome = "copy_success" | "copy_failed" | "request_failed";

export interface ProbeEvidence {
  vendor: string;
  token: string;
  attempt: number;
  outcome: ProbeOutcome;
  response?: string;
  error?: string;
}

export interface VendorCandidate {
  vendor: string;
  confirmedToken: string;
}

export interface ScanResult {
  status: "match" | "conflict" | "unknown";
  candidates: VendorCandidate[];
  evidence: ProbeEvidence[];
}

export interface ScanOptions {
  fingerprints: Fingerprint[];
  requestProbe: (token: string) => Promise<ProbeResponse>;
}

const whitespacePattern = /\p{White_Space}/gu;

function compact(value: string): string {
  return value.normalize("NFC").replace(whitespacePattern, "");
}

function copiedToken(response: string, token: string): boolean {
  return compact(response).includes(compact(token));
}

async function testProbe(
  fingerprint: Fingerprint,
  attempt: number,
  requestProbe: ScanOptions["requestProbe"],
): Promise<ProbeEvidence> {
  let response = await requestProbe(fingerprint.token);
  if (response.kind === "error") response = await requestProbe(fingerprint.token);

  if (response.kind === "error") {
    return {
      vendor: fingerprint.vendor,
      token: fingerprint.token,
      attempt,
      outcome: "request_failed",
      error: response.message,
    };
  }

  return {
    vendor: fingerprint.vendor,
    token: fingerprint.token,
    attempt,
    outcome: copiedToken(response.content, fingerprint.token) ? "copy_success" : "copy_failed",
    response: response.content,
  };
}

async function scanVendor(
  vendor: string,
  fingerprints: Fingerprint[],
  requestProbe: ScanOptions["requestProbe"],
): Promise<{ candidate?: VendorCandidate; evidence: ProbeEvidence[] }> {
  const evidence: ProbeEvidence[] = [];

  for (const fingerprint of fingerprints) {
    const first = await testProbe(fingerprint, 1, requestProbe);
    evidence.push(first);

    if (first.outcome !== "copy_failed") continue;

    const confirmation = await testProbe(fingerprint, 2, requestProbe);
    evidence.push(confirmation);

    if (confirmation.outcome === "copy_failed") {
      return {
        candidate: { vendor, confirmedToken: fingerprint.token },
        evidence,
      };
    }
  }

  return { evidence };
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const grouped = new Map<string, Fingerprint[]>();
  for (const fingerprint of options.fingerprints) {
    const group = grouped.get(fingerprint.vendor) ?? [];
    group.push(fingerprint);
    grouped.set(fingerprint.vendor, group);
  }

  const vendorResults = await Promise.all(
    [...grouped.entries()].map(([vendor, fingerprints]) => scanVendor(vendor, fingerprints, options.requestProbe)),
  );
  const candidates = vendorResults.flatMap((result) => (result.candidate ? [result.candidate] : []));

  return {
    status: candidates.length === 0 ? "unknown" : candidates.length === 1 ? "match" : "conflict",
    candidates,
    evidence: vendorResults.flatMap((result) => result.evidence),
  };
}
