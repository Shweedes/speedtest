#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { downloadOnce } from './src/download.js';
import { summarize, toMbitPerSecond, toMegabytes } from './src/stats.js';

const DEFAULT_COUNT = 10;
const DEFAULT_TIMEOUT_SEC = 30;

const USAGE = `Использование: node speedtest.js <url> [опции]

Делает последовательные запросы к адресу, дожидается полного ответа на каждый
и печатает среднее время запроса, объём данных и скорость скачивания.

Опции:
  -n, --count <число>      количество запросов (по умолчанию ${DEFAULT_COUNT})
  -t, --timeout <секунды>  таймаут на один запрос (по умолчанию ${DEFAULT_TIMEOUT_SEC})
  -h, --help               показать эту справку`;

class UsageError extends Error {}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        count: { type: 'string', short: 'n', default: String(DEFAULT_COUNT) },
        timeout: { type: 'string', short: 't', default: String(DEFAULT_TIMEOUT_SEC) },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw new UsageError(err.message);
  }

  const { values, positionals } = parsed;
  if (values.help) return { help: true };

  if (positionals.length !== 1) {
    throw new UsageError('нужно указать ровно один адрес (URL)');
  }

  const url = positionals[0];
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new UsageError(`некорректный URL: ${url}`);
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new UsageError('поддерживаются только адреса http:// и https://');
  }

  const count = Number(values.count);
  if (!Number.isInteger(count) || count < 1) {
    throw new UsageError('--count должен быть целым числом не меньше 1');
  }

  const timeoutSec = Number(values.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new UsageError('--timeout должен быть положительным числом (секунды)');
  }

  return { url, count, timeoutMs: timeoutSec * 1000 };
}

function row(label, value) {
  return `  ${label.padEnd(24)}${value}`;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const { url, count, timeoutMs } = options;
  console.log(`Адрес: ${url}`);
  console.log(`Запросов: ${count} (последовательно), таймаут на запрос: ${timeoutMs / 1000} с\n`);

  const results = [];
  let failed = 0;
  const width = String(count).length;

  // Запросы идут строго один за другим: следующий стартует только после того,
  // как предыдущий полностью получен (await внутри цикла — это и есть «последовательно»).
  for (let i = 1; i <= count; i++) {
    const label = `Запрос ${String(i).padStart(width)}/${count}`;
    try {
      const result = await downloadOnce(url, { timeoutMs });
      results.push(result);
      const speed = toMbitPerSecond(result.bytes, result.ms).toFixed(2);
      console.log(
        `${label}: ${toMegabytes(result.bytes).toFixed(2)} МБ за ${result.ms.toFixed(0)} мс (${speed} Мбит/с)`,
      );
    } catch (err) {
      failed++;
      console.error(`${label}: ошибка — ${err.message}`);
    }
  }

  console.log('\nИтого');
  if (results.length === 0) {
    console.log(row('Успешных запросов:', `0 из ${count}`));
    process.exitCode = 1;
    return;
  }

  const s = summarize(results);
  console.log(row('Успешных запросов:', `${s.count} из ${count}`));
  console.log(row('Среднее время запроса:', `${s.avgMs.toFixed(0)} мс`));
  console.log(row('Скачано всего:', `${toMegabytes(s.totalBytes).toFixed(2)} МБ (${s.totalBytes} байт)`));
  console.log(
    row('Скорость скачивания:', `${s.mbitPerSecond.toFixed(2)} Мбит/с (${s.mbytePerSecond.toFixed(2)} МБ/с)`),
  );

  // Код выхода 1, если хоть один запрос не удался: так скрипт удобно использовать в других скриптах.
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`Ошибка: ${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(`Непредвиденная ошибка: ${err.stack ?? err}`);
    process.exitCode = 1;
  }
});
