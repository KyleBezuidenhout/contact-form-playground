# form-sim — Agent Guide

**A local, zero-dependency harness for testing automated contact-form submitters on this Mac.**
Hand this file to any agent. It is self-contained: everything needed to run form-sim and test a form-submission
tool against every kind of real-world form shape is below.

---

## 1. What this is and why it exists

`form-sim` is a single Node server that serves **many different contact forms**, each on its own subdomain, so
you can point a form-submitting tool (a crawler, a bot, GSA Website Contact, a native submitter) at them and
measure **two things**:

1. **Did it read the form correctly?** — find the right fields, wait for JS-rendered forms, step into shadow
   DOM / iframes, handle odd field names, and *not* fill hidden honeypot fields.
2. **Did it actually land?** — every submission is recorded to a **ground-truth ledger** (an inbox you own),
   independent of whatever "thanks" page the form shows. This is the part real sites can't give you honestly.

The goal of the **default mode is "land-first"**: confirm the tool reads + submits + lands on the *majority* of
real forms. The variants therefore vary along the four axes that decide whether a form can be filled at all:
**rendering**, **field/header names**, **hidden fields**, and **message-field presence**.

> It is a **dev fixture, not a production measurement rig.** No captchas, no WAF — on purpose. It isolates
> render + field-selection + landing.

---

## 2. Run it

Requires only Node (any recent version). No `npm install`.

```bash
node "/Users/kylebezuidenhout/Desktop/Contact Form/form-sim/server.js"
```

- **Index of every form:** http://localhost:8080
- **Landing ledger (what actually arrived):** http://inbox.localhost:8080

Each form is a **subdomain of `localhost`** — Chrome/Chromium (and most resolvers) send `*.localhost` to
`127.0.0.1` automatically, so no `/etc/hosts` edits. Example: http://shadow.localhost:8080

Options:
- Different port: `PORT=9000 node ".../form-sim/server.js"` (then use `*.localhost:9000`).
- Enable the false-positive traps (advanced, see §6): `FP=1 node ".../form-sim/server.js"`.

> ⚠️ **If your tool routes through a proxy:** `localhost` / `127.0.0.1` are **not reachable through an upstream
> proxy** (the proxy resolves loopback to *itself*). Run form-sim tests **with the proxy off**. To test with a
> proxy/IP-grade in the path, expose the server publicly first: `cloudflared tunnel --url http://localhost:8080`
> or `ngrok http 8080`, then hit the public URL.

---

## 3. The forms (what each one tests)

Open the index for the live list. Default (land-first) variants, each at `<name>.localhost:8080`:

### Rendering / field-selection
| Variant | Tests whether you can… |
|---|---|
| `static` | handle a plain server-rendered form (baseline) |
| `extended` | map every input type with mixed `id` / `name` / `aria-label` naming |
| `oddnames` | handle framework names: `contact[name]`, `contact[email]`, `wpcf7-message` |
| `shuffled` | cope with odd DOM order, labels after inputs, and a hidden honeypot `website2` |
| `hiddenfields` | preserve legit hidden inputs (`_token`, `form_id`) and **not** fill honeypot `confirm_email` |
| `inline` | detect success when the form is replaced in place via `fetch` (no navigation) |
| `toast` | detect an aria-live toast confirmation (no navigation) |
| `jslate` | **wait** for a form injected by JS ~900ms after load |
| `ajax` | handle an XHR submit with a JSON response |
| `spa` | navigate a hash route — the form only exists at `#/contact` |
| `multistep` | traverse a 3-step wizard before the message field appears |
| `shadow` | reach fields inside an open **shadow DOM** web component |
| `iframe` | step into a same-origin iframe to reach the fields |
| `weird` | handle non-semantic forms: contenteditable "fields", inputs outside `<form>`, a div button |
| `mailto` | handle the no-form fallback (a JS-assembled `mailto:` address) |

### Message-gate (should you even submit?)
| Variant | The trap |
|---|---|
| `no-message` | name + email only — **no message field at all** (your pitch has nowhere to go) |
| `short-only` | the only message field is a single line, `maxlength=40` — your message gets truncated |
| `subject-only` | a subject line but **no message body** |

**Correct behavior:** a good tool **skips** `no-message` / `short-only` / `subject-only` — do not submit if
there is no field that can carry the full message (see §5).

---

## 4. How to test a submission and read ground truth

Every form POSTs to `/submit`. The server records the real outcome to a ledger regardless of what the page says.

**Step by step:**
1. **You don't need to cooperate for correlation.** Every `/submit` is assigned a stable id and handed back to
   you three ways, so a black-box submitter still correlates:
   - the **`X-Sim-Id`** response header,
   - an **`id`** field in the JSON response,
   - printed on the HTML **thanks page** (`submission id sim-…`).
   Grab it and query `/_truth?t=<id>`. Testing one submit at a time? Just `GET /_truth?latest=1` right after.
   If you *want* to set your own id, embed `TK-XXXXXX` (3+ chars after the dash) in the message body, or pass
   `?t=TOKEN` on the submit URL.
