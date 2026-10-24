#!/usr/bin/env python3
"""Hidden oracle test: fib.py still prints 10 Fibonacci numbers, has a module docstring and at least one type-annotated function."""
import ast
import subprocess
import sys

def main() -> int:
    try:
        out = subprocess.run(
            [sys.executable, "fib.py"],
            capture_output=True, text=True, timeout=15, check=False,
        )
    except FileNotFoundError:
        print("FAIL: fib.py not found in working directory")
        return 1
    if out.returncode != 0:
        print(f"FAIL: fib.py exited {out.returncode}\nstderr: {out.stderr.strip()[:500]}")
        return 1
    nums = []
    for l in (l.strip() for l in out.stdout.splitlines()):
        if not l:
            continue
        try:
            nums.append(int(l))
        except ValueError:
            print(f"FAIL: non-numeric line in output: {l!r}")
            return 1
    if len(nums) != 10 or nums[:2] not in ([0, 1], [1, 1]):
        print(f"FAIL: expected 10 Fibonacci numbers starting 0,1 or 1,1; got {nums}")
        return 1
    for i in range(2, len(nums)):
        if nums[i] != nums[i - 1] + nums[i - 2]:
            print(f"FAIL: fib relation broken at index {i}: {nums}")
            return 1

    src = open("fib.py", encoding="utf-8").read()
    tree = ast.parse(src)
    if ast.get_docstring(tree) is None:
        print("FAIL: no module docstring")
        return 1
    annotated = [
        f for f in ast.walk(tree)
        if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef))
        and (any(a.annotation for a in f.args.args) or f.returns is not None)
    ]
    if not annotated:
        print("FAIL: no type-annotated functions found")
        return 1
    print(f"PASS (docstring + {len(annotated)} annotated function(s))")
    return 0

if __name__ == "__main__":
    sys.exit(main())
