# Troubleshooting

## Confirm that Pi selected the extension

Pi selects an extension stream only when the model's resolved API matches the
API registered by the extension. `pi-xai-ws` registers
`openai-responses` for the built-in `xai` provider.

If Grok works but this package does not log any socket activity, inspect the
resolved model. It should report:

```text
provider: xai
api: openai-responses
```

Pi's current remote catalog uses that API for `xai/grok-4.6`, while Pi 0.84.2's
bundled xAI catalog labels the same model `openai-completions`. If a catalog
refresh fails and Pi uses that bundled definition, it will not select this
transport. Update Pi or refresh its model catalog rather than registering this
extension against the wrong API.

Another extension can also replace the xAI provider registration. In
particular, passing a `models` property to `registerProvider("xai", ...)`
replaces Pi's built-in xAI model catalog.

## Enable debug logging

Set `PI_XAI_WS_DEBUG=1` before starting Pi:

```sh
PI_XAI_WS_DEBUG=1 pi
```

The extension writes concise diagnostics to stderr. They include socket opens,
closes, rotations, request mode, input-item counts, and pre-output recovery.
They do not include credentials, request content, generated text, reasoning, or
tool arguments.

A healthy default two-turn session should normally show one socket open and two
`mode=full` requests. The second request should have more input items because it
contains the expanded local history. Stored mode normally shows one initial
`mode=full` request followed by `mode=continue` requests until a recovery or
stored-context safety downgrade occurs.

## Stored-response config is not taking effect

The global config is `getAgentDir()/pi-xai-ws.json`, normally
`~/.pi/agent/pi-xai-ws.json`. Its opt-in value must be the JSON boolean `true`:

```json
{
  "storeResponses": true
}
```

The strings `"true"` and `"1"` do not enable storage. A defined
`PI_XAI_WS_STORE` overrides the file, so an inherited empty value, `0`, or
`false` forces storage off. With `PI_XAI_WS_DEBUG=1`, an unreadable or malformed
file emits a sanitized diagnostic and remains off. Calls without a persistent
Pi session ID remain `store: false` regardless of configuration.

## Response is too large to store

xAI may reject a long stored response after it has already streamed model
output:

```text
Response is too large to store. You can avoid this error by setting `store` to false in your request.
```

Version 0.5.1 and earlier can surface this as a failed Pi turn. Set
`PI_XAI_WS_STORE=0` or change the global config to `"storeResponses": false`
before retrying. That uses complete local history and avoids provider storage.
Compact the thread to reduce its context before re-enabling stored mode.

Newer package versions prevent the known failure path. At an estimated 220,000
stored-conversation tokens by default, the extension warns once, clears the stored
chain, and switches to full-history `store: false` requests until compaction
reduces the context. The estimate is the conversation xAI would store: reliable provider usage plus
trailing messages, including a large tool result added since the previous
response. It does not use unsliced full-history JSON, which is larger than the
stored object during continuation. Configure the boundary with
`maxStoredContextTokens` in the global package config or a valid
`PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS`. Debug logs show
`storage disabled for oversized context` when the guard activates.

## Authentication failures

The extension reuses the xAI credential Pi passes to provider streams. For the
intended setup, authenticate Pi with SuperGrok OAuth first. The package does not
run a separate xAI login flow.

If the extension reports `No API key for provider: xai`, verify that Pi has a
current xAI OAuth record and that the selected model belongs to the `xai`
provider. Restart Pi after repairing or refreshing the credential.

Do not put credentials in `PI_XAI_WS_URL`. That setting contains only the
WebSocket endpoint.

## Custom xAI endpoints and proxies

By default, the WebSocket URL is derived from `model.baseUrl` when the host is
xAI. The extension rejects a non-xAI HTTP base URL unless
`PI_XAI_WS_URL` explicitly names the matching WebSocket endpoint. This guard
prevents proxy credentials from being sent to public xAI by accident.

For a custom endpoint, configure both sides consistently:

```sh
PI_XAI_WS_URL=wss://proxy.example.test/v1/responses pi
```

Changing the URL, headers, or liveness settings changes the transport identity.
The next request closes the retained socket and opens one with the new values.

## Liveness failures

The default healthcheck sends a protocol ping after 15 seconds without an
inbound frame and follows Pi's configured stream-idle timeout, normally 300
seconds total. The transport also enables TCP keepalive with a 15-second initial
delay to detect broken network paths independently of WebSocket control-frame
handling.

Set `PI_XAI_WS_LIVENESS_TIMEOUT_MS` only when the post-ping window needs an
explicit transport override. Avoid shortening it below normal model startup or
buffered function-call time. xAI documents streamed function calls as one whole
chunk, so a healthy Grok request can remain silent while generating its
arguments.

If a dead connection answers WebSocket pings but its request worker has stopped,
the transport cannot distinguish it from a live connection. Apply a turn-level
timeout outside this extension when a strict deadline is required.

## Connection rotation

