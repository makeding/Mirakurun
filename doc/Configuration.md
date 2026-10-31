[**English**](Configuration.md) | [**日本語**](Configuration.ja.md)

# Configuration

- 🗒️[server.yml](#serveryml) - Server Settings
- 🗒️[tuners.yml](#tunersyml) - Tuner Settings
- 🗒️[channels.yml](#channelsyml) - Channel Settings

## ⚠️Security Considerations (FYI)

- Mirakurun is designed to be a LAN-only server.
- By default, access is restricted to private IP addresses.
- Access from arbitrary hostnames or domains is prohibited → **DNS Rebinding / CSRF protection**
  - `hostname`: Set the hostname to access the Web UI.
  - `allowOrigins`: Explicitly set allowed hostnames/domains if required.
- Multiple techniques are used to mitigate attack risks.
- Do not allow API access from all domains or deploy without a reverse proxy, as it may be vulnerable to:
  - Attacks reusing authenticated BASIC credentials or session data.
  - Although modern browsers offer protection, do not rely on them entirely.
  - HTTPS reverse proxies might bypass certain browser and Mirakurun safeguards, increasing risk → [Secure Contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts)
  - Instead, use VPN, SSH tunnels, or tunnel services.
    - Note: Some tunnel services require configuring `allowIPv4CidrRanges` to prevent third-party access.

> **DNS Rebinding Attack**: An attacker controls a domain and initially serves a legitimate site. After the DNS TTL expires, they switch it to point to their malicious server. This bypasses the browser’s same-origin policy and enables unauthorized access to a LAN server via the browser.

> **XSS/CSRF Attack**: An attacker embeds malicious code into a website to gain unauthorized access to a LAN server via the browser.

- Examples of attacks:
  - Execute arbitrary code via tuner commands
  - Inject malicious code into the server and turn it into a botnet
- The above are only a few examples; many others, exploiting browser or middleware vulnerabilities, are devised daily.
- With more web-based applications emerging, they can be as vulnerable to similar attacks as browsers. Exercise caution.

## 🗒️server.yml

📛 Partially supported in Web UI

### File Paths

- Environment Variable: `SERVER_CONFIG_PATH`
- Docker Host (Default): `/opt/mirakurun/config/server.yml`
- Linux (Legacy): `/usr/local/etc/mirakurun/server.yml`

### Server Settings List

| Property (🗒️server.yml) | Environment Variable (🐋Docker) | Type | Default | Description |
|------------|------------------|-------|-----------|------|
| `logLevel` | `LOG_LEVEL` | Integer | `2` | Log Level (`-1`: FATAL to `3`: DEBUG) |
| `maxLogHistory` | `MAX_LOG_HISTORY` | Integer | `1000` | Maximum number of log lines to retain |
| `path` | - | String, null | 🗒️`/var/run/mirakurun.sock` | Unix Socket Path **※Fixed to default in Docker** |
| `port` | - | Integer, null | `40772` | Server Port **※Fixed at `40772` on the container side in Docker** |
| `hostname` | `HOSTNAME` | String | `localhost` | Hostname |
| `disableIPv6` | - | Boolean | `false` | Disable IPv6 **※Always disabled in Docker** |
| `jobMaxRunning` | `JOB_MAX_RUNNING` | Integer | logical cores / 2, min 1, max 100 | Maximum number of jobs that can run simultaneously |
| `jobMaxStandby` | `JOB_MAX_STANDBY` | Integer | logical cores - 1, min 1, max 100 | Maximum number of jobs that can be prepared simultaneously |
| `maxBufferBytesBeforeReady` | `MAX_BUFFER_BYTES_BEFORE_READY` | Integer | `8388608` | Maximum buffer size before ready (bytes)<br>**※Increase if the beginning of the program is missing** |
| `eventEndTimeout` | `EVENT_END_TIMEOUT` | Integer | `1000` | Event end timeout (milliseconds)<br>**※Increase if program end is incorrectly detected** |
| `programGCJobSchedule` | `PROGRAM_GC_JOB_SCHEDULE` | String | `45 * * * *` | Program list GC schedule (cron-like format) |
| `programHistoryRetentionDays` | `PROGRAM_HISTORY_RETENTION_DAYS` | Positive integer | `365` | Days to retain EPG history and its revisions in SQLite |
| `epgGatheringJobSchedule` | `EPG_GATHERING_JOB_SCHEDULE` | String | `20,50 * * * *` | EPG gathering schedule (cron-like format) |
| `epgRetrievalTime` | `EPG_RETRIEVAL_TIME` | Integer | `600000` | EPG retrieval time (milliseconds) |
| `logoDataInterval` | `LOGO_DATA_INTERVAL` | Integer | `604800000` | Logo data update interval (milliseconds) |
| `tunerHandoff` | - | Object | `{ enabled: false, warmupMs: 0, maxBufferMs: 10000, switchMarginMs: 100, syncTimeoutMs: 5000 }` | Experimental tuner handoff settings for rebalancing occupied tuners with PCR-synchronized buffered switching |
| `disableEITParsing` | `DISABLE_EIT_PARSING` | Boolean | `false` | ⚠️Disable EIT parsing |
| `disableWebUI` | `DISABLE_WEB_UI` | Boolean | `false` | ⚠️Disable Web UI |
| `allowIPv4CidrRanges` | `ALLOW_IPV4_CIDR_RANGES` | String[] | `["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]` | ⚠️Allowed IPv4 CIDR blocks |
| `allowIPv6CidrRanges` | `ALLOW_IPV6_CIDR_RANGES` | String[] | `["fc00::/7"]` | ⚠️Allowed IPv6 CIDR blocks |
| `allowOrigins` | `ALLOW_ORIGINS` | String[] | `["https://mirakurun-secure-contexts-api.pages.dev"]` | ⚠️🧪Allowed origins (experimental) |
| `allowPNA` | `ALLOW_PNA` | Boolean | `true` | 🧪[PNA](https://github.com/WICG/private-network-access)/[LNA](https://github.com/explainers-by-googlers/local-network-access) permission settings (experimental) |
| `tsplayEndpoint` | `TSPLAY_ENDPOINT` | String | `https://mirakurun-secure-contexts-api.pages.dev/tsplay/` | 🧪TSPlay endpoint (experimental) |

## 🗒️tuners.yml

💯 Fully supported in Web UI

### File Path

- Environment Variable: `TUNERS_CONFIG_PATH`
- Docker Host (Default): `/opt/mirakurun/config/tuners.yml`
- Linux (Legacy): `/usr/local/etc/mirakurun/tuners.yml`

### Structure

```yaml
# Array
- name: TunerIdentificationName # String
  types: # (GR|GR-ALT|BS|CS|SKY|BS4K)[]
    - GR
    - GR-ALT
    - BS
    - CS
    - SKY
    - BS4K
  # For chardev/dvb
  # "<template>" will be replaced with `commandVars[template]` or "(empty)" *@4.0.0~
  command: cmd <channel> --arg1 --arg2 <exampleArg1> <exampleArg2>... # String
  # Optional command used only for BS4K. Falls back to `command` when omitted.
  commandBS4K: cmd-bs4k <channel> --arg1 --arg2 <exampleArg1> <exampleArg2>... # String
  # For dvb
  dvbDevicePath: /dev/dvb/adapter/dvr/path # String
  # Optional preflight path. If omitted, dvbDevicePath is checked when set.
  checkDevicePath: /dev/px4video0 # String
  # Seconds to skip this tuner after its command exits with failure. Defaults to 2.
  cooldownSeconds: 2 # Integer
  # For multiplexing with remote Mirakurun
  remoteMirakurunHost: 192.168.x.x # String
  remoteMirakurunPort: 40772 # Integer
  remoteMirakurunDecoder: false # Boolean
  # Allow the upstream Mirakurun to select another remote tuner. Default: false.
  remoteMirakurunAllowNested: false # Boolean
  # Optional parameters below
  decoder: cmd # String
  mmtsDecoder: cmd # String
  isDisabled: false # Boolean
```

#### group

`group` optionally names a shared reception source, for example `puniru-sat`
or `j-sat`. Give tuners using the same antenna/site the same group, including
BS, CS and BS4K slots. Separate independent reception paths into different groups.
Without a name, local tuners share a group per delivery route (`SAT`, `TER`,
`CATV`, `HIKARI`); remote tuners share a group per host, port and delivery route.
Local paths retain their normal preference over remote paths.

If one tuner fails acquisition or stops producing source bytes, new acquisitions
skip its reception group for 30 seconds and try the next eligible group. A busy
tuner, client cancellation, preemption or decoder/output failure does not mark
the reception group unhealthy. Existing streams still delivering data can be
shared. After cooldown, only one acquisition probes the failed group; other
requests keep using alternatives until 30 seconds of continuous input confirms
recovery. Group failover respects channel restrictions and local-only requests.
If the probing tuner is released before this validation completes, its probe
lease and timer are retired with that tuner release. A normal channel change
does not keep idle tuners unavailable for the remainder of the validation
window, and it does not count as a new reception failure.
For foreground viewing, failure cooldown and recovery observation are soft
preferences: try all eligible healthy routes first, then allow an otherwise
usable tuner when those preferences would leave no candidate. This follows
actual available capacity rather than a configured tuner-count threshold.
Each tuner/channel is attempted at most once per acquisition request. Device
release, exclusive frontend leases, channel restrictions and user priorities
still apply. Background jobs continue to respect failure cooldowns.
It requires another group that can receive the requested channel and format;
a BS-only backup cannot receive BS4K.

Both local and remote acquisitions wait up to five seconds for source data.
An active source that sends no data for five seconds is released and its users
are ended so consumers can reconnect through another group. This is source
availability detection, not a guarantee of seamless switching or RF quality
measurement while bytes continue arriving.

#### decoder

Specify the CAS processing command as needed.

#### commandBS4K / mmtsDecoder

When a tuner supports `BS4K` together with `BS` / `CS`, specify `commandBS4K` to use a dedicated command for `BS4K` channels. If `commandBS4K` is omitted, `command` is used. Specify `mmtsDecoder` when the `BS4K` command output needs MMTS conversion.

#### Optional DVB frontend selection

Set `dvbAutoDiscovery: true` to let Mirakurun select a Linux DVB frontend for this tuner entry. Leave `dvbFrontendPath` empty for automatic selection, or set it to `/dev/dvb/adapterN/frontendM` to pin the entry to that frontend. Existing command, remote, and `dvbDevicePath` configurations keep their behavior when this mode is off.

At startup Mirakurun enumerates `/dev/dvb/adapter*/frontend*` and runs `dvb-fe-tool -a N -f M` from v4l-utils with the C locale. This read-only query obtains the driver's supported delivery systems (`DTV_ENUM_DELSYS` on DVBv5). Install `dvb-fe-tool` in the server/container PATH and expose the DVB device nodes. Missing tools, permission errors, unsupported systems, or missing devices leave affected entries unselectable and produce a server log; other tuners remain usable. Restart after adding devices or changing drivers. Initial configuration generation creates one slot per adapter and, as before, prefers the terrestrial channel file when an adapter supports both terrestrial and satellite reception; configure the other reception family explicitly when needed.

Each configured entry provides one simultaneous tuning slot. On each tune, Mirakurun leases a compatible free frontend, injects `<dvbFrontendPath>`, `<dvbAdapter>` and `<dvbFrontend>` into the command, and holds the lease until the command has stopped and the stream is released. The command must contain either `<dvbFrontendPath>` or both `<dvbAdapter>` and `<dvbFrontend>`, including `commandBS4K` when set. Channel variables cannot override these device selections. Normal channel restrictions, priorities, stream sharing, cooldown and failover still apply.

Driver capabilities select ISDB-T for GR/GR-ALT, ISDB-S for satellite BS/CS, DVB-S/S2 for SKY, and ISDB-S3 for satellite BS4K. CATV/HIKARI BS/CS/BS4K require ISDB-C. ISDB-S or DVB-S2 alone never implies BS4K support. The command and its channel configuration remain responsible for tuning parameters and output format.

For safety, all frontends in one adapter share one lease: multiple frontend nodes can represent mutually exclusive modes sharing a demux/DVR. This mode does not infer independent capture pipelines inside one adapter. Pinned frontend entries reserve their adapter even while idle. Enabled legacy entries with `dvbDevicePath`, `checkDevicePath`, a literal DVB path in their command, or a direct `dvbv5-zap -a N` command reserve that adapter from automatic use. For an opaque wrapper command, set `checkDevicePath` to its DVB frontend so the reservation is explicit. Disabled and remote entries do not reserve local devices.

Prefer commands that output the stream on stdout, for example:

```yaml
- name: DVB-GR-1
  types: [GR]
  dvbAutoDiscovery: true
  # Optional: dvbFrontendPath: /dev/dvb/adapter0/frontend0
  command: dvbv5-zap -a <dvbAdapter> -f <dvbFrontend> -c /etc/mirakurun/dvbv5-gr.conf -r -P -o - <channel>
```

`dvbDevicePath` retains its existing meaning as a separate DVR read path. When combined with frontend selection it must be `/dev/dvb/adapterN/dvr0` and requires a pinned frontend in the same adapter; it cannot remain fixed while the frontend moves automatically.

The configuration UI keeps the frontend selector and path field in fixed slots when toggled; disabling selection disables the path field and clears the pin. Empty path visibly means automatic selection. At narrow widths the tuner rows reflow into full-width options with wrapped type choices; all fields and row actions remain visible. Invalid configuration disables Save and shows its reason; a failed HTTP save preserves the draft and offers saving again. Saving and reloading must preserve both modes; editing the path must retain focus.

Acceptance: cover driver capability parsing (including misleading device names and the current system), nonzero probe exits and missing tools, mixed dedicated/hybrid frontends, automatic and pinned selection, legacy reservations, competing entries, lease release on exit/spawn failure, command substitution, and legacy stdout behavior. Request the real configuration and tuner HTTP entry points; hardware acceptance additionally requires Linux DVB enumeration and concurrent real reception, which simulated frontends cannot prove.

#### checkDevicePath

Specify a device path that must exist before this tuner can be started. If the path is missing, Mirakurun skips this tuner and tries the next matching tuner. When `checkDevicePath` is omitted, `dvbDevicePath` is used as the preflight path if it is set.

#### cooldownSeconds

Specify seconds to skip this tuner after its command exits with failure. When omitted, it defaults to `2`. Set `0` to disable cooldown.

#### remoteMirakurunAllowNested

Allows the upstream Mirakurun to select another remote tuner. The default is `false`, so only local tuners on the upstream Mirakurun are eligible. Set this to `true` only when a multi-hop remote tuner topology is intentional.

```
# Reference: MPEG-2 TS flow
+-------------+    +----------+    +---------+    +--------+
| TunerDevice | -> | TSFilter | -> | decoder | -> | (user) |
+-------------+    +----------+    +---------+    +--------+
               RAW           STRIPPED      DESCRAMBLED
```

```sh
# This is an implementation example. For testing only.
sudo npm install arib-b25-stream-test -g --unsafe-perm
```

## 🗒️channels.yml

💯 Fully supported in Web UI

### File Path

- Environment Variable: `CHANNELS_CONFIG_PATH`
- Docker Host (Default): `/opt/mirakurun/config/channels.yml`
- Linux (Legacy): `/usr/local/etc/mirakurun/channels.yml`

### Structure

```yaml
# Array
- name: ChannelIdentificationName # String
  type: GR # Enum [GR|GR-ALT|BS|CS|SKY|BS4K]
  channel: '0' # String
  # Optional parameters below
  serviceId: 1234 # Integer - Services will be automatically scanned if not specified.
  tsmfRelTs: 1 # Number: 1~15
  commandVars: # Optional command variables *@4.0.0~
    satellite: EXAMPLE-SAT4A
    space: 0
    freq: 12345
    polarity: H
    exampleArg1: -arg0 -arg1=example
    exampleArg2: -arg2 "Can include spaces using quotes"
  allowedTuners: # Optional tuner name list. If omitted, any matching tuner can be used.
    - Tuner-1
  isDisabled: false # Boolean
```
