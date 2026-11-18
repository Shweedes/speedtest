import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadOnce } from '../src/download.js';
import { summarize, toMbitPerSecond } from '../src/stats.js';

const CLI = fileURLToPath(new URL('../speedtest.js', import.meta.url));

/** Поднимает локальный сервер на свободном порту, выполняет fn(baseUrl) и гасит сервер. */
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Отправляет ответ несколькими кусками без Content-Length (chunked), как «настоящая» раздача. */
function sendChunks(res, chunks, size) {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  for (let i = 0; i < chunks; i++) res.write(Buffer.alloc(size, 1));
  res.end();
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('downloadOnce: считает точное число байт многокусочного ответа', async () => {
  await withServer(
    (req, res) => sendChunks(res, 10, 100_000),
    async (base) => {
      const result = await downloadOnce(`${base}/img.jpg`);
      assert.equal(result.bytes, 1_000_000);
      assert.equal(result.status, 200);
      assert.ok(result.ms > 0);
    },
  );
});

test('downloadOnce: идёт по редиректу и считает байты только конечного ответа', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/a') {
        res.writeHead(302, { Location: '/b' });
        res.end('redirecting...');
      } else {
        res.writeHead(200);
        res.end(Buffer.alloc(1234));
      }
    },
    async (base) => {
      const result = await downloadOnce(`${base}/a`);
      assert.equal(result.bytes, 1234);
      assert.equal(result.url, `${base}/b`);
    },
  );
});

test('downloadOnce: бесконечный редирект заканчивается ошибкой', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    },
    async (base) => {
      await assert.rejects(downloadOnce(`${base}/loop`), /слишком много редиректов/);
    },
  );
});

test('downloadOnce: статус не 2xx — это ошибка', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(404);
      res.end('nope');
    },
    async (base) => {
      await assert.rejects(downloadOnce(`${base}/missing`), /HTTP 404/);
    },
  );
});

test('downloadOnce: зависший ответ прерывается по таймауту', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(1000)); 
    },
    async (base) => {
      await assert.rejects(downloadOnce(`${base}/hang`, { timeoutMs: 300 }), /таймаут/);
    },
  );
});

test('downloadOnce: не-http протокол отклоняется', async () => {
  await assert.rejects(downloadOnce('ftp://example.com/file'), /только http и https/);
});

test('toMbitPerSecond: 1 000 000 байт за 1 с — это 8 Мбит/с', () => {
  assert.equal(toMbitPerSecond(1_000_000, 1000), 8);
});

test('summarize: среднее время и суммарный объём', () => {
  const s = summarize([
    { bytes: 1_000_000, ms: 1000 },
    { bytes: 3_000_000, ms: 3000 },
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.totalBytes, 4_000_000);
  assert.equal(s.avgMs, 2000);
  assert.equal(s.mbitPerSecond, 8);
});

test('summarize: скорость = всего байт / всего времени, а не среднее скоростей', () => {
  const s = summarize([
    { bytes: 1_000_000, ms: 1000 },
    { bytes: 1_000_000, ms: 3000 },
  ]);
  assert.equal(s.mbitPerSecond, 4);
  assert.equal(s.mbytePerSecond, 0.5);
});

test('summarize: пустой список не даёт NaN', () => {
  const s = summarize([]);
  assert.equal(s.avgMs, 0);
  assert.equal(s.mbitPerSecond, 0);
});

test('CLI: делает ровно 10 запросов по умолчанию и строго последовательно', async () => {
  let hits = 0;
  let active = 0;
  let maxActive = 0;

  await withServer(
    (req, res) => {
      hits++;
      active++;
      maxActive = Math.max(maxActive, active);
      res.on('finish', () => active--);
      res.writeHead(200);
      setTimeout(() => res.end(Buffer.alloc(10_000)), 20);
    },
    async (base) => {
      const { code, stdout } = await runCli([`${base}/img.jpg`]);
      assert.equal(code, 0);
      assert.equal(hits, 10);
      assert.equal(maxActive, 1, 'запросы не должны пересекаться по времени');
      assert.match(stdout, /Успешных запросов:\s+10 из 10/);
      assert.match(stdout, /Скачано всего:\s+0\.10 МБ \(100000 байт\)/);
      assert.match(stdout, /Скорость скачивания:\s+[\d.]+ Мбит\/с/);
    },
  );
});

test('CLI: --count меняет число запросов', async () => {
  let hits = 0;
  await withServer(
    (req, res) => {
      hits++;
      res.end('ok');
    },
    async (base) => {
      const { code } = await runCli([base, '--count', '3']);
      assert.equal(code, 0);
      assert.equal(hits, 3);
    },
  );
});

test('CLI: код выхода 1, если сервер отвечает ошибкой', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(500);
      res.end();
    },
    async (base) => {
      const { code, stderr, stdout } = await runCli([base, '-n', '2']);
      assert.equal(code, 1);
      assert.match(stderr, /ошибка — HTTP 500/);
      assert.match(stdout, /Успешных запросов:\s+0 из 2/);
    },
  );
});

test('CLI: без аргументов и с мусорным URL — код выхода 2 и справка', async () => {
  const noArgs = await runCli([]);
  assert.equal(noArgs.code, 2);
  assert.match(noArgs.stderr, /Использование:/);

  const badUrl = await runCli(['not a url']);
  assert.equal(badUrl.code, 2);
  assert.match(badUrl.stderr, /некорректный URL/);

  const badCount = await runCli(['http://127.0.0.1:1/', '-n', '0']);
  assert.equal(badCount.code, 2);
});
