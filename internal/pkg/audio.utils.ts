/**
 * Parse a 16-bit PCM WAV buffer into a Float32Array normalised to [-1, 1].
 *
 * Whisper expects audio as a Float32Array of mono 16kHz samples.
 * Standard WAV: 44-byte header, then raw 16-bit little-endian PCM data.
 * We scan for the 'data' chunk marker so non-standard headers (e.g. WAV
 * files with a LIST metadata chunk before the audio data) still work.
 */
export function wavToFloat32(wavBuffer: Buffer): Float32Array {
  let dataOffset = 44;
  for (let i = 12; i < wavBuffer.length - 8; i++) {
    if (wavBuffer.slice(i, i + 4).toString("ascii") === "data") {
      dataOffset = i + 8;
      break;
    }
  }

  const pcm = wavBuffer.subarray(dataOffset);
  const samples = new Float32Array(pcm.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return samples;
}
