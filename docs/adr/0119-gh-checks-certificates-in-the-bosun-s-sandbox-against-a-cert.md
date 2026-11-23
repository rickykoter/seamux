# 0119. gh checks certificates in the Bosun's sandbox against a certificate file, not the trust service

Date: 2026-11-23

## Status

Accepted

## Context

Claude Code's sandbox refuses the mach lookup of com.apple.trustd.agent, so Go programs like gh can't verify TLS certificates in it. Its docs offer two fixes: enableWeakerNetworkIsolation, which opens trustd to every sandboxed command, and excludedCommands, which runs the tool unsandboxed with full access. Go also honors SSL_CERT_FILE on macOS.

## Decision

Setting SSL_CERT_FILE in the Bosun's settings fixes every gh call and leaves the sandbox exactly as ADR 0115 set it: read-only on the root, no unsandboxed retry, no new mach service.

## Consequences

launch.rs puts env.SSL_CERT_FILE in the settings it writes: the supervisor's own SSL_CERT_FILE when that file exists, else /etc/ssl/cert.pem when it does, else nothing. Claude Code passes it to every command the Bosun runs and to the MCP servers it starts. Certificates are checked against Apple's bundled roots, so a corporate CA that lives only in the keychain is not trusted; a person behind a TLS-intercepting proxy sets SSL_CERT_FILE to a bundle that includes it. Turning trustd on stays the person's call.
