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

## BS4K native TLV parsing

BS4K channel scanning and background EPG gathering read the original tuner
output, without requiring `mmtsDecoder` to convert it to TS. The input parser
detects direct TLV/MMT or converted TS; existing TS channel configurations and
raw `decode=0` stream bytes remain supported. Native metadata follows the
existing network/service/event identity and SQLite history contract.

The TLV reader handles TLV-NIT, PLT, MH-SDT, MH-EIT, MH-TOT and MH-CDT.
Service discovery waits for matching actual tables and PLT membership, regardless
of their arrival order. Service names use UTF-8, remote keys are service-specific,
and EPG observations are restricted to the selected channel/network. Each event
is persisted once after collecting all descriptors, with existing occurrence
reuse and expiry handling. Video metadata reports HEVC, the signalled resolution,
frame rate and transfer characteristics; multi-audio and continued extended text
are retained.

Tracked upstream: `jp-dtv-4k/DMirakurun` through `7a98eb8` (2026-10-20),
particularly `98d7bba`, `9df3f5b`, and `72ed854`. The integration also includes TS/TLV/TSMF detection, relative-TS selection,
CATV ESS logos, route selection and StreamID access.
Validation includes fragmented input, table arrival order, complete program
metadata, atomic history observations and existing TS/raw fanout regressions.
Real sample replay proves parsing; physical reception and deployed service
recovery require tuner-side verification.

## Stream routing and output contract

`decode=0|1` remains supported and controls configured B25/B61 decryption.
`format=ts|tlv` independently selects the output container. TS cannot become TLV;
TLV-to-TS requires `tlvToTsDecoder`. Unsupported explicit conversions return 406
before sending stream bytes. `tlvDecoder` decrypts TLV without converting it.
Omitted format preserves existing `mmtsDecoder` deployments (decoded TS, raw
TLV for decode=0); new configurations use `defaultTlvStreamFormat` (TLV by default).
Legacy combined decryption/conversion commands retain their deployed semantics;
independent control requires separate decoder/converter commands.

Channels expose TER/SAT/CATV/HIKARI routes and observed network/StreamID maps.
Service and program identities remain network/service/event based. Service access
tries observed routes while enforcing each channel's allowedTuners, each tuner's
route capability, local-only requests and remote nesting restrictions. StreamID
listing/detail/stream endpoints use the same restrictions. TSMF metadata is
CRC/slot validated; automatic relative-TS selection and carrier assembly use the
validated group and stream map. Extra carriers obey tuner limits and are released
when the owning stream ends. Physical multi-carrier reception requires devices.

Existing services.json records remain readable without streamId or channels.json.
The Service manager owns this deployed-client compatibility: the existing channel
field remains a supported wire contract, while optional streamId and channels add
observed alternatives. Missing streamId remains absent until received in tables;
it is never fabricated and never makes an existing service unavailable. This is
an additive contract, not a replacement of legacy service identity or persistence.
Validation must cover cold loading legacy records, complete HTTP service/channel
responses, StreamID access, raw/container/decode behavior and tuner restrictions.

Observed channel/StreamID maps are stored in `CHANNELS_DB_PATH`, defaulting to
`channels.json` beside the configured services database. The existing service
`channel` object keeps its deployed type/channel shape; route-qualified entries
are available in `channels`. Channel read/stream APIs accept an optional `route`
query to disambiguate equal channel numbers on different delivery routes. Remote
requests carry the selected route, format and decryption choice.

Carrier assembly is implemented for configured/discovered matching local groups;
remote channel streams are already demultiplexed and cannot supply outer TSMF
carriers. Extra carrier assignment respects every carrier's allowedTuners and
route capabilities, and cancellation releases successful in-flight starts.
This does not establish 8K physical-reception acceptance or automatic discovery
of an entirely unconfigured multi-carrier installation.

Acceptance in this workspace includes the retained BSP4K sample through the real
tuner scanner, EPG writer, SQLite history and HTTP readers: network 11, service
101, StreamID 45328, and 259 programs with HEVC 2160p/59.94 HLG and multiple audio
components. Stream HTTP checks exercise all five endpoint families, decode/format,
MIME, unsupported-format 406 and disconnect cleanup. B61 commands are validated as
independent processes; card/device decryption still requires actual reception.
