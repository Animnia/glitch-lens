import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import type { Fingerprint } from "./engine.js";

interface CsvRecord {
  "glitch token"?: string;
  "model series"?: string;
  "error rate@5"?: string;
  isSpecific?: string;
}

export async function loadFingerprints(path: string): Promise<Fingerprint[]> {
  const source = await readFile(path, "utf8");
  const records = parse(source, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRecord[];

  const fingerprints = records
    .filter((record) => record.isSpecific?.toLowerCase() === "y")
    .map((record, index) => {
      const token = record["glitch token"];
      const vendor = record["model series"];
      if (!token || !vendor) throw new Error(`Invalid fingerprint at CSV row ${index + 2}`);
      return { token, vendor };
    });

  if (fingerprints.length === 0) throw new Error("Fingerprint file contains no specific fingerprints");
  return fingerprints;
}
