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

Invalid incoming program identities, timing values or free-to-air flags are
rejected before changing the current store or queuing history writes. An invalid
update preserves the previous valid program; an invalid remote replacement
preserves that network's previous snapshot. Warnings include the program identity
and invalid fields and values. Such input errors do not disable storage or stop
the server; actual SQLite and worker failures remain fatal storage failures.

Validation covers startup migration, immediate mutations, ordering, filtering,
Unicode response lengths, concurrent HTTP requests, and unavailable storage.
Local fixtures do not establish production-data or physical-tuner acceptance.

EPG jobs pass their target network identity through to acquisition. A channel
number or the first service on a shared route cannot substitute for that identity:
different reception sites can use the same terrestrial frequency for different
networks. Remote EPG acquisition tries each eligible endpoint once and only
publishes a nonempty, valid result belonging entirely to the requested network.
Empty, malformed or mismatched responses fail acquisition and preserve the last
valid schedule; normal expiry still removes ended programs from current queries.

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

External TLV decoder/converter completion requires successful process exit,
finished input and fully drained output. Client cancellation releases the entire
per-request pipeline without reporting its interrupted stdin finalization as an
uncaught exception. A failed or prematurely exited stage fails that request:
HTTP 503 before response bytes, or an aborted response after streaming starts.
It must not return an empty/truncated successful response or splice a restarted
converter into an existing stream. Validation covers both stages, cancellation
and all stream endpoint families with controlled child processes.

TLV requests have an independent shared byte budget across decoder input queues
and the final output wrapper (32 MiB by default). This budget counts pending
application writes; Node's existing PassThrough and socket buffers are additional
bounded buffers, not included in that number. A slow consumer never pauses a
shared tuner or silently discards recording bytes: only that request fails.
Decoder stdout respects downstream backpressure. Defaults are 10 seconds for
first decoder output, 30 seconds for missing source input or blocked output,
15 seconds for conversion without progress while input arrives, and 10 seconds
for final drain after input ends. Timers do not charge tuner acquisition time
before TLV detection; downstream congestion is classified separately from
converter stalls. Cancellation is not a failure and releases all owned stages.
Server `tlvStreamProtection` may override these positive durations (milliseconds)
and `maxBufferBytes`; omitted/invalid values use the application defaults.

`GET /api/stream-failures` exposes the last 50 TLV request failures in this server
process, newest first. It includes stage, stable failure code, request/channel,
byte counters, timestamps, exit information and at most 4096 characters of
redacted stderr. Refresh retains these records; a server restart clears them.
The home page keeps diagnostics in normal document flow: loading and empty
states use the same compact status row, and a failed refresh shows its reason
and retry action without covering other sections. The list grows with its
contents up to 24rem, then scrolls; no empty 24rem panel is reserved. Background
refresh preserves existing results and focus. Desktop and narrow layouts must
keep the heading, refresh action and full failure details usable. Failures
retain the existing HTTP error body; the diagnostics endpoint supplies detail
without changing deployed consumers.

Live validation on 2026-10-25 used Hiraku BS4K1 / BS17_0 (NHK BSP4K),
the current local Tuner/StreamFilter/HTTP server, production-version dantto4k
over SSH stdin/stdout, and native macOS mmt2ts 0.1.5. Channel/service requests
covered input EOF, client cancellation, reconnect, and converter termination
before headers and during streaming. Successful responses contained 3840x2160
HEVC and AAC; FFmpeg decoded three distinct 4K frames. Failure injection returned
503 before headers or an incomplete response after bytes. All cases released
filters/decoders without uncaught exceptions or respawns. Short captures were
kept in bounded memory only; this does not establish long-duration recording
stability. Some dantto4k tune-ins emitted initial SPS/reference-frame warnings;
the final decode check and native mmt2ts run had no FFmpeg errors.

### Playback and recording consumers

HonomiTV and EPGStation keep using service/program streams, rather than whole
StreamID streams. Consumers discover explicit container support from `/api/docs`:
the relevant stream operation must declare a query `format` enum containing
`ts` and `tlv` (path-level or GET parameters). Product names and version strings
are not a capability signal. Old Mirakurun and mirakc deployments without this
declaration retain their existing decode-only request behavior. Discovery is
bounded and cached briefly; transport failures must not disable support forever.

Native MMTS playback and recording request `decode=1&format=tlv` when supported;
TS consumers request `format=ts` while preserving their independent decode
choice. Native MMTS on older servers retains `decode=0` to bypass legacy
combined conversion. Explicit raw archival can still request `decode=0`.
A 406 response is a format/configuration error and must not silently fall back
to a different container. B61 decryption still requires a configured
`tlvDecoder`; declaring format support does not imply a smart card is available.
Optional service `streamId` values may populate consumer transport-stream
metadata; missing values must not erase known historical metadata.

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
