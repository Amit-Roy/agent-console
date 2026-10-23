# Hosting migration: off SSD Nodes (issue #71)

Why: the SSD Nodes Mumbai VPS (8 vCPU, 32 GB, 480 GB, KVM) is sold as 32 GB but the hypervisor inflates `virtio_balloon` to reclaim RAM. The kernel then stalls in `fill_balloon`, journald hits its 3-minute watchdog and the whole VM freezes: Coder shows "Agent state is disconnected" and every running agent turn dies. 387 `fill_balloon` kernel lines this month alone (`journalctl -k | grep -c fill_balloon`, 2026-10-20). The balloon driver was unloaded and blacklisted on 2026-10-20 (`/etc/modprobe.d/no-virtio-balloon.conf`), which stops the freezes but leaves the host free to swap or kill the VM under overcommit. That is a stopgap, not a guarantee.

## Requirements

- RAM and CPU that are reserved for us: no ballooning, no overcommit. Bare metal, or a cloud with dedicated vCPU and fixed memory.
- One always-on host for hours-long agent turns: Coder (Docker + Postgres), Caddy, the workspace container, Claude Code / Codex / Pi child processes, Playwright.
- At least today's size: 8 vCPU, 32 GB RAM, ~100 GB disk (workspace home 35 GB, Docker 44 GB).
- Low latency from India; bills in INR or by card from India.
- GPUs on demand, by the hour, without moving the main host.

## Candidates

Prices checked 2026-10-20, list price, excluding tax. Monthly cost is for 8 vCPU / 32 GB or the nearest size.

