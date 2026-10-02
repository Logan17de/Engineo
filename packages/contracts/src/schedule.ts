export const ENGINE_CONTRACT_VERSION = 1 as const;

export type RelationshipTypeV1 = "FS" | "SS" | "FF" | "SF";

export interface ActivityInputV1 {
  id: string;
  name: string;
  durationMinutes: number;
  calendarId: string;
}

export interface RelationshipInputV1 {
  predecessorId: string;
  successorId: string;
  type: RelationshipTypeV1;
  lagMinutes: number;
}

export interface EngineProjectInputV1 {
  schemaVersion: typeof ENGINE_CONTRACT_VERSION;
  project: {
    id: string;
    name: string;
    plannedStart: string;
    defaultCalendarId: string;
  };
  activities: ActivityInputV1[];
  relationships: RelationshipInputV1[];
}
