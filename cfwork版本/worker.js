/**
 * =================================================================================
 * 项目: Cherry-Link Pro (Cloudflare Worker 旗舰版)
 * 版本: 4.0.0 (代号: Stream Master)
 * 作者: 首席开发者体验架构师
 * 日期: 2025-12-10
 * 
 * [核心特性]
 * 1. [签名复刻] 1:1 还原 Python 后端 HMAC-SHA256 签名算法，确保鉴权通过。
 * 2. [双模响应] 智能识别 stream 参数：
 *    - stream: true -> 实时 SSE 流转发 (适合 Cherry Studio/NextChat)。
 *    - stream: false -> 自动聚合流数据为标准 JSON (完美适配沉浸式翻译)。
 * 3. [零配置] 密钥强制走环境变量，安全无忧。
 * 4. [驾驶舱] 内置全中文开发者 UI，含实时日志与集成指南。
 * =================================================================================
 */

// --- [第一部分: 核心配置] ---
const CONFIG = {
  PROJECT_NAME: "Cherry-Link Pro",
  VERSION: "4.0.0",
  
  // 上游接口地址
  UPSTREAM_URL: "https://api.cherry-ai.com/chat/completions",
  
  // 锁定模型
  DEFAULT_MODEL: "glm-4.5-flash",

    // 默认访问密码 (请在 Cloudflare 环境变量 API_MASTER_KEY 中设置)
  DEFAULT_API_KEY: "1",
  
  // 伪装头 (复刻 Python 版 User-Agent)
  HEADERS: {
    "Content-Type": "application/json",
    "Origin": "https://cherry-ai.com",
    "Referer": "https://cherry-ai.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) CherryStudio/1.7.2 Chrome/140.0.7339.249 Electron/38.7.0 Safari/537.36"
  }
};

// --- [第二部分: Worker 入口] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 注入环境变量
    request.ctx = {
      hmacKey: env.HMAC_SECRET_KEY || "",
      masterKey: env.API_MASTER_KEY || "1"
    };

    // 1. CORS 预检 (允许跨域)
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    // 2. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') return handleUI(request);

    // 3. 模型列表接口
    if (url.pathname === '/v1/models') return handleModels(request);

    // 4. 聊天接口 (核心逻辑)
    if (url.pathname.startsWith('/v1/chat/completions')) return handleChat(request);

    // 404
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心业务逻辑] ---

// 1. 签名生成器 (核心算法复刻)
async function generateSignature(requestBody, secretKey) {
  const method = "POST";
  const path = "/chat/completions";
  const query = "";
  const client_id = "cherry-studio";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  
  // JS JSON.stringify 默认紧凑输出，与 Python json.dumps(separators=(',', ':')) 一致
  // 且原生支持 UTF-8，无需特殊处理 ensure_ascii=False
  const bodyStr = JSON.stringify(requestBody);
  
  const signingPayload = `${method}\n${path}\n${query}\n${client_id}\n${timestamp}\n${bodyStr}`;
  
  // HMAC-SHA256 签名
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secretKey);
  const msgData = encoder.encode(signingPayload);

  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  const signatureHex = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    "x-timestamp": timestamp,
    "x-signature": signatureHex,
    "x-client-id": client_id,
    "x-title": "Cherry Studio"
  };
}

// 2. 模型列表处理
function handleModels(request) {
  return new Response(JSON.stringify({
    object: "list",
    data: [{
      id: CONFIG.DEFAULT_MODEL,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "cherry-link"
    }]
  }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

// 3. 聊天请求处理 (支持流式与非流式自动切换)
async function handleChat(request) {
  const requestId = crypto.randomUUID();
  
  try {
    // 鉴权
    if (!verifyAuth(request)) {
      return createErrorResponse('鉴权失败: 请检查 Authorization Header', 401, 'unauthorized');
    }

    if (!request.ctx.hmacKey) {
      return createErrorResponse("服务端未配置 HMAC_SECRET_KEY，请联系管理员。", 500, "config_error");
    }

    // 解析请求体
    let rawBody;
    try {
      rawBody = await request.json();
    } catch (e) {
      return createErrorResponse("无效的 JSON 请求体", 400, "invalid_json");
    }

    // 判断客户端是否请求流式
    // 沉浸式翻译通常不传 stream 或传 false
    const isStream = rawBody.stream === true;

    // 生成签名
    const signatureHeaders = await generateSignature(rawBody, request.ctx.hmacKey);

    // 构造上游请求
    const upstreamHeaders = {
      ...CONFIG.HEADERS,
      ...signatureHeaders
    };

    // 发送请求到 Cherry AI
    const response = await fetch(CONFIG.UPSTREAM_URL, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(rawBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`上游错误 (${response.status}): ${errText}`);
    }

    // --- 分支 A: 客户端请求流式 (stream: true) ---
    if (isStream) {
      const { readable, writable } = new TransformStream();
      response.body.pipeTo(writable);
      return new Response(readable, {
        headers: corsHeaders({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Request-ID': requestId
        })
      });
    }

    // --- 分支 B: 客户端请求非流式 (stream: false) ---
    // 适配沉浸式翻译：我们需要读取上游的 SSE 流，拼接成完整的 JSON 返回
    else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let usage = null;
      let finishReason = "stop";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') continue;
            
            try {
              const json = JSON.parse(dataStr);
              // 累积内容
              if (json.choices && json.choices[0].delta.content) {
                fullContent += json.choices[0].delta.content;
              }
              // 捕获 usage (如果有)
              if (json.usage) usage = json.usage;
              // 捕获 finish_reason
              if (json.choices && json.choices[0].finish_reason) {
                finishReason = json.choices[0].finish_reason;
              }
            } catch (e) { }
          }
        }
      }

      // 构造标准的 OpenAI 非流式响应
      const nonStreamResponse = {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: rawBody.model || CONFIG.DEFAULT_MODEL,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: fullContent
          },
          finish_reason: finishReason
        }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };

      return new Response(JSON.stringify(nonStreamResponse), {
        headers: corsHeaders({
          'Content-Type': 'application/json',
          'X-Request-ID': requestId
        })
      });
    }

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- [辅助函数] ---

