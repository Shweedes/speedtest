const BYTES_IN_MB = 1_000_000;
const BITS_IN_BYTE = 8;

export function toMegabytes(bytes) {
  return bytes / BYTES_IN_MB;
}

export function toMbitPerSecond(bytes, ms) {
  if (ms <= 0) return 0;
  return (bytes * BITS_IN_BYTE) / BYTES_IN_MB / (ms / 1000);
}

/**
 * Сводка по успешным запросам.
 *
 * Скорость = ВСЕ скачанные байты / ВСЁ затраченное время.
 * Это не то же самое, что среднее арифметическое скоростей отдельных запросов:
 * медленный запрос «весит» больше, потому что занимал больше времени.
 *
 * @param {{ bytes: number, ms: number }[]} results
 */
export function summarize(results) {
  const count = results.length;
  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  return {
    count,
    totalBytes,
    totalMs,
    avgMs: count > 0 ? totalMs / count : 0,
    mbitPerSecond: toMbitPerSecond(totalBytes, totalMs),
    mbytePerSecond: totalMs > 0 ? toMegabytes(totalBytes) / (totalMs / 1000) : 0,
  };
}
