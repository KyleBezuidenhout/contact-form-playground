# form-sim

No-captcha, multi-subdomain **form fixtures**. Zero dependencies — just Node. A dev fixture, *not* the
measured rig.

**Current scope — land-first.** The goal right now is simple: confirm we **read + submit + land on the
majority of real forms**. So the active variants vary only along the axes that decide whether we can find and
fill a form:

1. **Rendering** — static, JS-late, SPA, shadow DOM, iframe, wizard, etc.
2. **Field / header names** — normal, mixed `id`/`name`/`aria-label`, framework-style (`contact[email]`, `wpcf7-message`).
3. **Hidden fields** — honeypots + legit hidden inputs (`_token`, `form_id`).
4. **Message-field presence** — has a real message box, a too-short one, or none at all.

Everything submits and **lands**. The confirmation / **false-positive** trap variants are built but **parked**
behind a flag (`FP=1`) — we're not fighting that war yet. See *False-positive mode* below.

## Run

```bash
node form-sim/server.js
```

- Index of every variant: **http://localhost:8080**
- Landing ledger (what actually arrived): **http://inbox.localhost:8080**

Each variant is a **subdomain** of `localhost` (Chrome/Chromium resolve `*.localhost` to 127.0.0.1
automatically). Change the port with `PORT=9000 node form-sim/server.js`.

> ⚠️ **Proxies:** `*.localhost` / `127.0.0.1` are **not reachable through an upstream proxy** (the proxy
> resolves loopback to *itself*). Run these **proxy-off**. To test with the proxy in the path, expose the
> server publicly (`cloudflared tunnel --url http://localhost:8080` or `ngrok http 8080`) or deploy to the
> real VPS + `*.lab.<domain>` wildcard.

---

## Variants (land-first default)

### Rendering / field-selection
| Subdomain | What it exercises |
|---|---|
| `static` | baseline native POST + redirect |
| `extended` | every input type, mixed `id`/`name`/`aria-label` naming |
| `oddnames` | framework-style names: `contact[name]`, `contact[email]`, `wpcf7-message` |
| `shuffled` | odd DOM order, labels after inputs, css-hidden honeypot `website2` |
| `hiddenfields` | hidden `_token` + `form_id` to preserve, hidden honeypot `confirm_email` to leave empty |
| `inline` | fetch submit, form replaced in place, no nav |
| `toast` | aria-live confirmation, no nav |
| `jslate` | form injected ~900ms after load (render wait) |
| `ajax` | XHR submit, JSON response |
| `spa` | form only exists at `#/contact` |
| `multistep` | 3-step wizard, fields revealed progressively |
| `shadow` | fields inside a web-component shadow root |
| `iframe` | fields inside a same-origin iframe |
| `weird` | contenteditable "fields", inputs outside `<form>`, div button |
| `mailto` | no form; JS-assembled address (no-form fallback) |

### Message-gate (skip if there's no room for the message)
| Subdomain | Problem |
|---|---|
| `no-message` | name + email only, **no message field** (the GSA-v1 case) |
| `short-only` | single-line message input, `maxlength=40` → truncated |
| `subject-only` | subject line but **no message body** |

---

## The inbox (what landed + how well we read the form)

Every `/submit` is recorded to `_ledger.jsonl` and shown at **http://inbox.localhost:8080**:

- 🟢 **green** — landed, full message read
- 🟠 **amber** — landed, but **no/short message** OR a **hidden field got filled** (honeypot tripped)
- 🔴 **red** — dropped (only happens in FP mode)

So after a run you can see, per variant: did we land, did our message arrive intact, and did we wrongly fill a
hidden/honeypot field. Raw/JSON access (any host): `GET /_truth`, `GET /_truth?t=TOKEN`, `GET /_ledger.jsonl`,
`GET /_reset` (clear).

### Tokens (to match a submission to your own record)

Every `/submit` is assigned a stable id and returned to you three ways — the **`X-Sim-Id`** response header, an
**`id`** field in JSON, and on the thanks page — so a black-box submitter correlates without cooperating. Query
it with `/_truth?t=<id>`, or just `GET /_truth?latest=1` after a single submit. To set your own id instead, use
`?t=<token>`, a `token`/`ref` field, or **any value containing `TK-xxxx`** (3+ chars after the dash) in the body.

### The message-gate rule (engine side)

> **Only fill + submit if a field can carry the full message** — a `<textarea>` (or an unrestricted text input)
> whose name/id/placeholder/label matches `message|comment|enquiry|inquiry|details|body|question`. If none
> exists, **skip** and record `NO_MESSAGE_FIELD`. A `maxlength` shorter than your message = same skip.

A correct engine produces **zero** rows for `no-message` / `short-only` / `subject-only`. Any amber row there =
the gate leaked.

---

## Ground truth — the important bit

**You can never read ground truth off a site you don't own; the confirmation page is the thing that lies.** The
only real signal is a per-submission **token** that shows up at **a sink you control**:

```
fixture:    submit (token TK-xxx) → GET /_truth?t=TK-xxx            ← we own the server
real site:  submit (token TK-xxx) → did TK-xxx hit MY catch-all inbox?   ← we own the mailbox
```

Same mechanism; on real sites the sink just moves to a mailbox you own (Postmark inbound + token). This is why
form-sim's `/_truth`+inbox is the local rehearsal of the real contract. Full writeup: `AGENT-HANDOFF.md §11`.
Three tiers of real-site testability: (1) our own forms on real infra — full truth; (2) real vendor forms
delivering to our inbox — full truth; (3) arbitrary wild sites — **no truth possible**, heuristics only.

---

## False-positive mode (parked — enable later)

When you're ready to test confirmation handling / false-positive detection:

```bash
FP=1 node form-sim/server.js
```

This adds a **confirm** group where the page *looks* successful but often isn't: `ok-real`, `fake-thanks`,
`silent-200`, `honeypot-eaten`, `spam-eaten`, `js-lies`, `redirect-generic`, `validation-masked`, `delayed`,
`double-submit`. You submit with a token, read the page, emit your verdict, then `GET /_truth?t=TOKEN` and diff
verdict vs reality — mismatch = a false positive your engine missed. Off by default.

## Notes / limits

- No captchas, no WAF — intentionally. This isolates render + field-selection (+ FP detection under `FP=1`).
- No file uploads (multipart not parsed). urlencoded + JSON bodies only.
- `_ledger.jsonl` persists across restarts; delete it or `GET /_reset` to start clean.
- Real subdomains later: point `*.yourdomain` at the host, keep the same keys, run behind nginx (host-routing
  already keys off the left-most `Host` label).