| Option | Monthly cost | Resource guarantee | GPU on demand | Long-running agents | Source |
| --- | --- | --- | --- | --- | --- |
| AWS Lambda | Per request; not comparable | Fixed per invocation, max 10 GB RAM | None | No: hard 15-minute limit per invocation, no persistent processes, no Docker daemon | [Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |
| AWS EC2 m7i.2xlarge, Mumbai | $310 on-demand; ~$205 with 1-year reservation | Yes: fixed vCPU and RAM, no ballooning | Yes, same account: g6.xlarge (1x L4 24 GB) ~$0.97/hr in Mumbai; GPU quota must be requested first | Yes | [DoiT m7i.2xlarge ap-south-1](https://www.doit.com/compute/compute/aws/ap-south-1/m7i.2xlarge), [DevZero g6.xlarge](https://www.devzero.io/instances/aws/g6.xlarge) |
| GCP n2-standard-8, Mumbai | ~$340 on-demand; ~$273 after sustained-use discount | Yes: fixed vCPU and RAM | Yes, same account: L4 / A100 / H100 by the hour, quota request first | Yes | [gcloud-compute.com n2-standard-8](https://gcloud-compute.com/n2-standard-8.html) |
| Hetzner Cloud CCX33 (dedicated vCPU), Singapore | €175 (€139 in Germany/Finland) | Yes: dedicated vCPU, fixed RAM | No cloud GPUs | Yes | [Hetzner general purpose](https://www.hetzner.com/cloud/general-purpose/) |
| Hetzner AX42 bare metal, Germany/Finland | €79–99 + €49 setup; 8 cores / 16 threads, 64 GB ECC | Yes: whole machine, no hypervisor | Separate GPU server: GEX45 (RTX PRO 4000, 24 GB) €0.34/hr but €209 setup | Yes; ~130–160 ms from India | [Hetzner AX matrix](https://www.hetzner.com/dedicated-rootserver/matrix-ax/), [Hetzner GPU matrix](https://www.hetzner.com/dedicated-rootserver/matrix-gpu/) |
| OVHcloud Advance-2 bare metal, Mumbai | From ₹15,750 + equal install fee; 8 cores / 16 threads, 64 GB ECC | Yes: whole machine, no hypervisor | Not in Mumbai dedicated range; use an hourly GPU cloud | Yes; same region as today | [OVHcloud dedicated India](https://www.ovhcloud.com/en-in/bare-metal/dedicated-server-india/) |
| India GPU clouds (Jarvislabs, CloudPe) | GPU only, by the hour: RTX PRO 6000 ₹152–207/hr, H100 ~₹330/hr (checked 2026-10-16) | Yes for the rented GPU | Yes: this is the GPU path for any CPU host above | Not a main host; rent per job | [Jarvislabs India](https://jarvislabs.ai/in), [CloudPe RTX PRO 6000](https://www.cloudpe.com/gpu/rtx-pro-6000/) |

Findings:

- Lambda cannot host this app. Agent turns run for hours, keep child processes and need Docker; Lambda stops every invocation at 15 minutes. Fargate or Cloud Run would also need a full redesign around ephemeral containers for no gain over one VM.
- AWS and GCP give guaranteed resources and GPUs in one account, at 2–3x the price of bare metal for half the RAM. Worth it only if GPUs are needed often enough that one bill matters.
- Bare metal is the cheapest way to guarantee resources: no hypervisor, so nothing can balloon. It also doubles RAM to 64 GB.
- GPUs do not need to live next to the main host. Model serving is reached over HTTPS or an SSH tunnel; rent an hourly GPU box per job and stop it after.

## Recommendation

**Target:** OVHcloud Advance-2 bare metal in Mumbai (8 cores / 16 threads, 64 GB ECC, 2x 960 GB NVMe).

- Same region as today, so latency and India billing stay as they are.
- Fallback if Mumbai stock is not orderable within a week (the page lists the range as "soon available"): Hetzner AX42 in Falkenstein. Cheaper, always in stock, at the cost of ~130–160 ms latency.
- GPUs: rent hourly from Jarvislabs or CloudPe when a job needs one. Revisit AWS only if GPU use becomes weekly.
- Before ordering, check the current SSD Nodes invoice and renewal date, so the overlap month is paid once.

## Deployment

The current host is three Docker pieces plus Caddy: Coder (`/opt/coder/compose.yaml`, volumes `coder_database_data` and `coder_coder_home`), the workspace container with its home volume `coder-<workspace-id>-home`, and Caddy (`/opt/coder/https/Caddyfile`, DuckDNS module, `/etc/caddy/duckdns.env`). The plan moves those as they are; nothing in agent-console changes.

1. Order the server with Debian 13. Confirm bare metal: `systemd-detect-virt` prints `none`, `free -g` shows the full RAM.
2. Harden SSH (same key as the old host, no password login) and install Docker with the same script used today (`/root/install-docker.sh`).
3. Copy the Caddy binary, `caddy.service`, Caddyfile and `duckdns.env` from the old host with `rsync -a` over SSH. Keep `duckdns.env` mode 0600; never print it.
4. Copy `/opt/coder` (compose file, `.env`, backups) and `/root/coder-update-ws.sh`.
5. Pre-seed the big data while the old host still runs: `rsync -aHAX` the workspace home volume directory and `docker save` of the rollback image `nefro-dev-snapshot:2026-10-17`. This makes the final copy a small delta.
6. Measure from the phone and the laptop before cutover: `curl -o /dev/null -w '%{time_connect}\n' https://<new-ip>` against a temporary Caddy page.

## Session continuity

Everything that makes a session resumable lives in the workspace home volume: agent-console threads, logs and uploads (`~/.config/agent-console`), provider sessions (`~/.claude`, `~/.codex`, `~/.pi`), repos and worktrees. Restoring the Coder database keeps the workspace id, so the template finds the copied volume by name and reattaches it at the same `/home/coder` path. Provider session files keep their absolute paths and resume unchanged.

1. Announce a window. Let running turns finish: check the Console shows no running thread (the same check `bin/agent-console restart-when-idle` waits for).
2. Stop the workspace from the old VPS host, never from inside the workspace. Same call as `/root/coder-update-ws.sh`, with `stop`: `docker exec -e CODER_URL=http://127.0.0.1:7080 -e CODER_SESSION_TOKEN="$(cat /root/.coder-session)" coder-coder-1 /opt/coder stop nefro-dev-ssdnodes -y`.
3. Stop Coder: `cd /opt/coder && docker compose stop coder`, then dump the database: `docker compose exec -T database pg_dump -U coder coder > coder.sql`.
4. Final delta: `rsync -aHAX --delete` the home volume, copy `coder.sql` and the `coder_coder_home` volume (it holds the try.coder.app tunnel id).
5. On the new host: create the volumes with the same names, restore the dump into a fresh `database` service, then `docker compose up -d`.
6. Point DNS: update the DuckDNS record for `nefro-dev-coder.duckdns.org` to the new IP, then start Caddy. Wildcard certificates reissue through DNS-01.
7. Start the workspace from the new host with the step 2 command, `start` instead of `stop`. `workspace-boot` starts agent-console first, then reinstalls apt packages. Keep the workspace name for now: the Console URL and `AGENT_CONSOLE_PUBLIC_HOST` contain it.
8. Reconnect the workspace container to the `coder_default` network if the template did not (`docker network connect coder_default coder-Amit-Roy-nefro-dev-ssdnodes`).

## Rollback

The old VPS stays untouched and paid for until validation passes for 7 days.

1. If the new host fails validation, point the DuckDNS record back to the old VPS IP (note it before cutover).
2. On the old host: `cd /opt/coder && docker compose start coder`, then start the workspace from the host with the Session continuity step 2 command, `start` instead of `stop`.
3. Any work done on the new host since cutover lives in its home volume: `rsync` it back before starting the old workspace, or accept losing it if the window was short.
4. Cancel the old VPS only after 7 clean days on the new host and a final `rsync` of the home volume to cold storage.

## Validation

1. Bare metal and full RAM: `systemd-detect-virt` prints `none`; `free -g` shows 62+ GB.
2. No ballooning possible: `lsmod | grep -c balloon` prints `0` and `journalctl -k | grep -c fill_balloon` stays `0` for 7 days.
3. Coder healthy: `curl -fsS http://127.0.0.1:7080/healthz` on the host and the dashboard login works through Caddy.
4. Console reachable on the direct URL and still owner-only: `curl -s -o /dev/null -w '%{http_code}' https://7070--main--nefro-dev-ssdnodes--amit-roy.nefro-dev-coder.duckdns.org/` returns a Coder login redirect without a session; the installed PWA opens with one.
5. Sessions resumed: every thread from before the window appears in the sidebar; send "Continue." to one Claude, one Codex and one Pi thread and each answers with its prior context.
6. Direct networking, not DERP: `curl -s 127.0.0.1:2113/debug/magicsock` in the workspace shows a `172.18.` best path.
7. Load test under the old failure: run `AGENT_CONSOLE_PAGE=12 npm test` plus a Playwright UI suite while two agent threads run; no "Agent state is disconnected" and no kernel stall in `journalctl -k`.
8. Optional GPU smoke test: rent one hourly GPU box, reach it over an SSH tunnel from the workspace, run one request, stop the box and confirm billing stopped.
