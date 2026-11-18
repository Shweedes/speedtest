import http from 'node:http';
import https from 'node:https';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/**
 * Скачивает адрес целиком и возвращает, сколько байт получено и сколько это заняло.
 *
 * Время считается от начала запроса (включая DNS, TCP/TLS-рукопожатие и редиректы)
 * до получения последнего байта тела ответа. Если запрос не уложился в timeoutMs
 * целиком (а не просто «молчит»), он прерывается с ошибкой.
 *
 * Считаются именно байты, пришедшие по сети: мы просим сервер не сжимать ответ
 * (Accept-Encoding: identity) и сами ничего не распаковываем.
 *
 * @param {string} urlString
 * @param {{ timeoutMs?: number, maxRedirects?: number }} [options]
 * @returns {Promise<{ bytes: number, ms: number, status: number, url: string }>}
 */
export async function downloadOnce(
  urlString,
  { timeoutMs = DEFAULT_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS } = {},
) {
  const signal = AbortSignal.timeout(timeoutMs);
  const startedAt = performance.now();

  try {
    let url = new URL(urlString);

    for (let hop = 0; hop <= maxRedirects; hop++) {
      assertHttp(url);
      const res = await getResponse(url, signal);
      const status = res.statusCode;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        url = new URL(res.headers.location, url);
        continue;
      }

      if (status < 200 || status >= 300) {
        res.resume();
        throw new Error(`HTTP ${status}`);
      }

      let bytes = 0;
      for await (const chunk of res) bytes += chunk.length;

      return { bytes, ms: performance.now() - startedAt, status, url: url.href };
    }

    throw new Error(`слишком много редиректов (больше ${maxRedirects})`);
  } catch (err) {

    if (signal.aborted) {
      throw new Error(`таймаут: запрос не завершился за ${timeoutMs} мс`);
    }
    throw err;
  }
}

function assertHttp(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`поддерживаются только http и https, получено ${url.protocol}`);
  }
}

function getResponse(url, signal) {
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.get(
      url,
      {

        agent: false,
        signal,
        headers: {
          'Accept-Encoding': 'identity',
          Connection: 'close',
          'User-Agent': 'speedtest-cli/1.0',
        },
      },
      resolve,
    );
    req.on('error', reject);
  });
}
