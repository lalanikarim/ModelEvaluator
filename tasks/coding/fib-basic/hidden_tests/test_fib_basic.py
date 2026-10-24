#!/usr/bin/env python3
"""Hidden oracle test: fib.py prints the first 10 Fibonacci numbers, one per line."""
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
    lines = [l.strip() for l in out.stdout.splitlines() if l.strip()]
    nums = []
    for l in lines:
        try:
            nums.append(int(l))
        except ValueError:
            print(f"FAIL: non-numeric line in output: {l!r}")
            return 1
    if len(nums) != 10:
        print(f"FAIL: expected exactly 10 lines, got {len(nums)}")
        return 1
    # Accept either 0,1,1,2,... or 1,1,2,3,... start.
    if not (nums[:2] in ([0, 1], [1, 1])):
        print(f"FAIL: sequence does not start with 0,1 or 1,1: {nums[:3]}")
        return 1
    for i in range(2, len(nums)):
        if nums[i] != nums[i - 1] + nums[i - 2]:
            print(f"FAIL: fib relation broken at index {i}: {nums}")
            return 1
    print("PASS")
    return 0

if __name__ == "__main__":
    sys.exit(main())
