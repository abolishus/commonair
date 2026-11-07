<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

brand hex #f7bd36 lBrandText #8f5d00 dSunken #0f0f12 dRaised #212124 dSubtle #372f1f lSubtle #fef6e3

| pair | colours | WCAG | APCA Lc | need | result |
| ---- | ------- | ---- | ------- | ---- | ------ |

### Brand fill and text

| brand fill + zinc-950 text | #09090b on #f7bd36 | 11.66 | 73.3 | 4.5 | pass |
| brand fill + white text (rejected) | #ffffff on #f7bd36 | 1.71 | -34.2 | 4.5 | FAIL |
| dark --brand-text on page | #f7bd36 on #09090b | 11.65 | -72.3 | 4.5 | pass |
| dark --brand-text on sunken | #f7bd36 on #0f0f12 | 11.21 | -72.0 | 4.5 | pass |
| dark --brand-text on card | #f7bd36 on #18181b | 10.39 | -71.3 | 4.5 | pass |
| dark --brand-text on raised | #f7bd36 on #212124 | 9.38 | -70.1 | 4.5 | pass |
| dark --brand-text on muted/secondary | #f7bd36 on #27272a | 8.73 | -69.1 | 4.5 | pass |
| dark --brand-text on brand-subtle | #f7bd36 on #372f1f | 7.74 | -67.3 | 4.5 | pass |
| light --brand-text on white | #8f5d00 on #ffffff | 5.62 | 77.8 | 4.5 | pass |
| light --brand-text on zinc-50 sunken | #8f5d00 on #fafafa | 5.38 | 74.8 | 4.5 | pass |
| light --brand-text on muted 0.967 | #8f5d00 on #f4f4f5 | 5.10 | 71.2 | 4.5 | pass |
| light --brand-text on brand-subtle | #8f5d00 on #fef6e3 | 5.21 | 72.5 | 4.5 | pass |
| zinc-950 on dark brand-subtle (fg) | #fafafa on #372f1f | 12.65 | -99.4 | 4.5 | pass |
| light fg on light brand-subtle | #09090b on #fef6e3 | 18.45 | 100.7 | 4.5 | pass |

### Brand fill as a UI shape against each surface (1.4.11, 3:1)

| brand fill vs dark dBg | #f7bd36 on #09090b | 11.65 | -72.3 | 3 | pass |
| brand fill vs dark dSunken | #f7bd36 on #0f0f12 | 11.21 | -72.0 | 3 | pass |
| brand fill vs dark dCard | #f7bd36 on #18181b | 10.39 | -71.3 | 3 | pass |
| brand fill vs dark dRaised | #f7bd36 on #212124 | 9.38 | -70.1 | 3 | pass |
| brand fill vs light lBg | #f7bd36 on #ffffff | 1.71 | 30.4 | 3 | FAIL |
| brand fill vs light lSunken | #f7bd36 on #fafafa | 1.63 | 27.4 | 3 | FAIL |
| brand fill vs light lMuted | #f7bd36 on #f4f4f5 | 1.55 | 23.8 | 3 | FAIL |
| light ring-1 brand-text vs white (boundary) | #8f5d00 on #ffffff | 5.62 | 77.8 | 3 | pass |
| light ring-1 brand-text vs brand fill | #8f5d00 on #f7bd36 | 3.29 | 45.2 | 3 | pass |

### Brand vs neighbours

| brand vs dark --primary (two fills side by side) | #f7bd36 on #e4e4e7 | 1.35 | 14.6 | 3 | FAIL |
| brand vs channel-amber dark #fbbf24 | #f7bd36 on #fbbf24 | 1.02 | 0.0 | 3 | FAIL |
| brand vs old --warning #fbbf24 | #f7bd36 on #fbbf24 | 1.02 | 0.0 | 3 | FAIL |
| brand vs new --warning #fb923c | #f7bd36 on #fb923c | 1.33 | -13.5 | 3 | FAIL |

### Focus ring (ring-2 + offset-2 on --background)

| dark --ring vs page (offset gap) | #9f9fa9 on #09090b | 7.56 | -50.5 | 3 | pass |
| dark --ring vs card | #9f9fa9 on #18181b | 6.74 | -49.5 | 3 | pass |
| dark --ring vs raised | #9f9fa9 on #212124 | 6.09 | -48.3 | 3 | pass |
| dark --ring directly on brand fill | #9f9fa9 on #f7bd36 | 1.54 | 18.7 | 3 | FAIL |
| light --ring vs white | #71717b on #ffffff | 4.83 | 73.5 | 3 | pass |
| light --ring vs zinc-50 | #71717b on #fafafa | 4.62 | 70.5 | 3 | pass |
| light --ring directly on brand fill | #71717b on #f7bd36 | 2.83 | 40.9 | 3 | FAIL |
| dark foreground ring on brand (alt) | #fafafa on #f7bd36 | 1.63 | -30.8 | 3 | FAIL |
| zinc-950 ring on brand (alt) | #09090b on #f7bd36 | 11.66 | 73.3 | 3 | pass |

### Status: --warning (new orange) and neighbours

| dark warning on page | #fb923c on #09090b | 8.79 | -57.8 | 4.5 | pass |
| dark warning on card | #fb923c on #18181b | 7.83 | -56.8 | 4.5 | pass |
| dark warning on 15% tint over card | #fb923c on #3a2a20 | 6.04 | -53.3 | 4.5 | pass |
| dark warning on raised | #fb923c on #212124 | 7.08 | -55.6 | 4.5 | pass |
| light warning on white | #9a3412 on #ffffff | 7.31 | 84.4 | 4.5 | pass |
| light warning on zinc-50 | #9a3412 on #fafafa | 7.00 | 81.4 | 4.5 | pass |
| light warning on 15% tint over white | #9a3412 on #f0e1db | 5.72 | 68.3 | 4.5 | pass |
| dark warning vs live #dc2626 (hue pair) | #fb923c on #dc2626 | 2.13 | -27.1 | 3 | FAIL |
| dark warning vs destructive #f87171 | #fb923c on #f87171 | 1.22 | -8.0 | 3 | FAIL |

