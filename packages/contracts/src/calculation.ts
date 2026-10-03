/** Immutable completed calculation provenance. Versions are declarations, not binary attestations. */
export interface ScheduleCalculationMetadataV1 {
  schemaVersion: 1;
  calculationId: string;
  projectRevision: number;
  inputHashSha256: string;
  resultHashSha256: string;
  engineContractVersion: 1;
  engineVersion: string;
  calculatedAt: string;
}
