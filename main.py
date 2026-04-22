import os
import sys
import time
import json
import asyncio
import hashlib
import hmac
import uvicorn
import httpx
import webbrowser
from typing import Dict, Any
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

# --- 核心配置 ---
UPSTREAM_URL = "https://api.cherry-ai.com/chat/completions"
LISTEN_PORT = 8088

# 【最终密钥】
HMAC_SECRET_KEY = "K3RNPFx19hPh1AHr5E1wBEFfi4uYUjoCFuzjDzvS9cAWD8KuKJR8FOClwUpGqRRX.GvI6I5ZrEHcGOWjO5AKhJKGmnwwGfM62XKpWqkjhvzRU2NZIinM77aTGIqhqys0g"
# --- 核心配置结束 ---

# --- 签名函数 (V28.0 - 移除键排序，保持原始顺序) ---
def generate_signature(request_body: Dict[str, Any]) -> Dict[str, str]:
    """
    根据最终诊断结果，在 Python 中重新计算 HMAC-SHA256 签名。
    """
    method = "POST"
    path = "/chat/completions"
    query = ""
    client_id = "cherry-studio"
    timestamp = str(int(time.time()))
    
    # 【关键修正】: 移除 sort_keys=True。
    # 我们现在依赖于客户端发送的 JSON 对象的原始键顺序。
    body_str = json.dumps(request_body, separators=(',', ':'), ensure_ascii=False)
    
    signing_payload = f"{method}\n{path}\n{query}\n{client_id}\n{timestamp}\n{body_str}"
    
    signature = hmac.new(
        HMAC_SECRET_KEY.encode('utf-8'),
        signing_payload.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

    return {
        "x-timestamp": timestamp,
        "x-signature": signature,
        "x-client-id": client_id,
        "x-title": "Cherry Studio"
    }

# --- FastAPI Setup (无变动) ---
app = FastAPI(title="CherryProxy V28.0 - Final Stand")
templates_dir = "templates"
if not os.path.exists(templates_dir):
    os.makedirs(templates_dir)
index_html_path = os.path.join(templates_dir, "index.html")
if not os.path.exists(index_html_path):
    with open(index_html_path, "w", encoding="utf-8") as f:
        f.write("""
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Proxy Status</title>
            <style>
                body { font-family: sans-serif; background: #1a1a1a; color: #e0e0e0; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .container { text-align: center; padding: 40px; border-radius: 10px; background: #2a2a2a; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
                h1 { color: #4caf50; }
                p { font-size: 1.2em; }
                code { background: #333; padding: 3px 6px; border-radius: 4px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>✅ [已激活] CherryProxy V28.0 运行中</h1>
                <p>签名算法已最终校准，代理服务已激活。</p>
                <p>请将您的客户端指向 <code>http://127.0.0.1:8088/v1/chat/completions</code></p>
            </div>
        </body>
        </html>
        """)

templates = Jinja2Templates(directory=templates_dir)

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request): 
    return templates.TemplateResponse("index.html", {"request": request})

@app.post("/v1/chat/completions")
async def chat_proxy(request: Request):
    # FastAPI/Starlette 默认使用标准 json 库，它从 Python 3.7 开始保留顺序
    # 我们需要确保接收到的就是原始顺序的字典
    try:
        raw_body = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    try:
        signature_headers = generate_signature(raw_body)
    except Exception as e:
        print(f"Error generating signature: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Signature generation failed: {e}")

    headers = {
        "Content-Type": "application/json",
        "Origin": "https://cherry-ai.com",
        "Referer": "https://cherry-ai.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) CherryStudio/1.7.2 Chrome/140.0.7339.249 Electron/38.7.0 Safari/537.36",
        **signature_headers
    }

    async def upstream_generator():
        async with httpx.AsyncClient() as client:
            try:
                # httpx 的 json 参数也会使用标准 json 库，保留顺序
                async with client.stream("POST", UPSTREAM_URL, json=raw_body, headers=headers, timeout=120) as r:
                    if r.status_code != 200:
                        err_body = await r.aread()
                        error_detail = f'Upstream Error {r.status_code}: {err_body.decode()}'
                        print(error_detail, file=sys.stderr)
                        yield f"data: {json.dumps({'error': {'message': error_detail, 'type': 'upstream_error'}})}\n\n"
                        return

                    async for chunk in r.aiter_bytes():
                        yield chunk
            except Exception as net_err:
                error_detail = f'Network Error: {net_err}'
                print(error_detail, file=sys.stderr)
                yield f"data: {json.dumps({'error': {'message': error_detail, 'type': 'network_error'}})}\n\n"

    return StreamingResponse(upstream_generator(), media_type="text/event-stream")

if __name__ == "__main__":
    print(f"✅ [任务完成] 最终签名算法已部署，CherryProxy V28.0 启动！")
    print(f"📡 网关地址: http://127.0.0.1:{LISTEN_PORT}")
    try:
        webbrowser.open(f"http://127.0.0.1:{LISTEN_PORT}")
    except:
        pass
    uvicorn.run(app, host="0.0.0.0", port=LISTEN_PORT, use_colors=True, access_log=False)