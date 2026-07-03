# Elastic Search Local Setup

This guide explains how to run Elastic Search locally using Docker/Podman for development purposes.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) or [Podman](https://podman.io/getting-started/installation)

## Quick Start

Follow the official Elastic Search local development quickstart:

**[Elastic Search Local Development Installation Quickstart](https://www.elastic.co/docs/deploy-manage/deploy/self-managed/local-development-installation-quickstart)**

## Known Issues

### Certificate Issues (Netskope)

If you encounter TLS/SSL certificate errors when pulling images or connecting to Elastic Search, this is likely caused by **Netskope** SSL inspection intercepting traffic on the corporate network.

#### Symptoms

- `x509: certificate signed by unknown authority` when pulling Docker images
- SSL handshake failures from containers
- `CERTIFICATE_VERIFY_FAILED` errors


The Netskope certificate must be added to Docker's trusted certificates. The approach varies by OS.

#### Extension-side telemetry connection

The error above is about Docker/the OS toolchain. The extension's own telemetry connection to the Elastic Search proxy handles this automatically: the transport loads the operating system trust store (where the Netskope/corporate CA already lives) and merges it with Node's default roots, so the re-signed certificate validates with no per-user configuration.

The Elastic Search transport is loaded lazily during activation, and the `@elastic/elasticsearch` client is bundled into the extension so packaged VSIX builds do not depend on a separate `node_modules` tree at runtime.

This requires a runtime with `tls.getCACertificates` (Node ≥ 22.15). On older hosts the transport falls back to Node's bundled roots only — set `NODE_EXTRA_CA_CERTS` to point at the corporate CA file if the connection then fails.

### Variable Interpolation in `.env`

The `elastic-start-local` tool may generate `.env` values that reference other variables, e.g.:

```
ES_LOCAL_PORT=9200
ES_LOCAL_URL=http://localhost:${ES_LOCAL_PORT}
```

VS Code's `envFile` loader (used in `launch.json`) does **not** resolve `${VAR}` references — it passes the literal string `http://localhost:${ES_LOCAL_PORT}` to the extension. If you see connection errors pointing to a URL containing `${...}`, replace the variable reference with the actual value in `elastic-start-local/.env`:

```
ES_LOCAL_URL=http://localhost:9200
```
