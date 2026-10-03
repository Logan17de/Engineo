# Activity CSV v1

This increment of #51 supports editing existing activities through an exported
UTF-8 CSV. It is a partial interchange view, not a project backup. JSON remains
the complete schedule-input export. Creating/deleting activities, WBS and
relationship import templates, and native XLSX support remain open.

## Planner workflow

1. Save current edits and select **Export activities CSV**.
2. Open the file in a spreadsheet using UTF-8, comma separators and text columns
   for IDs/names. Preserve the header names and project/activity IDs.
3. Edit supported fields and save as UTF-8 CSV.
4. Open **Import CSV**, select the file, and choose **Preview CSV changes**.
5. Review before/after values. Large previews have pages of 50 changed activities.
6. Choose **Apply CSV changes**, then **Recalculate** for authoritative Rust dates.

Cancel and preview never write project data. Unsaved Planner edits must be saved
or discarded before import. Replacing the selected file invalidates its preview.
Reloading or changing project/account discards the pending file/preview. CSV
drafts are memory-only and are not recovered across sign-in changes.

An interrupted apply may already have committed. Reload the saved version to
resolve that uncertainty; replay against the old revision cannot commit twice.
A stale version or changed file requires a new preview. Permissions, session
intent, Origin and CSRF are checked on both preview and apply.

## Columns

All seven columns are required; column order may change. Unknown/duplicate
columns and inconsistent row widths are rejected so no unsupported data is
silently ignored.

| Header | Meaning | Rule |
| --- | --- | --- |
| `projectId` | Selected project UUID | Every row must match the selected project |
| `activityId` | Existing activity UUID | Must exist in the selected project; no duplicates |
| `name` | Activity name | Nonblank, at most 500 UTF-16 code units |
| `kind` | Activity type | `TASK`, `START_MILESTONE`, or `FINISH_MILESTONE` |
| `durationMinutes` | Whole working minutes | Base-10 integer from 0 to 4,294,967,295; milestones require zero |
| `wbsId` | Existing WBS UUID | Must belong to this project |
| `calendarId` | Existing calendar UUID | Must belong to this project |

Omitted rows are preserved. Row order does not reorder activities. Constraints,
relationship IDs/logic, WBS hierarchy, calendars and project settings are retained.
The server validates the candidate against the existing schedule contract before
preview and again before committing. Import performs no scheduling mathematics.
Supported input ranges do not guarantee every extreme duration is calculable.

## Text, bounds and spreadsheet handling

- Export: UTF-8 BOM, comma delimiter, CRLF rows, quoted fields, doubled quotes.
- Import: optional BOM, CRLF/LF/CR record endings and quoted multiline fields.
- Every file is limited to **512 KiB of UTF-8**, 10,000 data records, seven fields
  per record and 2,048 UTF-16 code units per parsed field. Control characters other
  than tab/CR/LF, unpaired surrogates, replacement characters, malformed quotes,
  duplicate IDs and invalid references are rejected. Browser decoding is fatal
  for invalid UTF-8. The API transport body limit allows JSON escaping overhead;
  parsing still enforces the original UTF-8 byte limit.
- Larger exports can exceed the import budget. Split them into subsets with the
  same header and preview/apply each subset against the latest saved revision;
  omitted rows are preserved. JSON export remains available.
- Formula-like text beginning with `=`, `+`, `-`, `@` (including preceding
  whitespace), tab/CR/LF, or an apostrophe receives one leading apostrophe on
  export. The importer reverses exactly that escape. An original leading
  apostrophe is doubled. CSV quoting alone is insufficient for formula safety.
  The application never evaluates cells. Desktop Excel/LibreOffice resave
  behavior has not been manually verified; review the preview after external
  spreadsheet edits, especially text escaping and IDs.

## API and audit

Paths are below `/organizations/:organizationId/projects/:projectId`:

- `GET /activities/export`: authorized `text/csv` attachment, `no-store`; appends
  `project.export` with format `engineo-activities-v1`, revision and SHA-256 of the
  exact exported UTF-8 bytes, including BOM and final CRLF. Browser download
  preserves those bytes.
- `POST /activities/import/preview`: `{csv, expectedRevision}` returns counts,
  complete changes, `sourceHash` and `previewHash`. No database mutation.
- `POST /activities/import/apply`: `{csv, expectedRevision, previewHash}` reparses
  and revalidates against the current project and verifies the preview digest.
  The digest binds tenant/project, revision, source bytes and canonical candidate
  input. It is a consistency check, not an authorization credential or evidence
  that a human reviewed the preview; write access is independently enforced.

Apply updates only the five supported activity fields under the existing project
revision lock. The changes, revision increment, `project.activities.import`
provenance and existing `project.schedule.edit` before/after audit commit in one
transaction. Audit failure rolls everything back. Repeated/concurrent applies
against a changed revision return 409. A no-op returns the current revision and
creates no edit/import event. Import provenance stores source SHA-256, format,
row/changed counts and old/new revisions; the raw file and file name are not stored.

No migrations, dependencies or Rust contract/calculation changes are required.
