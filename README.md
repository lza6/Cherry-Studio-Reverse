# Cherry Studio API 签名逆向工程

> 🚀 **完整复现 Cherry Studio v1.7.2+ 的 HMAC-SHA256 签名算法 | 一键部署代理服务**

[![Python](https://img.shields.io/badge/Python-3.10%2B-blue?logo=python)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104.1-green?logo=fastapi)](https://fastapi.tiangolo.com/)
[![License](https://img.shields.io/badge/License-MIT-orange)](LICENSE)
[![Status](https://img.shields.io/badge/Reverse%20Engineering-Completed-success?logo=github)](https://github.com/lza6/Cherry-Studio-Reverse)

---

## 📋 项目简介

本项目完整记录了 **Cherry Studio 桌面应用（v1.7.2+）** 的 API 签名逆向工程全过程。

**核心成果**：
- ✅ 成功破解 `x-signature` 请求头的 HMAC-SHA256 生成算法
- ✅ 完整获取密钥：`K3RNPFx19hPh1AHr5E1wBEFfi4uYUjoCFuzjDzvS9cAWD8KuKJR8FOClwUpGqRRX.GvI6I5ZrEHcGOWjO5AKhJKGmnwwGfM62XKpWqkjhvzRU2NZIinM77aTGIqhqys0g`
- ✅ 实现生产级 FastAPI 代理服务，支持流式 SSE 转发
- ✅ 详细逆向方法论文档，支持未来版本升级复用

**目标端点**：`https://api.cherry-ai.com/chat/completions`

---

## 🎯 快速开始

### 一键启动代理

```bash
# 1. 克隆仓库
git clone https://github.com/lza6/Cherry-Studio-Reverse.git
cd Cherry-Studio-Reverse

# 2. 安装依赖
pip install -r requirements.txt

# 3. 启动服务
python main.py
```

服务启动后，访问 `http://127.0.0.1:8088` 查看状态页。

**客户端配置**：
```json
{
  "base_url": "http://127.0.0.1:8088/v1/chat/completions",
  "model": "any-cherry-model"
}
```

---

## 🔬 核心技术发现

### 签名算法完整规格

| 字段 | 值 | 说明 |
|------|-----|------|
| **算法** | HMAC-SHA256 | 密码学安全 |
| **端点** | `/chat/completions` | POST |
| **密钥** | `K3R...` (见上文) | 硬编码在 Electron 主进程 |
| **载荷结构** | 6行文本（`\n` 分隔） | 顺序严格固定 |

#### 签名载荷详情

```
第1行：POST                ← HTTP方法
第2行：/chat/completions    ← API路径
第3行：（空字符串）         ← 查询参数（无）
第4行：cherry-studio        ← x-client-id值
第5行：1733179200           ← Unix时间戳（秒）
第6行：{"model":"...","messages":[...]}  ← 原始JSON（**不哈希、不排序**）
```

#### 必需的HTTP请求头

| Header | 值来源 | 示例 |
|--------|--------|------|
| `x-signature` | HMAC-SHA256(密钥, 载荷).hexdigest() | `a1b2c3...` |
| `x-timestamp` | `int(time.time())` 转字符串 | `1733179200` |
| `x-client-id` | 固定值 | `cherry-studio` |
| `x-title` | 固定值 | `Cherry Studio` |
| `User-Agent` | Cherry Studio 1.7.2 | 用于版本伪装 |
| `Origin` | `https://cherry-ai.com` | 来源伪造 |
| `Referer` | `https://cherry-ai.com/` | 引用页伪造 |

---

## 🗺️ 逆向工程路线图（7阶段完整流程）

### 阶段概览

```
阶段0：目标侦察 → 阶段1：JS定位 → 阶段2：解包Electron → 阶段3：白盒注入
    ↓                ↓                ↓                  ↓
  HAR分析       Call Stack       asar extract     console.log
  发现签名      追踪函数        获取主进程代码      打印密钥+载荷
```

### 📊 各阶段详细方法

#### ⭐ 阶段 0：情报收集（黑盒分析）
**难度**：⭐⭐（新手级）｜**耗时**：10分钟

**技术方法**：
1. 使用 Chrome DevTools → Network Tab 捕获请求
2. 导出 HAR 文件或直接在 DevTools 查看：
   - 发现 `x-signature` 请求头
   - 发现 `x-timestamp` 请求头
   - 查看 Call Stack 追踪 JS 调用链

**搜索关键词**（供AI/爬虫索引）：
```
cherry studio api signature reverse
x-signature header bypass
cherry-ai.com POST /chat/completions
HMAC-SHA256 bypass tutorial
```

**产出物**：
- 确认签名存在
- 确认算法家族（HMAC-SHA256，常见模式）
- 初步假设payload结构

**常见错误预设**：
```python
# ❌ 错误1：载荷使用 Body SHA256 哈希
payload = f"{method}\n{path}\n{sha256(body)}\n{timestamp}"

# ❌ 错误2：假设 JSON 键需要排序
json.dumps(body, sort_keys=True)  # 实际不需要！
```

---

#### ⭐⭐ 阶段 1：JavaScript 定位
**难度**：⭐⭐⭐（进阶级）｜**耗时**：30分钟

**技术方法**：
1. **Call Stack 回溯**：
   - DevTools → Network → 目标请求 → Call Stack
   - 找到 `generateSignature` 或类似函数调用

2. **代码搜索**：
   ```bash
   # 在 Chrome DevTools Sources 中搜索：
   window.api.cherryai.generateSignature
   # 或
   createHmac
   ```

3. **文件识别**：
   ```
   dist-*.js      ← 通用库
   store-*.js     ← 业务逻辑（重点！）
   ```

**搜索关键词**：
```
"window.api.cherryai" site:github.com
"generateSignature" electron js
"cherry-ai" api wrapper
```

**关键发现**（本项目的突破点）：
```javascript
// 在 store-Dy89cVhB.js 中发现：
case "cherryai":
    config$15.options.fetch = async (url$1, options) => {
        const signature = await window.api.cherryai.generateSignature({
            method: options.method,
            path: url$1.pathname,
            body: options.body
        });
        // 签名注入 headers...
    };
    break;
```

**洞见**：签名计算发生在 **Electron 主进程**（后端），而非渲染进程（前端）。这意味着密钥安全存储在 Node.js 环境中，无法直接从 JS 代码中提取。

---

#### ⭐⭐⭐ 阶段 2：解包 Electron asar
**难度**：⭐⭐⭐⭐（高级）｜**耗时**：15分钟

**技术方法**：
1. 找到 Cherry Studio 安装目录下的 `resources/app.asar`
2. 安装 asar 工具：
   ```bash
   npm install -g asar
   ```
3. 解包：
   ```bash
   asar extract app.asar unpacked_app
   ```

**解包后结构**：
```
unpacked_app/
├── out/main/index.js          ← 主进程入口（核心！）
├── out/renderer/...           ← 渲染进程（前端页面）
├── store-Dy89cVhB.js          ← 解包后的业务逻辑
└── package.json
```

**搜索关键词**：
```
electron asar extract tutorial
asar unpack command line
electron app reverse engineering
asar extract error sandbox violation
```

**备选方案**：
- 如果 asar 报错，尝试 `--unpack-dir` 参数
- 或者直接修改 asar 文件（二进制编辑）

---

#### ⭐⭐⭐⭐ 阶段 3：白盒代码注入
**难度**：⭐⭐⭐⭐⭐（专家级）｜**耗时**：45分钟

**技术方法**：
这是**最关键的一步**——需要修改主进程代码，打印出运行时密钥。

1. **定位签名函数**：
   ```bash
   # 在 unpacked_app/out/main/index.js 中搜索：
   grep -n "generateSignature" out/main/index.js
   # 或
   grep -n "HMAC" out/main/index.js
   ```

2. **注入 console.log**：
   ```javascript
   // 修改函数返回前的代码：
   async function generateSignature(options) {
       const method = options.method || "POST";
       const path = options.path || "/chat/completions";
       const body = options.body ? JSON.stringify(options.body) : "";
       const timestamp = Math.floor(Date.now() / 1000).toString();
       const clientId = "cherry-studio";

       // 原有计算逻辑...
       const signingPayload = `${method}\n${path}\n\n${clientId}\n${timestamp}\n${body}`;

       // 🔴 关键注入点：
       console.log("=== HMAC_SECRET_KEY ===");
       console.log(HMAC_SECRET_KEY);  // 打印密钥
       console.log("=== SIGNING_PAYLOAD ===");
       console.log(signingPayload);   // 打印载荷
       console.log("=== SIGNATURE ===");
       console.log(signature);        // 打印最终签名

       return {
           signature: signature,
           timestamp: timestamp,
           clientId: clientId
       };
   }
   ```

3. **重新打包或直接运行**：
   ```bash
   # 方案A：打包回asar（测试）
   asar pack unpacked_app app_modified.asar
   # 替换原文件（需权限）

   # 方案B：直接修改源文件运行（推荐）
   # 在解包目录启动应用（如果可执行）
   ```

4. **捕获日志**：
   - 启动 Cherry Studio（修改版）
   - 发起一次聊天请求
   - 从终端/控制台复制完整的密钥和payload

**搜索关键词**：
```
code injection console.log tutorial
javascript hook function print
node.js debug print all variables
console.log capture terminal output
```

**风险提示**：
⚠️ 此操作可能违反服务条款，仅供安全研究使用。

---

#### ⭐ 阶段 4：本地复现验证
**难度**：⭐⭐（新手级）｜**耗时**：20分钟

**目标**：用 Python 精确复现签名，确保与真实签名 100% 匹配。

**关键细节**：
1. **JSON 键顺序保留**（Python 3.7+ 默认保留）：
   ```python
   # ❌ 错误：排序键
   json.dumps(body, sort_keys=True)  # ❌ 不要排序

   # ✅ 正确：保留原始顺序
   json.dumps(body, separators=(',', ':'), ensure_ascii=False)
   ```

2. **载荷空行**：第 3 行必须是**完全空字符串**，不是 `null` 或空格

3. **时间戳转换**：
   ```python
   timestamp = str(int(time.time()))  # 整数转字符串
   ```

4. **编码一致性**：
   ```python
   signing_payload.encode('utf-8')  # 必须 UTF-8
   HMAC_SECRET_KEY.encode('utf-8')
   ```

**验证脚本**：
```python
# test_signature.py
import hashlib, hmac, json, time

# 从注入日志复制的真实值
HMAC_SECRET_KEY = "..."
real_signature = "..."  # 从日志复制
real_payload = "..."    # 从日志复制

# 本地计算
local = hmac.new(
    HMAC_SECRET_KEY.encode('utf-8'),
    real_payload.encode('utf-8'),
    hashlib.sha256
).hexdigest()

assert local == real_signature, "❌ 不匹配！检查载荷构造"
print("✅ 签名完全匹配！")
```

---

#### ⭐⭐ 阶段 5：生产代理部署
**难度**：⭐⭐⭐（进阶级）｜**耗时**：1小时

**架构设计**：
```
客户端 (Chat Client / OpenAI SDK)
    ↓ 请求原始JSON（无签名）
本地代理 (127.0.0.1:8088)
    ↓ 计算 x-signature 等头
    ↓ 伪造 UA/Origin/Referer
上游 API (api.cherry-ai.com)
    ↓ 流式 SSE 响应
本地代理 (逐字节转发)
    ↓ 分块传输
客户端 (实时接收)
```

**核心特性**：
- 异步流式转发（`httpx.AsyncClient().stream()`）
- SSE 错误事件注入（上游失败时通知客户端）
- 完整的错误处理（JSON解析、网络异常、非200响应）
- 状态页 Dashboard（Jinja2 模板）

**搜索关键词**：
```
fastapi streaming response sse tutorial
httpx async stream chunk forward
fastapi proxy middleware pattern
uvicorn production deployment
```

---

## 🛠️ 技术栈分析

### 后端技术

| 技术 | 版本 | 用途 | 选择理由 | 获取途径 |
|------|------|------|----------|----------|
| **FastAPI** | 0.104.1+ | Web框架 | 自动文档、异步原生、类型安全 | PyPI |
| **uvicorn** | 0.24.0+ | ASGI服务器 | 热重载、性能佳、标准 | PyPI |
| **httpx** | 0.26.0+ | HTTP客户端 | 异步流式、HTTP/2支持 | PyPI |
| **Jinja2** | 3.1.3 | 模板引擎 | 轻量、Python生态标准 | PyPI |
| **Python** | 3.10+ | 运行时 | 字典顺序保持、生态丰富 | python.org |

### 逆向工具链

| 工具 | 用途 | 安装方式 | 难度 |
|------|------|----------|------|
| **asar** | Electron包解包 | `npm i -g asar` | ⭐⭐ |
| **Chrome DevTools** | 网络嗅探/Call Stack | 浏览器内置 | ⭐ |
| **HAR Analyzer** | HTTP存档解析 | 在线工具/插件 | ⭐ |
| **Node.js** | 运行Electron工具 | nodejs.org | ⭐⭐ |

---

## 📈 难度评级体系

### 综合难度评分

| 阶段 | 技术点 | 难度⭐ | 前置技能 | 时间估算 |
|------|--------|-------|----------|----------|
| **0. 黑盒分析** | HAR解析、Call Stack追踪 | ⭐⭐ | 浏览器基础 | 10-30min |
| **1. JS定位** | 代码搜索、函数追踪 | ⭐⭐⭐ | JS基础、调试 | 20-60min |
| **2. 解包asar** | Electron打包格式 | ⭐⭐⭐⭐ | Node.js/npm | 10-20min |
| **3. 代码注入** | 运行时日志注入 | ⭐⭐⭐⭐⭐ | 逆向思维 | 30-90min |
| **4. 本地复现** | HMAC、JSON序列化 | ⭐ | Python基础 | 15-30min |
| **5. 代理部署** | FastAPI异步流式 | ⭐⭐⭐ | Web开发 | 45-120min |

**总体难度**：⭐⭐⭐⭐（专家级逆向工程）

**适合人群**：
- ✅ 有浏览器开发者工具使用经验
- ✅ 了解 HMAC、SHA256 等基础密码学概念
- ✅ 熟悉 Python 异步编程（`async/await`）
- ✅ 听说过 Electron / asar 打包机制

**不适合**：
- ❌ 完全无编程经验
- ❌ 不了解 HTTP 协议基础
- ❌ 期望"一键脚本"无理解

---

## 🔍 技术来源搜索指南

### GitHub 代码搜索策略

```bash
# 精确搜索（找到原始代码片段）
“window.api.cherryai” repo:electron /electron
“generateSignature” path:*.js language:javascript

# 相似实现参考
“hmac signature bypass” language:python
“fastapi async proxy” stars:>100
“asar extract” electron asar
```

### 技术博客/社区参考

| 技术点 | 搜索关键词 | 推荐社区 |
|--------|-----------|----------|
| **HMAC逆向** | "api signature reverse engineering案例" | 看雪、吾爱破解 |
| **Electron脱壳** | "electron asar unpack tutorial" | Reddit r/ReverseEngineering |
| **FastAPI代理** | "fastapi streaming proxy pattern" | StackOverflow、Medium |
| **代码注入** | "node.js console.log all variables" | GitHub Gist |

### SEO搜索优化（供爬虫理解）

```
cherry studio api reverse engineering - full tutorial
bypass x-signature header cherry studio
electron app signature algorithm extraction
hmac-sha256 payload structure analysis
fastapi async streaming reverse proxy
asar extract main process code injection
```

---

## 🚀 扩展方向与升级建议

### 短期改进（1-2天）

#### 1. 密钥动态化（⭐⭐⭐⭐ 级）
```python
# 当前：硬编码密钥（版本更新即失效）
# 升级：监控密钥变更日志，自动热更新
class SignatureRotator:
    def __init__(self):
        self.current_key = None
        self.watch_log_file("/path/to/cherry.log")
```

#### 2. 请求鉴权（⭐⭐⭐⭐ 级）
```python
# 防止代理被恶意滥用
API_KEYS = {"sk-proj-xxxx": "user1"}

@app.middleware("http")
async def check_api_key(request: Request, call_next):
    if request.url.path.startswith("/v1/"):
        key = request.headers.get("X-Proxy-Key")
        if key not in API_KEYS:
            return JSONResponse({"error": "Invalid key"}, 401)
    return await call_next(request)
```

#### 3. 多端点支持（⭐⭐⭐ 级）
```python
# 当前仅支持 /chat/completions
# 升级：支持 /models、/embeddings 等
ENDPOINT_MAP = {
    "/chat/completions": {"signature_template": "..."},
    "/embeddings": {"signature_template": "..."},
}
```

### 中期增强（1-2周）

#### 4. Prometheus监控（⭐⭐⭐⭐⭐ 级）
```python
from prometheus_client import Counter, Histogram

REQUEST_COUNT = Counter('cherry_proxy_requests_total', 'Total requests', ['endpoint', 'status'])
ERROR_RATE = Counter('cherry_proxy_errors_total', 'Total errors', ['type'])
LATENCY = Histogram('cherry_proxy_latency_seconds', 'Request latency', ['endpoint'])

@app.post("/v1/chat/completions")
@LATENCY.labels(endpoint="/chat/completions").time()
async def chat_proxy(request: Request):
    REQUEST_COUNT.labels(endpoint="/chat/completions").inc()
    # ...
```

#### 5. Docker + Health Check（⭐⭐⭐⭐ 级）
```dockerfile
# Dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8088/ || exit 1
EXPOSE 8088
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8088"]
```

#### 6. Redis缓存（⭐⭐⭐⭐ 级）
```python
# 签名结果缓存（相同请求体）
import redis
r = redis.Redis()

async def get_cached_signature(body_hash: str) -> Optional[Dict]:
    key = f"signature:{body_hash}"
    if cached := r.get(key):
        return json.loads(cached)
    return None
```

### 长期架构（1月+）

#### 7. 多账户池（⭐⭐⭐⭐⭐ 级）
```python
# 支持多个 Cherry Studio 密钥轮换使用
class MultiKeyPool:
    """
    场景：不同账号有不同HMAC密钥
    解决：自动负载均衡、故障切换
    """
    def __init__(self, keys: List[str]):
        self.keys = [KeyWrapper(k) for k in keys]
        self.index = 0

    def next_key(self) -> str:
        """轮询选择下一个密钥"""
        key = self.keys[self.index]
        self.index = (self.index + 1) % len(self.keys)
        return key
```

#### 8. WebUI管理后台（⭐⭐⭐⭐ 级）
```python
# 新增：监控面板
@app.get("/admin")
async def admin_dashboard():
    """
    展示：
    - 当前活跃密钥版本
    - 请求QPS/成功率/延迟
    - 上游健康状态
    - 日志流式查看
    """
```

#### 9. 插件系统（⭐⭐⭐⭐⭐⭐ 级）
```python
# 架构：SignatureProvider接口
class SignatureProvider(ABC):
    @abstractmethod
    def generate(self, body: dict) -> Dict[str, str]:
        pass

# 插件1：LocalHMACProvider（当前）
# 插件2：RemoteSigner（远程签名服务）
# 插件3：MockProvider（测试用）
```

---

## 🔄 版本升级应对策略

当 Cherry Studio 更新客户端时，按此流程快速恢复：

```
🔍 检测到签名失败？
    ↓ 查看日志 "Signature mismatch"
    ↓
📦 1. 解包新版 app.asar
    asar extract resources/app.asar unpacked_v2/
    ↓
🔧 2. 注入日志到 generateSignature
    （复用 stage3 注入脚本）
    ↓
🚀 3. 运行新版 Cherry Studio
    （发起任意聊天请求）
    ↓
📋 4. 从控制台提取新密钥和新载荷结构
    ↓
🔄 5. 更新 main.py 的 HMAC_SECRET_KEY
    ↓
✅ 6. 重启代理服务
```

**自动化脚本预留**：`scripts/update_signature.py`

---

## 📚 项目文件说明

```
cherry-studio-reverse/
├── main.py                    # FastAPI代理主程序 (145行)
│   ├── generate_signature()   # 签名生成核心算法 (V28.0)
│   ├── /v1/chat/completions   # 流式代理端点
│   └── upstream_generator()   # 异步SSE转发器
│
├── requirements.txt           # Python依赖清单 (8项)
├── templates/
│   └── index.html             # 状态页模板 (86行)
│
├── 逆向文档.txt               # 详细逆向工程报告（7阶段记录）
│   ├── 阶段0-5：方法论全景
│   ├── 迭代修正表（V25.0 → V28.0）
│   └── 错误假设与修正日志
│
└── README.md                  # 本文档（主入口）
```

---

## ⚠️ 免责声明

本项目**仅供安全研究与学习使用**。逆向工程可能违反 Cherry Studio 的服务条款。

**使用本代码即表示你同意**：
- ✅ 仅用于个人学习、安全研究
- ✅ 不用于商业用途
- ✅ 不绕过付费功能
- ✅ 遵守当地法律法规
- ✅ 不攻击或滥用 Cherry Studio 服务

**项目不提供**：
- ❌ 持续维护保证（密钥可能随时变更）
- ❌ 技术支持（社区Issue仅讨论技术）
- ❌ 任何形式的担保

---

## 🙏 贡献

欢迎提交 Issue 和 PR！

**贡献方向**：
- 🐛 发现 Cherry Studio 新版签名变化？提 Issue 分享
- 🔬 找到更好的密钥提取方法？欢迎 PR
- 📦 增加 Docker 部署方案
- 📊 添加 Prometheus + Grafana 监控模板
- 🌐 支持更多 Cherry Studio API 端点

---

## 📖 参考资源

### 官方资源
- Cherry Studio 官网：https://cherry-ai.com
- Electron asar 文档：https://github.com/electron/asar

### 技术社区
- 逆向工程：https://reverseengineering.stackexchange.com
- FastAPI 教程：https://fastapi.tiangolo.com
- HTTP 签名 RFC：https://datatracker.ietf.org/doc/html/rfc5849

---

## 📊 历史迭代

| 版本 | 核心变更 | 状态 |
|------|---------|------|
| **V25.0** | 基于 HAR 的初步猜测（Body 哈希） | ❌ 失败 |
| **V26.0** | 假设签名反转、错误密钥拼接 | ❌ 失败 |
| **V26.1** | JS undefined 特性修正密钥 | ❌ 失败 |
| **V26.2** | 添加 JSON 键排序 | ❌ 失败（测试证伪） |
| **V27.0** | **首次成功**：真实密钥 + 正确载荷 | ✅ 成功 |
| **V28.0** | 移除 sort_keys，强调原始顺序 | ✅ 稳定 |

---

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

---

**最后更新**：2025年12月10日  
**对应 Cherry Studio 版本**：v1.7.2  
**维护者**：[@lza6](https://github.com/lza6)  

> ⭐ 如果本项目对你的逆向研究有帮助，请给个 Star！
