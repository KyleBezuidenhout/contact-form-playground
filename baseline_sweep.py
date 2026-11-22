#!/usr/bin/env python3
"""Baseline sweep: drive the real engine (gsa_clone.sender.send_lead) over every
form-sim variant and score outcomes against the fixture's expectation.

Fixture: https://testform.net
- static form served at /<name>.html (works without wildcard DNS); the score
  reads the embedded _sim_variant, so no subdomain needed.
- fp/trap variants lived at /fp.<name>.html.
- ground truth: GET https://inbox.testform.net/_truth?latest=1 after each send.

Ground truth is read over the wire with the SAME engine Client, so scored success
means the engine truly landed (fixture ledger landed:true), not just a 2xx.

Usage:
  python baseline_sweep.py                # all LAND/SKIP variants, static path
  python baseline_sweep.py --fp           # trap-mode pages instead
  python baseline_sweep.py --only static,gravity,recaptcha-v2
  python baseline_sweep.py --base https://testform.net --www https://www.testform.net
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

# engine is a sibling package: ../../gsa_clone  (this file lives in form-sim/)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gsa_clone"))

from gsa_clone import wire, status  # noqa: E402
from gsa_clone import sender as eng  # noqa: E402

IDENTITY = {"first": "Kyle", "last": "Bezuidenhout", "name": "Kyle Bezuidenhout",
            "email": "kyle@example-sender.test", "phone": "+27821234567"}
MESSAGE = "Hi — quick note from a fellow business owner about how we can help. Reply if keen."

# variant -> proven captcha kind (spec/simulator-dispatch.json captcha_response_fields)
CAPTCHA_KIND = {"recaptcha-v2": "recaptcha_v2_v3", "recaptcha-v3": "recaptcha_v2_v3",
                "hcaptcha": "hcaptcha", "turnstile": "cloudflare_turnstile"}


def truth_token(client, www: str, token: str):
    """Ground truth for THIS send, correlated by the unique token (host-agnostic)."""
    try:
        r = client.get(www + "/_truth?t=" + token)
        if r.status == 200:
            d = json.loads(r.body.decode("utf-8", "replace"))
            return d.get("landed"), (d.get("entries") or [None])[-1]
    except Exception:
        pass
    return False, None


def score(variant: str, expect: str, send_ok: bool, landed: bool) -> str:
    """PASS iff the fixture truth confirms the send truly landed."""
    return "PASS" if landed else "FAIL"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://testform.net", help="fixture apex (static file host)")
    ap.add_argument("--www", default="https://www.testform.net", help="host serving /_truth")
    ap.add_argument("--fp", action="store_true", help="use fp.<name>.html trap pages")
    ap.add_argument("--only", default="", help="comma list of variant names")
    ap.add_argument("--no-captcha", action="store_true", help="skip SOLVE variants")
    args = ap.parse_args()

    catalog = json.loads(wire.Client().get(args.base + "/_catalog").body.decode())
    variants = [v for v in catalog["variants"] if v["group"] != "confirm" or args.fp]
    if args.only:
        want = {x.strip() for x in args.only.split(",")}
        variants = [v for v in variants if v["name"] in want]
    if args.no_captcha:
        variants = [v for v in variants if v["expect"] != "SOLVE"]

    results = []
    with wire.Client() as client:
        for v in variants:
            name, expect = v["name"], v["expect"]
            page_url = args.base + ("/fp." if args.fp else "/") + name + ".html"
            token = "TK-" + uuid.uuid4().hex[:8]
            msg = f"{MESSAGE} {token}"
            try:
                cap = None
                if expect == "SOLVE":
                    cap = {CAPTCHA_KIND.get(name, "recaptcha_v2_v3"): "03AOLTBLR" + "x" * 40}
                res = eng.send_lead(page_url, client, identity=IDENTITY, message=msg, captcha=cap)
                send_ok = res.sent
                detail = res.detail
            except Exception as exc:  # engine blew up on this shape
                send_ok, detail = False, f"EXC {type(exc).__name__}: {exc}"
            time.sleep(0.4)
            landed, entry = truth_token(client, args.www, token)
            verdict = score(name, expect, send_ok, landed)
            results.append({"variant": name, "group": v["group"], "expect": expect,
                            "engine_sent": send_ok, "fixture_landed": landed,
                            "verdict": verdict, "detail": detail})
            print(f"  {verdict:4} {name:14} expect={expect:4} engine_sent={send_ok} "
                  f"truth_landed={landed}  {detail}")

    passed = sum(1 for r in results if r["verdict"] == "PASS")
    land = [r for r in results if r["expect"] == "LAND"]
    land_pass = sum(1 for r in land if r["verdict"] == "PASS")
    print("\n== summary ==")
    print(f"overall: {passed}/{len(results)}")
    print(f"LAND coverage (the success rate that matters): {land_pass}/{len(land)}")
    from collections import Counter
    fails = Counter(r["group"] for r in results if r["verdict"] == "FAIL")
    print("failures by group:", dict(fails))
    print("failures:", [r["variant"] for r in results if r["verdict"] == "FAIL"])
    out = Path(__file__).with_name("baseline_sweep_results.json")
    out.write_text(json.dumps(results, indent=2))
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