function verifyAuth(request) {
  const auth = request.headers.get('Authorization');
  const key = request.ctx.masterKey;
  if (key === "1") return true; // 开放模式
  if (!auth) return false;
  // 支持 "Bearer sk-xxx" 或直接 "sk-xxx"
  return auth === `Bearer ${key}` || auth === key;
}

function createErrorResponse(msg, status, code) {
  return new Response(JSON.stringify({
    error: { message: msg, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

// --- [第四部分: 开发者驾驶舱 UI] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.masterKey;
  const hasSecret = !!request.ctx.hmacKey;
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cherry-Link 驾驶舱</title>
    <style>
        :root { --bg: #0f172a; --panel: #1e293b; --text: #e2e8f0; --accent: #f43f5e; --success: #10b981; --border: #334155; }
        body { margin: 0; font-family: 'Segoe UI', monospace; background: var(--bg); color: var(--text); height: 100vh; display: flex; overflow: hidden; }
        .sidebar { width: 340px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; gap: 15px; overflow-y: auto; }
        .main { flex: 1; display: flex; flex-direction: column; padding: 20px; gap: 20px; }
        
        h1 { margin: 0; font-size: 18px; color: var(--accent); display: flex; align-items: center; gap: 10px; }
        .badge { font-size: 10px; background: var(--accent); color: #fff; padding: 2px 6px; border-radius: 4px; }
        
        .card { background: rgba(0,0,0,0.2); padding: 12px; border-radius: 8px; border: 1px solid var(--border); }
        .label { font-size: 12px; color: #94a3b8; margin-bottom: 5px; display: block; font-weight: 600; }
        .value-box { background: #0f172a; padding: 8px; border-radius: 4px; font-family: monospace; font-size: 11px; word-break: break-all; cursor: pointer; border: 1px solid var(--border); transition: 0.2s; }
        .value-box:hover { border-color: var(--accent); }
        
        .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 5px; }
        .status-ok { background: var(--success); box-shadow: 0 0 5px var(--success); }
        .status-err { background: #ef4444; box-shadow: 0 0 5px #ef4444; }

        .tabs { display: flex; gap: 5px; margin-bottom: 10px; border-bottom: 1px solid var(--border); }
        .tab { background: transparent; border: none; color: #94a3b8; cursor: pointer; padding: 8px 10px; border-bottom: 2px solid transparent; font-size: 12px; }
        .tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: bold; }
        
        .guide-content { font-size: 12px; line-height: 1.6; color: #cbd5e1; display: none; }
        .guide-content.active { display: block; }
        code { background: #334155; padding: 2px 4px; border-radius: 3px; color: #fff; font-family: monospace; }
        
        .terminal { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; font-family: monospace; font-size: 12px; }
        .logs { flex: 1; padding: 15px; overflow-y: auto; color: #a5b4fc; }
        .input-area { padding: 10px; border-top: 1px solid var(--border); display: flex; gap: 10px; background: var(--panel); }
        input { flex: 1; background: #0f172a; border: 1px solid var(--border); color: #fff; padding: 8px; border-radius: 4px; }
        button { background: var(--accent); color: #fff; border: none; padding: 8px 20px; border-radius: 4px; cursor: pointer; font-weight: bold; }
        button:disabled { opacity: 0.6; cursor: not-allowed; }

        .log-entry { margin-bottom: 5px; border-bottom: 1px solid #1e293b; padding-bottom: 2px; }
        .log-time { color: #64748b; margin-right: 8px; }
        .log-type { font-weight: bold; margin-right: 8px; }
        .log-req { color: #38bdf8; } .log-res { color: #4ade80; } .log-err { color: #f87171; }
        
        .highlight { color: var(--accent); font-weight: bold; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h1>🍒 Cherry-Link <span class="badge">Pro</span></h1>
        
        <div class="card">
            <span class="label">系统状态</span>
            <div style="font-size: 12px; display: flex; align-items: center;">
                <span class="status-dot ${hasSecret ? 'status-ok' : 'status-err'}"></span>
                ${hasSecret ? 'HMAC 密钥已配置' : '⚠️ 未配置 HMAC_SECRET_KEY'}
            </div>
            <div style="font-size: 11px; color: #64748b; margin-top: 5px;">
                模型锁定: <span style="color: #e2e8f0">${CONFIG.DEFAULT_MODEL}</span>
            </div>
        </div>

        <div class="card">
            <span class="label">API 接口地址 (点击复制)</span>
            <div class="value-box" onclick="copy('${origin}/v1')">${origin}/v1</div>
        </div>

        <div class="card">
            <span class="label">API Key (点击复制)</span>
            <div class="value-box" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="card">
            <span class="label">客户端集成指南</span>
            <div class="tabs">
                <button class="tab active" onclick="showGuide('immersive')">沉浸式翻译</button>
                <button class="tab" onclick="showGuide('nextchat')">NextChat</button>
                <button class="tab" onclick="showGuide('curl')">cURL</button>
            </div>
            
            <div id="immersive" class="guide-content active">
                <p><span class="highlight">✅ 完美适配 (自动转非流式)</span></p>
                1. 打开插件设置 -> 开发者设置 -> <strong>OpenAI</strong><br>
                2. API Key: <code>${apiKey}</code><br>
                3. API URL: <code>${origin}/v1/chat/completions</code><br>
                4. 模型: 手动输入 <code>${CONFIG.DEFAULT_MODEL}</code><br>
                5. 频率限制: 建议 <strong>1000000 QPS</strong>
            </div>
            <div id="nextchat" class="guide-content">
                <p><span class="highlight">✅ 支持流式打字机效果</span></p>
                1. 接口地址: <code>${origin}</code> (注意不带 /v1)<br>
                2. API Key: <code>${apiKey}</code><br>
                3. 自定义模型: <code>+${CONFIG.DEFAULT_MODEL}</code>
            </div>
            <div id="curl" class="guide-content">
                <code>curl ${origin}/v1/chat/completions \<br>
                -H "Authorization: Bearer ${apiKey}" \<br>
                -d '{"model": "${CONFIG.DEFAULT_MODEL}", "messages": [{"role":"user","content":"hi"}]}'</code>
            </div>
        </div>
    </div>

    <div class="main">
        <div class="terminal">
            <div class="logs" id="logs">
                <div class="log-entry"><span class="log-time">[SYSTEM]</span> 驾驶舱已就绪。支持流式(Stream)与非流式(JSON)双模响应。</div>
                <div class="log-entry"><span class="log-time">[INFO]</span> 正在监听 ${origin}/v1/chat/completions ...</div>
            </div>
            <div class="input-area">
                <input type="text" id="prompt" placeholder="输入测试消息 (例如: 你好)..." onkeypress="if(event.key==='Enter') sendTest()">
                <button id="btn" onclick="sendTest()">🚀 发送测试</button>
            </div>
        </div>
    </div>

    <script>
        function copy(text) {
            navigator.clipboard.writeText(text);
            alert('已复制到剪贴板');
        }

        function showGuide(id) {
            document.querySelectorAll('.guide-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
            document.getElementById(id).classList.add('active');
            event.target.classList.add('active');
        }

        function log(type, msg) {
            const div = document.createElement('div');
            div.className = 'log-entry';
            const time = new Date().toLocaleTimeString();
            const colorClass = type === 'REQ' ? 'log-req' : (type === 'RES' ? 'log-res' : 'log-err');
            div.innerHTML = \`<span class="log-time">[\${time}]</span><span class="log-type \${colorClass}">\${type}</span>\${msg}\`;
            const logs = document.getElementById('logs');
            logs.appendChild(div);
            logs.scrollTop = logs.scrollHeight;
        }

        async function sendTest() {
            const prompt = document.getElementById('prompt').value;
            if(!prompt) return;
            
            const btn = document.getElementById('btn');
            btn.disabled = true;
            btn.innerText = "请求中...";
            
            log('REQ', \`发送: \${prompt} (Stream: True)\`);
            
            try {
                const res = await fetch('/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ${apiKey}'
                    },
                    body: JSON.stringify({
                        model: '${CONFIG.DEFAULT_MODEL}',
                        messages: [{role: 'user', content: prompt}],
                        stream: true // Web UI 测试默认使用流式
                    })
                });

                if(!res.ok) throw new Error(await res.text());

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let fullText = "";

                while(true) {
                    const {done, value} = await reader.read();
                    if(done) break;
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\\n');
                    for(const line of lines) {
                        if(line.startsWith('data: ')) {
                            const data = line.slice(6);
                            if(data === '[DONE]') break;
                            try {
                                const json = JSON.parse(data);
                                const content = json.choices[0].delta.content || "";
                                fullText += content;
                                // 这里可以做实时更新 UI，但为了日志整洁，我们只在最后打印完整结果
                            } catch(e){}
                        }
                    }
                }
                log('RES', fullText);

            } catch(e) {
                log('ERR', e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = "🚀 发送测试";
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
