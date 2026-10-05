# EPG storage and current-program queries

SQLite owns persisted EPG data. History retention defaults to 365 days and is
configured by `programHistoryRetentionDays`. Visible changes retain revisions;
ended and removed occurrences remain available through the history API until
retention expires.

`GET /api/programs` queries SQLite in the storage worker on every request. It
flushes already received mutations before querying and returns the complete
current-program array, including existing fields and insertion order. Updates
retain their position; removal followed by restoration appends the program.
There is no response cache, scheduled list refresh, or stale-response fallback.

The current-program SQL projection and history revisions change in the same
transaction. Existing databases populate the projection automatically during
startup, before readers serve requests. Legacy JSON import remains a one-time
startup operation and does not modify the source file.

Simple numeric network/service/event filters use SQL indexes. Existing extended
Sift filters remain supported through a SQLite function executed in the worker;
this preserves the deployed query contract without filtering an in-memory list
on the HTTP thread. `$where` is rejected before compilation. Storage failure
returns HTTP 503 rather than an empty or stale list.

Transaction failure diagnostics retain the original SQLite error, its error
codes, worker operation and stack. A failed explicit rollback is secondary:
SQLite may already have rolled back the transaction automatically. Storage
failure still blocks subsequent writes; failed batches are never treated as
committed or retried blindly.

Validation covers startup migration, immediate mutations, ordering, filtering,
Unicode response lengths, concurrent HTTP requests, and unavailable storage.
Local fixtures do not establish production-data or physical-tuner acceptance.

Expired occurrences (three hours after end, or 24 hours for unknown duration)
remain archived when observed again. Repeated observation must not restore them
or append unchanged archive revisions. Startup removes expired current entries
before serving readers. Real timing corrections that move an occurrence back
into the current window can restore it.

EIT descriptors for one event are applied together after the descriptor loop;
partial audio and related-event lists are not independently persisted revisions.
Separate completed event observations and explicit remove/restore transitions
remain observable history changes. Existing historical revisions are retained.
