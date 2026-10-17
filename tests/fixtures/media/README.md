# Media fixtures (Playwright mocks)

Tiny, synthetic media served by `tests/support/mock-api.ts` with byte-range
support (`Accept-Ranges`, `206` + `Content-Range`), like Blob SAS URLs. The
podcast transcripts in the mock are timed on these durations.

| File | Content | Served for |
|---|---|---|
| `radio.mp3` | 30 s, 330 Hz tone, mono 16 kHz, CBR 8 kb/s | every `/media/*.mp3`, job `file/mp3` |
| `radio.wav` | 6 s, 440 Hz tone, mono 8 kHz, PCM u8 | every `/media/*.wav` |
| `video.mp4` | 40 s, 32×18 solid colour, 1 fps, VP9, no audio | the v2 episode video, job `file/mp4` |

Regenerate (ffmpeg ≥ 6, from the repo root):

```powershell
ffmpeg -y -f lavfi -i "sine=frequency=330:sample_rate=16000:duration=30" -af "volume=0.25" -ac 1 -ar 16000 -c:a libmp3lame -b:a 8k -map_metadata -1 -fflags +bitexact -id3v2_version 0 tests/fixtures/media/radio.mp3
ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=8000:duration=6" -af "volume=0.25" -ac 1 -ar 8000 -c:a pcm_u8 -map_metadata -1 -fflags +bitexact tests/fixtures/media/radio.wav
ffmpeg -y -f lavfi -i "color=c=0x1f3a5f:s=32x18:r=1:d=40" -c:v libvpx-vp9 -pix_fmt yuv420p -g 10 -b:v 20k -map_metadata -1 -fflags +bitexact -movflags +faststart tests/fixtures/media/video.mp4
```
