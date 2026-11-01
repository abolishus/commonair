<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Live captions

Live captions turn a stream's speech into text while it is live, with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) running on your own server: no audio
leaves it. The design is [ADR 0011](../decisions/0011-caption-models.md).

Captions are **off by default** on a self-hosted instance, because they cost CPU. Turning them
on adds one container, `commonair-whisper`, the speech sidecar. Even then, each streamer decides
per channel in the studio: a channel's captions start off unless your members vote the instance
default on (`captions.defaultEnabled`, ADR 0011 decision 2).

## Before you turn it on

- **On amd64 (x86-64), the CPU needs AVX, AVX2, FMA and F16C.** See
  [CPU requirements](#cpu-requirements). arm64 needs nothing extra.
- **About two CPU cores** while captioned streams are live. See [What it costs](#what-it-costs).
- **A 57 MiB download** the first time: the `ggml-base-q5_1` weights from the whisper.cpp
  model repository on Hugging Face, at a pinned revision, checked against a pinned sha256.

## Turning it on

As the `commonair` user:

```sh
sh ~/commonair/selfhost.sh upgrade --captions             # with an upgrade
sh ~/commonair/selfhost.sh install --reinstall --captions # or on the installed release
```

`--captions` works on `install`, `upgrade` and `install --reinstall`, and as root on a first
install. In that order, it:

1. checks the CPU (amd64 only) and stops with the missing features named if it falls short.
   Nothing has changed at that point;
2. pulls the `whisper` image by digest, like every other image of the release;
3. downloads the weights to `~/.local/share/commonair/models/whisper-ggml-base-q5_1.bin`, checked
   by `fetch-model` in the tools image. A file that does not match its pinned sha256 stops the
   install. Without internet access, pass a verified copy with `--captions-model <path>`;
4. sets `WHISPER_URL=http://whisper:8080` in `commonair.env`, which the media service reads, and
   installs and starts `commonair-whisper`.

The setting is kept on later upgrades and reinstalls until you pass `--no-captions`. Without
either flag nothing changes, so captions stay off on a first install.

`selfhost.sh status` shows it:

```text
captions:  on, commonair-whisper active, up to 2 streams (CAPTIONS_MAX_STREAMS)
```

The sidecar listens only on the internal `commonair` network. Nothing publishes its port, and
no firewall change is needed.

## What it costs

The sidecar runs whisper.cpp's `base` model, quantized (q5_1), on **two CPU threads**. The media
service sends it 3-second chunks of each captioned stream. Measured with the pinned build
([ADR 0011, history of 2026-11-01](../decisions/0011-caption-models.md)): about 0.66 s of work
per 3-second chunk on a developer machine and about 1 s on a two-vCPU CI runner. That is roughly
a quarter to a third of those two threads for each captioned stream.

`CAPTIONS_MAX_STREAMS` (default `2`) caps how many streams get captions at once on a media host.
Streams beyond it wait in a queue, in start order, and the player and studio say that capacity
is why. With the default, plan for **two cores busy while two captioned streams are live**, and
a few hundred MB of RAM for the sidecar. When no captioned stream is live, the sidecar sits idle.
Set `CAPTIONS_MAX_STREAMS=0` to stop captioning without removing the sidecar.

These numbers come from short test runs, not from a production host. Transcoding comes first:
if your host is busy transcoding, lower `CAPTIONS_MAX_STREAMS` or leave captions off. The
[capacity runbook](../operators/capacity.md) is where measured numbers will go.

## CPU requirements

| Architecture   | The CPU needs               | Which CPUs have it                                                    |
| -------------- | --------------------------- | --------------------------------------------------------------------- |
| amd64 (x86-64) | AVX, AVX2, FMA and F16C     | Intel Core from Haswell (2013) on, AMD from Zen (2017) on, most cloud |
| arm64          | nothing beyond ARMv8 (NEON) | every arm64 server                                                    |

The sidecar's amd64 image is compiled for those instructions, so that it is fast enough to keep
up with live audio. It has no slower fallback in the same image: whisper.cpp could pick its code
path at run time, but only by shipping its backends as separate libraries, which this image does
not do yet.

**Without them, captions cannot run on that host; everything else can.** On a CPU without AVX2
(Intel before Haswell, many Atom, Celeron and Pentium models, AMD before Zen), `whisper-server`
stops with `SIGILL` (illegal instruction) the moment it starts. That is why `selfhost.sh`
compares `/proc/cpuinfo` with the release's requirements before it turns captions on, and
refuses with the missing features named:

```text
selfhost: error: live captions need a CPU with avx avx2 fma f16c; this one lacks: avx2 fma f16c
```

Re-run without `--captions` (or with `--no-captions`). The rest of the platform does not need
these instructions.

If you run the sidecar anyway (by hand, or with `podman compose --profile captions`), it keeps
crashing and never becomes healthy; the unit restarts it with a back-off that grows to five
minutes. The media service cannot reach it and drops each caption chunk. Streams, playback and
recordings are not affected, and no captions appear.

**Virtual machines** report the CPU model their host gives them. A provider's or Proxmox's
generic model (`kvm64`, `qemu64`, `x86-64-v2`) hides AVX2 even on a CPU that has it. Ask for
`host` CPU passthrough, or a model of `x86-64-v3` or newer. Check from inside the VM:

```sh
grep -o -w -e avx2 -e fma -e f16c /proc/cpuinfo | sort -u
```

It should print all three. Each release states the requirement too: in its notes, under
"Platform requirements", and in `release-manifest.json` (`"cpu": {"whisper": {"linux/amd64":
["avx", "avx2", "fma", "f16c"]}}`).

## Turning it off

```sh
sh ~/commonair/selfhost.sh upgrade --no-captions             # with an upgrade
sh ~/commonair/selfhost.sh install --reinstall --no-captions # or on the installed release
```

This stops and removes `commonair-whisper` and empties `WHISPER_URL`. Captions already saved with
recordings stay. The weights stay in `~/.local/share/commonair/models/`; delete the file by hand
if you want the space back.

## Your own whisper server

If `WHISPER_URL` in `commonair.env` points anywhere but `http://whisper:8080`, `selfhost.sh`
installs no sidecar and leaves the value alone. Media sends each chunk to that address, so it must
be a whisper.cpp server (`/inference`) that media can reach, and it should not be reachable from
the internet. `--no-captions` empties `WHISPER_URL` whatever it holds.
