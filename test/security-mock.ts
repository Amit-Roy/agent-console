// Mock scan-host data shared by the security tests.
const vuln = (
  id: string,
  pkg: string,
  installed: string,
  fixed: string | null,
  severity: string,
  title: string,
) => ({ id, pkg, installed, fixed, severity, title });
export const LATEST = {
  id: "20261022T231500Z",
  startedAt: "2026-10-22T23:15:00Z",
  finishedAt: "2026-10-23T00:02:41Z",
  trigger: "timer",
  mode: "full",
  status: "findings",
  tools: {
    clamav: {
      status: "findings",
      version: "ClamAV 1.4.2",
      dbDate: "2026-10-22",
      durationSec: 1620,
      scannedFiles: 184230,
      scannedPaths: ["/root", "/srv"],
      infected: [{ path: "/srv/uploads/invoice.pdf.exe", signature: "Win.Trojan.Agent-1234" }],
      error: null,
    },
    falco: {
      status: "findings",
      version: "0.45.1",
      durationSec: 0,
      since: "2026-10-22T14:19:11Z",
      counts: { Critical: 0, Error: 1, Warning: 2, Notice: 0 },
      alerts: [
        {
          time: "2026-10-22T21:40:02Z",
          priority: "Error",
          rule: "Write below etc",
          container: "host",
          output: "File below /etc opened for writing (file=/etc/cron.d/x proc=bash)",
        },
        {
          time: "2026-10-22T19:05:44Z",
          priority: "Warning",
          rule: "Terminal shell in container",
          container: "postgres",
          output:
            "A shell was spawned in a container with an attached terminal (user=root shell=sh)",
        },
        {
          time: "2026-10-22T16:12:30Z",
          priority: "Warning",
          rule: "Terminal shell in container",
          container: "caddy",
          output:
            "A shell was spawned in a container with an attached terminal (user=root shell=ash)",
        },
      ],
      error: null,
    },
    trivy: {
      status: "findings",
      version: "0.58.1",
      durationSec: 640,
      targets: [
        {
          name: "postgres:17",
          type: "image",
          counts: { CRITICAL: 1, HIGH: 2, MEDIUM: 6, LOW: 14 },
          fixable: { CRITICAL: 1, HIGH: 1 },
          vulns: [
            vuln(
              "CVE-2026-1001",
              "libssl3",
              "3.0.11",
              "3.0.15",
              "CRITICAL",
              "OpenSSL: remote code execution in certificate parsing",
            ),
            vuln(
              "CVE-2026-2002",
              "zlib1g",
              "1.2.13",
              null,
              "HIGH",
              "zlib: heap overflow in inflate",
            ),
            vuln(
              "CVE-2026-3003",
              "libc6",
              "2.36",
              "2.36-9+deb12u9",
              "HIGH",
              "glibc: stack overflow in qsort",
            ),
          ],
        },
        {
          name: "/ (rootfs)",
          type: "rootfs",
          counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 2, LOW: 3 },
          vulns: [],
        },
        {
          name: "caddy:2",
          type: "image",
          counts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0 },
          vulns: [
            vuln(
              "CVE-2026-4004",
              "golang.org/x/net",
              "0.20.0",
              null,
              "HIGH",
              "x/net: HTTP/2 rapid reset",
            ),
          ],
        },
        {
          name: "third-party repos",
          type: "repo",
          thirdParty: true,
          counts: { CRITICAL: 2, HIGH: 5, MEDIUM: 9, LOW: 4 },
          vulns: [
            vuln(
              "CVE-2026-5005",
              "lodash",
              "4.17.10",
              null,
              "CRITICAL",
              "lodash: prototype pollution",
            ),
          ],
        },
      ],
      error: null,
    },
    nmap: {
      status: "clean",
      version: "7.95",
      durationSec: 38,
      target: "203.0.113.10",
      openPorts: [
        { port: 22, proto: "tcp", service: "ssh", product: "OpenSSH 10.0", exposed: false },
        { port: 80, proto: "tcp", service: "http", product: "Caddy httpd", exposed: false },
        { port: 443, proto: "tcp", service: "https", product: "Caddy httpd", exposed: true },
      ],
      error: null,
    },
  },
};
export const CLEAN = {
  ...LATEST,
  id: "20261021T231500Z",
  status: "clean",
  tools: {
    ...LATEST.tools,
    clamav: { ...LATEST.tools.clamav, status: "clean", infected: [] },
    falco: {
      ...LATEST.tools.falco,
      status: "clean",
      counts: { Critical: 0, Error: 0, Warning: 0, Notice: 0 },
      alerts: [],
    },
    trivy: { ...LATEST.tools.trivy, status: "clean", targets: [] },
  },
};
const sum = (r: any, status: string) => ({
  id: r.id,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  trigger: r.trigger,
  mode: r.mode,
  status,
  counts: {
    infected: r.tools.clamav.infected.length,
    runtimeAlerts: r.tools.falco.alerts.length,
    critical: r.tools.trivy.targets
      .filter((t: any) => !t.thirdParty)
      .reduce((a: number, t: any) => a + t.counts.CRITICAL, 0),
    high: r.tools.trivy.targets
      .filter((t: any) => !t.thirdParty)
      .reduce((a: number, t: any) => a + t.counts.HIGH, 0),
    openPorts: r.tools.nmap.openPorts.filter((p: any) => p.exposed !== false).length,
  },
});
export const HISTORY = [
  sum(LATEST, "findings"),
  ...Array.from({ length: 11 }, (_, i) =>
    sum(
      {
        ...CLEAN,
        id: `2026101${9 - (i % 9)}T231500Z${i}`,
        finishedAt: `2026-10-${String(21 - i).padStart(2, "0")}T00:02:41Z`,
      },
      i === 4 ? "error" : "clean",
    ),
  ),
];

// Scan log: LOG_ID has a 6-line log, "running" until the caller has read all of it.
export const LOG_ID = "20261023T000907Z";
export const LOG_LINES = [
  "2026-10-23T00:09:07Z scan: started, trigger manual",
  "2026-10-23T00:09:07Z clamav: started",
  "2026-10-23T00:09:08Z clamav: scanning /root /srv",
  "2026-10-23T00:40:01Z trivy: 2026-10-23T00:40:01Z INFO Detected OS family=debian version=12.8",
  "2026-10-23T00:41:12Z nmap: Discovered open port 443/tcp on 203.0.113.10",
  "2026-10-23T00:42:00Z clamav: finished in 1234 s",
];
export const logPage = (after: number, running = false) => ({
  id: LOG_ID,
  running,
  from: Math.min(after, LOG_LINES.length),
  total: LOG_LINES.length,
  lines: LOG_LINES.slice(after),
});

// A quick-scan result: ClamAV only checked files changed since the previous scan.
export const QUICK = {
  ...CLEAN,
  id: "20261023T010000Z",
  mode: "quick",
  tools: {
    ...CLEAN.tools,
    clamav: {
      ...CLEAN.tools.clamav,
      mode: "quick",
      since: "2026-10-22T23:15:00Z",
      scannedFiles: 312,
    },
  },
};
