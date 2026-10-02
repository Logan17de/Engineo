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
