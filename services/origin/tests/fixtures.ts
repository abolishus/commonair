// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Playlists as MediaMTX 1.21.2 serves them (LL-HLS, fMP4), captured from a live
 * test pattern. The rendition report and audio-only fixtures follow the same shapes.
 */

export const SESSION = "5565db7c-d34e-4a36-adf9-30f3d705b919";

export const MULTIVARIANT = `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio2",AUTOSELECT=YES,DEFAULT=YES,URI="audio2_stream.m3u8?session=${SESSION}"

#EXT-X-STREAM-INF:BANDWIDTH=2117768,AVERAGE-BANDWIDTH=2034053,CODECS="avc1.42c01e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30.000,AUDIO="audio"
video1_stream.m3u8?session=${SESSION}
`;

export const MEDIA = `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-TARGETDURATION:1
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.50000,CAN-SKIP-UNTIL=6.00000
#EXT-X-PART-INF:PART-TARGET=0.20000
#EXT-X-MEDIA-SEQUENCE:33
#EXT-X-MAP:URI="54dd20fd99ec_video1_init.mp4?session=${SESSION}"
#EXTINF:1.00000,
54dd20fd99ec_video1_seg33.mp4?session=${SESSION}
#EXTINF:1.00000,
54dd20fd99ec_video1_seg34.mp4?session=${SESSION}
#EXT-X-PROGRAM-DATE-TIME:2026-10-18T21:21:42.825Z
#EXT-X-PART:DURATION=0.20000,URI="54dd20fd99ec_video1_part155.mp4?session=${SESSION}",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.20000,URI="54dd20fd99ec_video1_part156.mp4?session=${SESSION}"
#EXTINF:1.00000,
54dd20fd99ec_video1_seg35.mp4?session=${SESSION}
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="54dd20fd99ec_video1_part157.mp4?session=${SESSION}"
#EXT-X-RENDITION-REPORT:URI="audio2_stream.m3u8?session=${SESSION}",LAST-MSN=35,LAST-PART=1
`;

/** Rendition paths (`live/<slug>/<r>`) are separate MediaMTX paths with their own multivariant playlist. */
export const rendition720 = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio2",AUTOSELECT=YES,DEFAULT=YES,URI="audio2_stream.m3u8?session=aaaa"

#EXT-X-STREAM-INF:BANDWIDTH=1400000,AVERAGE-BANDWIDTH=1300000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30.000,AUDIO="audio"
video1_stream.m3u8?session=aaaa
`;

export const rendition480 = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.64001e",RESOLUTION=854x480,FRAME-RATE=30.000
video1_stream.m3u8?session=bbbb
`;

export const renditionAudio = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-STREAM-INF:BANDWIDTH=140000,CODECS="mp4a.40.2"
audio1_stream.m3u8?session=cccc
`;
