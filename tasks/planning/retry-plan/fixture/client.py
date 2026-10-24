"""Minimal HTTP client used by a small internal service."""
import urllib.request


def fetch_url(url: str) -> str:
    """Fetch a URL and return its body as text. No error handling yet."""
    with urllib.request.urlopen(url, timeout=10) as resp:
        return resp.read().decode("utf-8")


def main() -> None:
    print(fetch_url("https://example.com"))


if __name__ == "__main__":
    main()
