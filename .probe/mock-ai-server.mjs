/**
 * 本地模拟 OpenAI 兼容服务端（零依赖）。
 * 用途：捕获 Hogo-QA-tool 在真实浏览器里**实际发出的请求体**，
 * 用于验证「客户端接线」——不占用本机 Ollama，避免与 QA 抢资源。
 */
import http from 'node:http';
import fs from 'node:fs';

const LOG = 'E:/tools/Hogo-QA-tool/.probe/captured-requests.jsonl';
const PORT = 8899;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json',
};

fs.writeFileSync(LOG, '');

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  let raw = '';
  req.on('data', (c) => {
    raw += c;
  });
  req.on('end', () => {
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }
    fs.appendFileSync(
      LOG,
      JSON.stringify({ method: req.method, url: req.url, body: parsed }) + '\n',
    );

    if (req.url.includes('/models')) {
      res.writeHead(200, CORS);
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'qwen3.5:9b' }, { id: 'qwen2.5:14b' }],
        }),
      );
      return;
    }

    res.writeHead(200, CORS);
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: 'qwen3.5:9b',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content:
                '【MOCK-OK】这是本地模拟服务端返回的正文，用于验证客户端接线与渲染路径是否真的贯通。',
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      }),
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock-ai-server listening on 127.0.0.1:' + PORT);
});