2. Point your tool at a variant (e.g. `http://jslate.localhost:8080`), let it find + fill + submit the form.
3. Check the result two ways:
   - **Inbox** — open http://inbox.localhost:8080 (auto-refreshes). Each row shows:
     🟢 landed (full message read) · 🟠 landed but no/short message **or** a hidden field was filled ·
     🔴 dropped (only in FP mode).
   - **API** — `GET http://localhost:8080/_truth?t=TK-9f2a7c` returns JSON:
     `{ "found": true, "landed": true, "entries": [ … fields, msg_len, honeypot … ] }`. Also `GET /_truth?latest=1`
     returns the most recent submission; `?id=<id>` is an alias for `?t=`.

**What to look for:**
- `landed: true` + your full message present = you read and submitted the form correctly.
- `honeypot: true` = your tool filled a hidden trap field (on a real site this would get you silently binned).
- `full_message: false` = the message didn't arrive intact (empty or truncated) — usually a message-gate miss.

Useful endpoints (any host): `GET /_truth` (all), `GET /_truth?t=TOKEN` (one), `GET /_ledger.jsonl` (raw),
`GET /_reset` (clear the ledger to start a clean run).

---

## 5. The message-gate rule (for the submitting tool)

The single most common wasted send: submitting to a form that can't carry your message (the "no message block"
case). Rule to implement in the tool:

> **Only fill + submit if a field can carry the full message** — a `<textarea>`, or a text input with no
> restrictive `maxlength`, whose name/id/placeholder/label matches
> `message|comment|enquiry|inquiry|details|body|question`. If none exists, **skip** and record
> `NO_MESSAGE_FIELD`. Treat a `maxlength` shorter than your message as the same skip.

A correct tool produces **zero** ledger rows for `no-message` / `short-only` / `subject-only`.

---

## 6. False-positive mode (advanced — off by default)

Real forms lie: they show "Thanks, message sent" and silently drop it. Testing whether a tool **detects** that
is a separate, harder job. It's built but **parked** so the default stays simple. Enable it:

```bash
FP=1 node "/Users/kylebezuidenhout/Desktop/Contact Form/form-sim/server.js"
```

This adds a **confirm** group where the page looks successful but often isn't: `ok-real` (honest control),
`fake-thanks`, `silent-200`, `honeypot-eaten`, `spam-eaten`, `js-lies`, `redirect-generic`, `validation-masked`,
`delayed`, `double-submit`. To score a false-positive detector: submit with a token, read the page, emit your
own verdict (landed / not), then `GET /_truth?t=TOKEN` and diff your verdict against reality. A mismatch where
you said "landed" but truth is dropped = a false positive — the thing you're hunting.

---

## 7. Ground truth — the one rule that matters

**You can never read ground truth off a form you don't own; its confirmation page is exactly the thing that
lies.** The only honest signal is a per-submission **token** that shows up at **a sink you control**:

```
this harness:   submit (token TK-xxx) → GET /_truth?t=TK-xxx           ← you own the server
a real site:    submit (token TK-xxx) → did TK-xxx hit YOUR inbox?      ← you own the mailbox
```

Same mechanism; on real sites the sink just moves to a catch-all mailbox you own. So:
- **Your own test forms on real infra**, or **real vendor forms (Tally/Google/HubSpot/etc.) delivering to your
  inbox** → fully measurable.
- **Arbitrary third-party sites that deliver to someone else's inbox** → **no ground truth is possible.** Only
  heuristics. Calibrate your tool's false-positive rate on the measurable cases and assume it carries over.

form-sim's `/_truth` + inbox is the **local rehearsal** of that contract — prove your tool here before paying
for real infra and mailboxes.

---

## 8. Troubleshooting

- **`*.localhost` won't resolve** (rare, non-Chromium clients): add `127.0.0.1 shadow.localhost` to
  `/etc/hosts`, or just use the bare index at `localhost:8080` and the variant's path isn't enough — subdomains
  are required for routing, so prefer a Chromium-based browser / HTTP client that resolves `*.localhost`.
- **Port already in use:** run with `PORT=9001 node ".../server.js"`.
- **Ledger looks stale:** `curl http://localhost:8080/_reset` (or delete `form-sim/_ledger.jsonl`).
- **Correlating a submit:** read the `X-Sim-Id` header / JSON `id` the submit returns, or `GET /_truth?latest=1`
  right after. A custom `TK-` token needs 3+ chars after the dash (e.g. `TK-abc`, not `TK-a1`).
- **Testing through a proxy fails on every form:** expected — see the proxy note in §2. Run proxy-off or tunnel.

---

*File: `form-sim/server.js` (the harness) · `form-sim/README.md` (dev notes) · this guide is the shareable one.*
