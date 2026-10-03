export interface ActivityScheduleResultV1 {
  earlyStart: string;
  earlyFinish: string;
  lateStart: string;
  lateFinish: string;
  totalFloatMinutes: number;
  freeFloatMinutes: number;
  critical: boolean;
  drivingCauses: Array<{
    kind: string;
    predecessorId?: string;
    relationshipType?: string;
    lagMinutes?: number;
    constraintType?: string;
    instant?: string;
  }>;
}

/** Dates, float, controlling paths and violations are calculated by Rust. */
export interface EngineScheduleResultV1 {
  schemaVersion: 1;
  projectFinish: string;
  lateProjectFinish: string;
  controllingFinishActivity: string | null;
  controllingPath: string[];
  activities: Record<string, ActivityScheduleResultV1>;
  constraintViolations: Array<{
    activityId: string;
    constraintType: string;
    constraintInstant: string;
    actualInstant: string;
  }>;
}

/** An auditable result for one immutable saved project revision. */
export interface ScheduleCalculationV1 {
  id: string;
  revision: number;
  engineContractVersion: 1;
  inputHash: string;
  resultHash: string;
  completedAt: string;
  result: EngineScheduleResultV1;
}
