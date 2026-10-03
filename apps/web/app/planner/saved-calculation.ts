import {
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  isRfc3339Instant,
  type ScheduleCalculationMetadataV1,
  serializeScheduleInputV1,
  serializeScheduleResultV1,
} from "@engineo/contracts";

export interface CalculationSnapshot {
  revision: number;
  result: EngineScheduleResultV1 | null;
  calculation: ScheduleCalculationMetadataV1 | null;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Consistency checking, not authentication or an independent calculation. */
export async function matchesStoredCalculation(
  saved: CalculationSnapshot,
  expected: { revision: number; input: EngineProjectInputV1 },
): Promise<boolean> {
  try {
    const metadata = saved.calculation;
    if (
      saved.revision !== expected.revision ||
      !saved.result ||
      !metadata ||
      metadata.schemaVersion !== 1 ||
      metadata.engineContractVersion !== 1 ||
      saved.result.schemaVersion !== 1 ||
      metadata.projectRevision !== expected.revision ||
      metadata.engineContractVersion !== saved.result.schemaVersion ||
      !/^[0-9a-f]{64}$/.test(metadata.inputHashSha256) ||
      !/^[0-9a-f]{64}$/.test(metadata.resultHashSha256) ||
      typeof metadata.calculationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        metadata.calculationId,
      ) ||
      typeof metadata.engineVersion !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/.test(metadata.engineVersion) ||
      !isRfc3339Instant(metadata.calculatedAt)
    )
      return false;
    const [inputHash, resultHash] = await Promise.all([
      sha256(serializeScheduleInputV1(expected.input)),
      sha256(serializeScheduleResultV1(saved.result)),
    ]);
    return inputHash === metadata.inputHashSha256 && resultHash === metadata.resultHashSha256;
  } catch {
    return false;
  }
}
