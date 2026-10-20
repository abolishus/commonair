<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0008: Trust & safety dependency licenses

- Status: proposed (with ADR 0006's resolution)
- Date: 2026-10-20 (all licenses verified on this date)

## Context

ADR 0006 (automated moderation) needs a perceptual-hash matcher, a classifier runtime and
classifier weights. ADR 0002 requires OSI licenses for every dependency, verified at the pinned
version. This ADR treats model weights the same way. It records each choice and every
judgment call. It adds no allowlist id and no per-package exception to ADR 0002.

## Accepted

| Component                                                                     | Pinned at                                                        | License                             | Verified from                                                                                                   |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| PDQ and vPDQ algorithms (ported to TypeScript)                                | ThreatExchange tag `hma-v1.1.7`                                  | BSD-3-Clause                        | `LICENSE` and `vpdq/LICENSE.txt` at the tag (github.com/facebook/ThreatExchange)                                |
| PDQ reference test vectors (benign photos, expected hashes)                   | same tag, `pdq/data/reg-test-input`                              | BSD-3-Clause                        | same `LICENSE`                                                                                                  |
| `onnxruntime-node`, `onnxruntime-common`                                      | 1.30.0 (2026-09-14)                                              | MIT                                 | npm registry metadata and the package `LICENSE`; dependencies `adm-zip` (MIT) and `global-agent` (BSD-3-Clause) |
| Classifier weights `AdamCodd/vit-base-nsfw-detector` (`onnx/model_int8.onnx`) | revision `8587de998f441aac03fdd57a85d2e4cb808c7d64` (2024-12-03) | Apache-2.0 (model-card declaration) | Hugging Face model card metadata at the revision; base model `google/vit-base-patch16-384` card: Apache-2.0     |

## Judgment calls

- **Ported code keeps its license.** Files ported from ThreatExchange's PDQ/vPDQ are a
  derivative of BSD-3-Clause code. They carry Meta's copyright line and
  a `BSD-3-Clause` SPDX license header, and `LICENSES/BSD-3-Clause.txt` is added for REUSE.
  BSD-3-Clause is compatible with AGPL-3.0-or-later. Clause 3 (no endorsement using Facebook's
  name) is respected by not naming Meta in product copy.
- **Weights licensed by a model-card field.** The `AdamCodd/vit-base-nsfw-detector` repository has
  no LICENSE file. Its license is the card's `license: apache-2.0` metadata, as for drizzle-kit
  in ADR 0002. The base model is Apache-2.0. The fine-tuning data (about 25,000 images, per the
  card) is undisclosed. We accept the declared license and record the risk: if the author's
  rights in the weights turn out to be weaker than declared, operators swap the adapter. The
  interface does not depend on this model.
- **Weights are fetched, not vendored.** They are downloaded server-side at a pinned revision
  with a sha256 check (`scripts/fetch-model.ts`), never committed and never served to clients.
  Non-negotiable 4 (no third-party client-side code) is unaffected. The platform still runs
  offline if the operator supplies the file.
- **`onnxruntime-node` native binaries.** The npm package bundles prebuilt CPU binaries for each
  platform. Their third-party notices list permissive licenses only (protobuf, Eigen, abseil and
  others). Its postinstall script downloads optional CUDA binaries from NuGet. Bun does not run
  it unless the package is in `trustedDependencies`, which it must never be: CUDA brings NVIDIA's
  proprietary runtime.

## Considered and rejected

| Candidate                                                                            | License as declared                                  | Why rejected                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hasher-Matcher-Actioner 1.1.7 (container)                                            | BSD-3-Clause                                         | Unpinned pip dependencies (Pillow is MIT-CMU, not on the allowlist), x86-only Dockerfile, no pinned published image, and a duplicate service with its own database. ADR 0006 Q1               |
| `pdq-wasm` 0.3.9                                                                     | BSD-3-Clause                                         | A compiled WebAssembly blob that cannot be reviewed as source. The native port is small                                                                                                       |
| TMK+PDQF (`tmk/`)                                                                    | BSD-3-Clause                                         | Allowed, but C++ only and superseded in HMA by vPDQ. vPDQ is PDQ on sampled frames, so one implementation covers images and video                                                             |
| `Marqo/nsfw-image-detection-384`                                                     | Apache-2.0 (card)                                    | Smaller and more accurate on its authors' data, but ships only timm/safetensors. We would have to convert and host the ONNX file ourselves, which operators could not verify against upstream |
| `Falconsai/nsfw_image_detection`                                                     | Apache-2.0 (card)                                    | The repository also contains pickled `.pt`/`.bin` files and an optimizer state, it changed in 2026-09 without notes, and it has no ONNX export                                                |
| `laion/CLIP-ViT-B-32-laion2B-s34B-b79K` (zero-shot for violence, weapons, self-harm) | MIT (card)                                           | Trained on LAION-2B, a dataset withdrawn in 2023 after apparent CSAM was found in it. A trust & safety system should not ship it as its default. Zero-shot scores are also poorly calibrated  |
| `openai/clip-vit-base-patch32`                                                       | MIT (code repository); no license tag on the weights | The model card puts deployed use out of scope, and the weights' license is unclear on the card                                                                                                |
| Hosted services (PhotoDNA, Safer, CSAI Match, cloud vision APIs)                     | proprietary or access-gated                          | Allowed only as optional adapters (non-negotiable 3)                                                                                                                                          |

No default model for graphic violence, weapons or self-harm met the policy. ADR 0006 Q2 records
the coverage gap.
