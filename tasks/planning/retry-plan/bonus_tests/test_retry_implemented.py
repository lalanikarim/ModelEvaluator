#!/usr/bin/env python3
"""Hidden bonus test: the executed plan must make fetch_url retry transient failures.

Checks (lenient on implementation details):
1. A failure-then-success sequence is retried and returns the body.
2. Persistent failure raises an exception after a finite number of attempts (no hang).
"""
import contextlib
import importlib
import os
import sys
import urllib.error


class FakeResp:
    def read(self):
        return b"Example Domain"

    @contextlib.contextmanager
    def cm(self):
        yield self


def make_fake(fail_times):
    state = {"calls": 0}

    def fake_urlopen(url, timeout=None):
        state["calls"] += 1
        if state["calls"] <= fail_times:
            raise urllib.error.URLError("transient failure")
        resp = FakeResp()
        return resp.cm()

    return fake_urlopen, state


def main() -> int:
    sys.path.insert(0, os.getcwd())
    client = importlib.import_module("client")
    orig = client.urllib.request.urlopen

    # Case 1: two transient failures, then success.
    fake, state = make_fake(fail_times=2)
    client.urllib.request.urlopen = fake
    try:
        body = client.fetch_url("http://upstream.test/data")
    except Exception as e:
        print(f"FAIL case 1: raised {type(e).__name__}: {e}")
        return 1
    finally:
        client.urllib.request.urlopen = orig
    if "Example Domain" not in str(body):
        print(f"FAIL case 1: unexpected body {body!r}")
        return 1
    if state["calls"] < 3:
        print(f"FAIL case 1: expected >=3 attempts, got {state['calls']}")
        return 1
    calls_case1 = state["calls"]

    # Case 2: persistent failure must raise after a finite number of attempts.
    fake, state = make_fake(fail_times=10_000)
    client.urllib.request.urlopen = fake
    try:
        client.fetch_url("http://upstream.test/data")
        raised = False
    except Exception:
        raised = True
    finally:
        client.urllib.request.urlopen = orig
    if not raised:
        print("FAIL case 2: persistent failure did not raise")
        return 1
    if state["calls"] > 15:
        print(f"FAIL case 2: too many attempts ({state['calls']}) — no bounded retry cap")
        return 1

    print(f"PASS (case1 attempts={calls_case1}, case2 attempts={state['calls']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
