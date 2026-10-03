-- Keep the applied 0005 migration and its checksum immutable. PostgreSQL CHECK
-- accepts UNKNOWN, so nullable material fields must produce a definite TRUE.
-- Cancellation intentionally retains its three null material-state fields.
ALTER TABLE project_configuration_outcomes
  ADD CONSTRAINT configuration_outcome_material_state CHECK (
    ((outcome = 'cancelled' AND committed_revision IS NULL AND committed_input_hash_sha256 IS NULL
        AND schedule_edit_audit_id IS NULL)
      OR (outcome = 'no_op' AND committed_revision = previous_revision AND
          committed_input_hash_sha256 = base_input_hash_sha256 AND schedule_edit_audit_id IS NULL)
      OR (outcome = 'applied' AND committed_revision = previous_revision + 1 AND
          committed_input_hash_sha256 IS NOT NULL AND schedule_edit_audit_id IS NOT NULL)) IS TRUE
  );