A log entry for `request age` or `max age` is normal. The extension rotates
before xAI's 25-minute connection limit and does not start new requests after
75 percent of the configured maximum age. Maximum age is a hard boundary: an
active request is interrupted so Pi can retry it on a fresh socket rather than
letting xAI terminate the generation one minute later.

Frequent unexpected rotations usually mean one of these values changes between
calls:

- Authorization or another upgrade header
- WebSocket URL
- Connection timeout
- Ping interval
- Liveness timeout

## Replay and duplicate-work concerns

A request can retry once only after a connection, socket, liveness, or explicit
xAI WebSocket connection-limit failure before model output.

The extension does not retry malformed frames, queue overflows, local payload
limits, aborts, or failures after output starts. Reasoning summaries, refusals,
function-call arguments, custom-tool input, and provider-tool lifecycle events
all count as output. Pi may separately start a new assistant attempt when its
configured retry policy classifies the reported error as transient. Failed and
aborted assistant attempts remain visible in Pi's session log but are excluded
from future xAI request context.

With stored continuation enabled, xAI may reuse one response ID for multiple
successful calls on the same socket. That ID advances the socket-local head but
may rehydrate only its first stored response after reconnecting. A pre-output
retry therefore resumes from the durable checkpoint and includes every locally
recorded item since it. Resending only the newest tool result against the
repeated ID can make xAI repeat an earlier tool call.

If xAI returns `Response with id=... not found`, the extension forgets the
reference and retries complete local history once. A second rejection is
reported instead of creating an unbounded fallback loop.

## Queue and payload-limit failures

The extension fails rather than accumulating unbounded data when any of these
limits is reached:

- 4 MiB inbound frame
- 4,096 parsed events waiting for Pi
- 8 MiB of parsed events waiting for Pi
- 64 requests waiting in one session

A request backlog usually means callers are issuing overlapping model calls for
the same Pi session. Allow the active stream to settle or abort obsolete queued
calls.

The pool intentionally does not evict durable checkpoints by count. A
long-lived process that stores responses for many distinct session IDs retains
their checkpoint metadata in RAM until process exit or explicit pool disposal,
and on disk under `pi-xai-ws/continuations/` until the session jsonl is gone or
the checkpoint is older than 30 days. Each
checkpoint keeps a response ID, covered item count, and SHA-256 digest rather
than conversation content. This avoids silently replacing continuation with a
full-context replay without retaining a second copy of the covered input.
Sessions without a durable checkpoint may be removed when an aborted or failed
request leaves them without a socket.

## Existing threads and uninstalling

The package writes Responses-shaped assistant history with
`api: "openai-responses"`. Existing threads remain compatible while the package
is installed.

Start a new Pi session after uninstalling the package or switching the same
model to an `openai-completions` transport. This avoids asking another transport
to reinterpret encrypted Responses reasoning and Responses-specific history.

## Grok stopped after thinking only

If a Grok turn is already in a tool loop and the next assistant message is only
a completed reasoning summary, Pi treats `stop` with no tools as the end of the
run. This package queues one hidden same-run steer so the model continues. The
first assistant of a run is not nudged, and the recovery fires at most once per
`agent_start`.

With `PI_XAI_WS_DEBUG=1`, a successful queue logs
`empty-thinking nudge queued deliverAs=steer`. In T3 RPC mode the same recovery
can appear as a `notify` activity row. A test-only latch,
`PI_XAI_WS_TEST_NUDGE=1` or `getAgentDir()/pi-xai-ws.test-nudge`, treats any
mid-loop no-tool stop as that case. Do not leave the latch enabled.

## Grok output became repetitive

The extension checks xAI thinking and visible prose for exact repetition,
near-duplicate blocks with changing counters or timestamps, and very low
novelty in long thinking. It excludes fenced code. On the first detection it
aborts the response, records only bounded clean context, warns through Pi's UI,
and starts compaction before one hidden recovery turn.

A second recurrence within ten minutes is stopped without another compaction.
If Pi reports that the session is already compacted or too small to compact, the
extension continues directly because the aborted assistant is already excluded
from xAI context. Other compaction failures are reported without a retry. This
is intentional protection against an automatic recovery loop.

The long-output backstop defaults to 85 percent repeated word 5-grams. Set a
ratio above zero and at most one as `loopNoveltyThreshold` in the global config
or `PI_XAI_WS_LOOP_NOVELTY_THRESHOLD`. Increase it if legitimate long reasoning
triggers the backstop. Debug logs report detector metadata but never generated
content.

## Package load failures

Pi supplies `@earendil-works/pi-ai` and
`@earendil-works/pi-coding-agent` as extension peer dependencies. A package
manager may report them as unmet when inspecting the extension's private npm
installation even though Pi supplies them at load time.

A real startup failure usually includes an extension import error. Confirm that
the package contains `src/pi-ai-api.ts` and that the installed Pi version is
0.84 or newer. Direct `@earendil-works/pi-ai/api/...` runtime imports do not work
from Pi's CJS extension loader: those exports have no `require` condition, and
they are not on the aliased `/compat` module. The package loads `dist/api` files
from the host CLI's node_modules instead.
