# Internal service

A single-module HTTP client (`client.py`) used by our internal service to fetch
upstream data. It currently does one request and crashes on any failure.

Planned work: make `fetch_url` resilient to transient upstream failures.