### 14 px body (and 12 px meta) on each surface

| dark fg on dBg | #fafafa on #09090b | 19.05 | -104.4 | 4.5 | pass |
| dark fg on dSunken | #fafafa on #0f0f12 | 18.32 | -104.2 | 4.5 | pass |
| dark fg on dCard | #fafafa on #18181b | 16.98 | -103.4 | 4.5 | pass |
| dark fg on dRaised | #fafafa on #212124 | 15.34 | -102.2 | 4.5 | pass |
| dark fg on dMuted | #fafafa on #27272a | 14.26 | -101.2 | 4.5 | pass |
| dark muted-fg on dBg | #9f9fa9 on #09090b | 7.56 | -50.5 | 4.5 | pass |
| dark muted-fg on dSunken | #9f9fa9 on #0f0f12 | 7.27 | -50.2 | 4.5 | pass |
| dark muted-fg on dCard | #9f9fa9 on #18181b | 6.74 | -49.5 | 4.5 | pass |
| dark muted-fg on dRaised | #9f9fa9 on #212124 | 6.09 | -48.3 | 4.5 | pass |
| dark muted-fg on dMuted | #9f9fa9 on #27272a | 5.66 | -47.3 | 4.5 | pass |
| light fg on lBg | #09090b on #ffffff | 19.89 | 105.9 | 4.5 | pass |
| light fg on lSunken | #09090b on #fafafa | 19.05 | 102.9 | 4.5 | pass |
| light fg on lMuted | #09090b on #f4f4f5 | 18.07 | 99.3 | 4.5 | pass |
| light muted-fg on lBg | #62626c on #ffffff | 6.02 | 80.1 | 4.5 | pass |
| light muted-fg on lSunken | #62626c on #fafafa | 5.77 | 77.1 | 4.5 | pass |
| light muted-fg on lMuted | #62626c on #f4f4f5 | 5.47 | 73.5 | 4.5 | pass |
| dark muted-fg on --brand-subtle | #9f9fa9 on #372f1f | 5.02 | -45.5 | 4.5 | pass |
| light muted-fg on --brand-subtle | #62626c on #fef6e3 | 5.58 | 74.9 | 4.5 | pass |

### Channel accents: fill + foreground, fill vs page, hover

| accent | dark fill/fg | dark fill vs page | dark hover/fg | APCA dark | light fill/fg | light fill vs page | light hover/fg | APCA light | vs brand (dark) |
| ------ | ------------ | ----------------- | ------------- | --------- | ------------- | ------------------ | -------------- | ---------- | --------------- |
| zinc   | 13.46        | 13.46             | 14.07         | 81        | 10.44         | 10.44              | 11.55          | 98         | 1.15            |
| red    | 7.19         | 7.19              | 8.04          | 51        | 6.47          | 6.47               | 7.67           | 85         | 1.62            |
| orange | 8.79         | 8.79              | 9.61          | 60        | 5.18          | 5.18               | 6.24           | 80         | 1.33            |
| amber  | 11.92        | 11.92             | 12.55         | 75        | 5.02          | 5.02               | 6.05           | 79         | 1.02            |
| lime   | 13.19        | 13.19             | 13.72         | 80        | 4.99          | 4.99               | 6.00           | 80         | 1.13            |
| green  | 11.42        | 11.41             | 12.02         | 72        | 5.02          | 5.02               | 6.04           | 80         | 1.02            |
| teal   | 10.69        | 10.69             | 11.32         | 69        | 5.47          | 5.47               | 6.53           | 82         | 1.09            |
| sky    | 9.29         | 9.28              | 10.06         | 62        | 5.93          | 5.93               | 7.04           | 84         | 1.26            |
| blue   | 7.83         | 7.82              | 8.76          | 54        | 6.70          | 6.70               | 7.86           | 87         | 1.49            |
| indigo | 6.67         | 6.67              | 7.68          | 48        | 7.90          | 7.90               | 9.10           | 91         | 1.75            |
| violet | 7.31         | 7.31              | 8.30          | 51        | 7.10          | 7.10               | 8.31           | 88         | 1.59            |
| pink   | 7.51         | 7.51              | 8.36          | 53        | 6.04          | 6.04               | 7.21           | 84         | 1.55            |

candidates:
brand-text L 0.5 #895700 white 6.11 zinc50 5.85 muted 5.55 subtle 5.67 apca 80.2
brand-text L 0.52 #8f5d00 white 5.62 zinc50 5.38 muted 5.10 subtle 5.21 apca 77.8
brand-text L 0.55 #986603 white 4.95 zinc50 4.74 muted 4.50 subtle 4.59 apca 74.0
brand-text L 0.56 #9b690b white 4.75 zinc50 4.55 muted 4.31 subtle 4.40 apca 72.7
brand-text L 0.58 #a26f17 white 4.37 zinc50 4.18 muted 3.97 subtle 4.05 apca 70.0
light ring L 0.552 #71717b white 4.83 zinc50 4.62
light ring L 0.5 #62626c white 6.02 zinc50 5.77
light ring L 0.45 #54545e white 7.47 zinc50 7.15
