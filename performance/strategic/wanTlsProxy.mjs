/**
 * Sandbox-only TLS/WAN surrogate. Terminates a self-signed HTTPS/WSS origin and forwards
 * to the loopback campaign service. Optional one-way request delay and connection loss let
 * the existing 500 virtual-client harness exercise retry paths. This is NOT a real WAN:
 * there is no RTT shaping per packet, congestion, routing, or production certificate chain.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function delayFor(latencyMs, jitterMs) {
  const jitter = jitterMs
    ? Math.floor(Math.random() * (2 * jitterMs + 1)) - jitterMs
    : 0;
  return Math.max(0, latencyMs + jitter);
}

function dropped(lossPct) {
  return lossPct > 0 && Math.random() * 100 < lossPct;
}

function forwardedHeaders(req, targetPort) {
  return {
    ...req.headers,
    host: `127.0.0.1:${targetPort}`,
  };
}

export async function startWanTlsProxy({
  targetPort,
  port,
  latencyMs = 0,
  jitterMs = 0,
  lossPct = 0,
}) {
  const dir = await mkdtemp(join(tmpdir(), "arenastar-wan-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const [key, cert] = await Promise.all([
    readFile(keyPath),
    readFile(certPath),
  ]);
  const server = createHttpsServer({ key, cert }, (req, res) => {
    if (dropped(lossPct)) {
      res.destroy();
      return;
    }
    setTimeout(
      () => {
        const upstream = httpRequest(
          {
            hostname: "127.0.0.1",
            port: targetPort,
            path: req.url,
            method: req.method,
            headers: forwardedHeaders(req, targetPort),
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          },
        );
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(upstream);
      },
      delayFor(latencyMs, jitterMs),
    );
  });
  server.maxConnections = 1200;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (req, clientSocket, head) => {
    if (dropped(lossPct)) {
      clientSocket.destroy();
      return;
    }
    setTimeout(
      () => {
        const upstream = netConnect(targetPort, "127.0.0.1", () => {
          const headers = forwardedHeaders(req, targetPort);
          let packet = `${req.method} ${req.url} HTTP/1.1\r\n`;
          for (const [name, value] of Object.entries(headers)) {
            if (Array.isArray(value)) {
              for (const item of value) packet += `${name}: ${item}\r\n`;
            } else if (value !== undefined) {
              packet += `${name}: ${value}\r\n`;
            }
          }
          packet += "\r\n";
          upstream.write(packet);
          if (head.byteLength) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upstream.destroy());
      },
      delayFor(latencyMs, jitterMs),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    origin: `https://127.0.0.1:${port}`,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      await closed;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
