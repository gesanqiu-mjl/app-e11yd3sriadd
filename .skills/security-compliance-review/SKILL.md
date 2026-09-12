---
name: security-compliance-review
description: 检查 Web App 的权限、输入校验、敏感信息、认证和常见安全风险。适合秒哒（Miaoda）平台上的应用上线前安全自查，覆盖等保2.0、个人信息保护法（PIPL）合规要点和 AI/LLM 安全。当用户需要检查应用安全性、审查权限模型、验证输入校验、排查敏感信息泄露、安全自查、等保合规、PIPL合规或 AI 安全审查时触发。
license: MIT
---

# 安全加固与合规审查

## 概述

面向 Web 应用的安全优先开发实践。将每一个外部输入视为恶意，将每一个密钥视为机密，将每一次权限检查视为必须。安全不是一个阶段——它是每一行涉及用户数据、认证或外部系统的代码的约束条件。

国内还需额外关注：
- **等保 2.0**（GB/T 22239-2019）：等保三级要求身份鉴别、访问控制、安全审计、入侵防范等控制点
- **个人信息保护法（PIPL）**：个人信息收集需告知同意、最小必要原则、跨境传输需合规、数据泄露 72 小时内上报

## 适用场景

- 接受用户输入的任何功能
- 实现认证或授权
- 存储或传输敏感数据
- 与外部 API 或服务集成
- 添加文件上传、Webhook 或回调
- 处理支付或个人信息（PII/个人信息）
- 秒哒应用上线前安全自查
- 等保合规评估或 PIPL 合规检查

## 威胁建模优先

没有威胁模型的安全控制只是猜测。在加固之前，花五分钟像攻击者一样思考：

1. **梳理信任边界。** 不可信数据在哪里进入你的系统？HTTP 请求、表单字段、文件上传、Webhook、第三方 API、消息队列，以及 **LLM 输出**。每个边界都是攻击面。
2. **明确保护资产。** 什么值得被窃取或破坏？凭证、个人信息、支付数据、管理员操作、资金流动。
3. **用 STRIDE 审查每个边界** ——快速视角，而非繁文缛节：

| 威胁 | 核心问题 | 典型缓解措施 |
|---|---|---|
| **S**poofing 伪造 | 能否冒充用户或服务？ | 认证、签名验证 |
| **T**ampering 篡改 | 数据在传输或存储中能否被修改？ | 完整性检查、参数化查询、HTTPS |
| **R**epudiation 抵赖 | 操作事后能否被否认？ | 安全事件审计日志 |
| **I**nformation Disclosure 信息泄露 | 数据能否泄露？ | 加密、字段白名单、通用错误提示 |
| **D**enial of Service 拒绝服务 | 系统能否被压垮？ | 限流、输入大小限制、超时 |
| **E**levation of Privilege 权限提升 | 用户能否获取不应有的权限？ | 授权检查、最小权限原则 |

4. **在用例旁边写滥用用例。** 对每个功能问"我会怎么滥用它？"——然后把它作为你的第一个测试。

如果你说不清一个功能的信任边界，你还没准备好保护它。这是 OWASP **A04: 不安全设计**——大多数安全事件始于设计阶段，而非代码。

## 三层边界体系

### 必须做（无例外）

- **在系统边界验证所有外部输入**（API 路由、表单处理器）
- **参数化所有数据库查询**——绝不将用户输入拼接进 SQL
- **对输出进行编码**以防止 XSS（使用框架自动转义，不要绕过它）
- **所有外部通信使用 HTTPS**
- **用 bcrypt/scrypt/argon2 哈希密码**（绝不明文存储）
- **安全响应头按部署环境处理**（CSP、HSTS、X-Frame-Options、X-Content-Type-Options）
  - 这些安全头必须由服务器以 HTTP 响应头下发。除 `Content-Security-Policy` 外，其余安全头不是合法的 `<meta http-equiv>` pragma，浏览器会忽略；不要用 `<meta http-equiv>` 模拟安全响应头，以免造成已经加固的假象。
  - **秒哒平台例外规则（强制）**：发布态已由平台统一下发包含全部平台域的 CSP 及相关安全响应头，应用层不得在 `index.html` 或其他页面写任何安全头的 `<meta http-equiv>` 版本。本项在秒哒环境视为平台已满足，不要求应用重复配置。
  - 多份 CSP 会同时生效并取最严格交集；应用自行写入如 `script-src 'self'` 的 CSP，可能排除秒哒平台资源域，造成发布态 bundle 无法加载、整站白屏，而同源预览态可能无法复现。
  - 秒哒应用的加固重点转到代码和数据层：Supabase RLS/资源归属校验、服务端输入校验、参数化查询、输出转义、凭证保护和最小权限。
- **使用 httpOnly、secure、sameSite Cookie** 管理会话
- **每次发布前运行 `npm audit`**（或等效命令）

### 需要先确认（需要人工审批）

- 新增认证流程或修改认证逻辑
- 新增存储敏感数据类别（个人信息、支付信息）
- 新增外部服务集成
- 修改 CORS 配置
- 新增文件上传处理器
- 修改限流或节流配置
- 授予提升权限或新角色

### 绝不做

- **绝不将真实秘密提交到版本控制**（密码、Service Role Key、第三方 Secret/Token、私钥）；秒哒客户端所需的公开构建变量不按秘密处理
- **绝不记录敏感数据**（密码、Token、完整银行卡号）
- **绝不将客户端校验作为安全边界**
- **绝不削弱服务器或平台统一下发的安全响应头**；秒哒应用不得通过页面 `<meta http-equiv>` 重复或覆盖平台 CSP
- **绝不对用户输入使用 `eval()` 或 `innerHTML`**
- **绝不将会话存储在客户端可访问的存储中**（localStorage 用于 Auth Token）
- **绝不向用户暴露堆栈跟踪**或内部错误详情

## OWASP Top 10 防护模式

这些是防护模式，不是排名。详细清单参见 `references/security-checklist.md`。

### 注入（SQL、NoSQL、OS 命令）

```typescript
// 错误：字符串拼接导致 SQL 注入
const query = `SELECT * FROM users WHERE id = '${userId}'`;
// 正确：参数化查询
const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
// 正确：使用 ORM 参数化
const user = await prisma.user.findUnique({ where: { id: userId } });
```

### 认证缺陷

```typescript
// 密码哈希
import { hash, compare } from 'bcrypt';
const SALT_ROUNDS = 12;
const hashedPassword = await hash(plaintext, SALT_ROUNDS);
const isValid = await compare(plaintext, hashedPassword);

// 会话管理
app.use(session({
  secret: process.env.SESSION_SECRET, // 从环境变量读取，不写在代码里
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,  // JS 无法访问
    secure: true,    // 仅 HTTPS
    sameSite: 'lax', // CSRF 防护
    maxAge: 24 * 60 * 60 * 1000, // 24 小时
  },
}));
```

### 跨站脚本（XSS）

```typescript
// 错误：将用户输入作为 HTML 渲染
element.innerHTML = userInput;
// 正确：使用框架自动转义（React 默认如此）
return <div>{userInput}</div>;
// 如果必须渲染 HTML，先净化
import DOMPurify from 'dompurify';
const clean = DOMPurify.sanitize(userInput);
```

### 访问控制缺陷

```typescript
// 始终检查授权，不只是认证
app.patch('/api/tasks/:id', authenticate, async (req, res) => {
  const task = await taskService.findById(req.params.id);
  // 检查已认证用户是否拥有该资源
  if (task.ownerId !== req.user.id) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: '无权修改该任务' }
    });
  }
  const updated = await taskService.update(req.params.id, req.body);
  return res.json(updated);
});
```

### 安全配置错误

> 以下 `helmet` 示例只适用于能够控制 HTTP 服务器响应头的独立部署环境。秒哒应用不得把这些响应头改写成 `index.html` 的 `<meta http-equiv>`；秒哒发布态沿用平台统一下发的 CSP 和其他安全响应头。

```typescript
// 独立 Express 部署：由服务器响应头下发安全头
import helmet from 'helmet';
app.use(helmet());

// 内容安全策略
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"], // 尽可能收紧
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'"],
  },
}));

// CORS——限制为已知来源
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || 'http://localhost:3000',
  credentials: true,
}));
```

### 敏感数据暴露

```typescript
// API 响应中绝不返回敏感字段
function sanitizeUser(user: UserRecord): PublicUser {
  const { passwordHash, resetToken, ...publicFields } = user;
  return publicFields;
}

// 密钥从环境变量读取
const API_KEY = process.env.INTEGRATIONS_API_KEY; // 秒哒平台注入
if (!API_KEY) throw new Error('INTEGRATIONS_API_KEY not configured');
```

### 服务端请求伪造（SSRF）

当服务器请求用户影响的 URL 时——Webhook、"从 URL 导入"、图片代理、链接预览——攻击者可以将其指向内部服务（云元数据、`localhost`、私有 IP）。

```typescript
// 错误：直接 fetch 用户提供的 URL
await fetch(req.body.webhookUrl);

// 正确：白名单 scheme + host，拒绝任何解析到私有 IP 的地址，禁止重定向
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

const ALLOWED_HOSTS = new Set(['hooks.example.com']);

async function assertSafeUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('仅允许 https');
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new Error('host 不在白名单内');
  
  const addrs = await lookup(url.hostname, { all: true });
  if (addrs.some((a) => ipaddr.parse(a.address).range() !== 'unicast')) {
    throw new Error('私有/保留 IP 不允许访问');
  }
  return url;
}

await fetch(await assertSafeUrl(req.body.webhookUrl), { redirect: 'error' });
```

**注意——仍有 TOCTOU 竞态问题。** `fetch` 在检查后会再次解析 DNS，攻击者可以用短 TTL 记录在验证和连接之间将其重绑定到内部 IP。对于高风险场景，解析一次后固定 IP 连接，或使用过滤代理（`request-filtering-agent` / `ssrf-req-filter`）。

## 输入校验模式

### 边界处的 Schema 校验

```typescript
import { z } from 'zod';

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200).trim(),
  description: z.string().max(2000).optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  dueDate: z.string().datetime().optional(),
});

// 在路由处理器处校验
app.post('/api/tasks', async (req, res) => {
  const result = CreateTaskSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: '输入数据无效',
        details: result.error.flatten(),
      },
    });
  }
  const task = await taskService.create(result.data);
  return res.status(201).json(task);
});
```

### 文件上传安全

```typescript
// 限制文件类型和大小
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

function validateUpload(file: UploadedFile) {
  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    throw new ValidationError('文件类型不允许');
  }
  if (file.size > MAX_SIZE) {
    throw new ValidationError('文件过大（最大 5MB）');
  }
  // 不要信任文件扩展名——关键场景应检查魔数（magic bytes）
}
```

## npm audit 结果分级处理

不是所有审计发现都需要立即处理。使用以下决策树：

```
npm audit 报告漏洞
├── 严重级别：critical 或 high
│   ├── 漏洞代码在你的应用中可达？
│   │   ├── 是 --> 立即修复（升级、补丁或替换依赖）
│   │   └── 否（仅 dev 依赖、未使用的代码路径）--> 尽快修复，但不阻塞发布
│   └── 是否有修复版本？
│       ├── 是 --> 升级到已修复版本
│       └── 否 --> 寻找变通方案，考虑替换依赖，或加入 allowlist 并设置复查日期
├── 严重级别：moderate
│   ├── 在生产环境可达？--> 在下一个发布周期修复
│   └── 仅 dev 依赖？--> 方便时修复，记录到 backlog
└── 严重级别：low
    └── 在常规依赖更新时修复
```

**关键问题：**
- 漏洞函数在你的代码路径中是否真的被调用？
- 该依赖是运行时依赖还是仅 dev 依赖？
- 在你的部署上下文中该漏洞是否可被利用？

延迟修复时，记录原因并设置复查日期。

### 供应链安全

`npm audit` 检测已知 CVE；它不会捕获恶意或仿冒包。还需注意：
- **提交 lockfile**，CI 中使用 `npm ci`（而非 `npm install`）——可复现构建，无静默版本漂移。
- **添加新依赖前先审查**——维护状态、下载量，以及它是否真的值得引入。每个依赖都是攻击面（OWASP **A06: 已知漏洞组件**）。
- **警惕不熟悉包的 `postinstall` 脚本**——它们在安装时执行任意代码。
- **注意仿冒包**——如 `cross-env` vs `crossenv`、`react-dom` vs `reactdom`。

## 限流

```typescript
import rateLimit from 'express-rate-limit';

// 通用 API 限流
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 100,                  // 每窗口 100 次请求
  standardHeaders: true,
  legacyHeaders: false,
}));

// 认证接口更严格的限流
app.use('/api/auth/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 每 15 分钟 10 次尝试
}));
```

## 密钥与构建环境变量管理

先按“浏览器可公开配置”与“服务端秘密”分类，不能按文件名一刀切：

| 类型 | 示例 | 是否可进入前端构建 | 是否可提交 |
|---|---|---:|---:|
| 秒哒前端公开构建配置 | `TARO_APP_SUPABASE_URL`、`TARO_APP_SUPABASE_ANON_KEY`、`TARO_APP_APP_ID` | 是 | **秒哒 H5/小程序工程必须随 `.env` 提交** |
| 本地覆盖 | `.env.local`、`.env.*.local` | 视内容 | 否 |
| 服务端秘密 | `INTEGRATIONS_API_KEY`、Service Role Key、密码、第三方 Secret/Token、私钥 | 否 | 否 |

**秒哒 H5/小程序构建规则（强制）：**

1. 代码同时面向 H5 和 WeApp/Taro 时，项目根目录 `.env` 必须随代码提交并上传到打包服务；不得把 `.env` 写入 `.gitignore`。H5 与 WeApp 的环境变量注入模式不同，缺失 `.env` 可能表现为 H5 可用、WeApp 发布后白屏。
2. `.env` 只能包含允许进入客户端包的公开构建配置。Supabase Anon Key 本来就会暴露在客户端，安全边界必须依赖 RLS；Service Role Key 和其他真实秘密不得写入 `.env`。
3. 若 `.env` 丢失，从 `src/client/supabase.ts` 中现有回退常量恢复，映射必须为：

```dotenv
TARO_APP_SUPABASE_URL=<FALLBACK_URL 的值>
TARO_APP_SUPABASE_ANON_KEY=<FALLBACK_KEY 的值>
TARO_APP_APP_ID=<FALLBACK_APP_ID 的值>
```

4. 恢复后从 `.gitignore` 删除精确的 `.env` 规则，保留 `.env.local`、`.env.*.local`、`*.pem`、`*.key` 等忽略项；构建前分别检查 H5 和 WeApp 产物。
5. 不得新编环境变量值。只能复用项目已有 `.env` 或 `src/client/supabase.ts` 的 `FALLBACK_URL`、`FALLBACK_KEY`、`FALLBACK_APP_ID`。

独立部署且 `.env` 含真实秘密时，仍使用以下常规结构：

```text
.env.example  → 提交（仅占位值）
.env          → 按内容分类；含秘密时不提交
.env.local    → 不提交（本地覆盖）
```

**提交前务必检查：**
```bash
# 检查是否有意外暂存的密钥
git diff --cached | grep -i "password\|secret\|api_key\|token"
# 命中 TARO_APP_SUPABASE_ANON_KEY 时按上方白名单放行；其他命中项逐项审查
```

**真实服务端秘密一旦被提交，必须轮换。** 本句不适用于上方白名单中的 Supabase URL、Anon Key 和 App ID。对真实秘密，删除那一行或改写历史还不够——先吊销并重新颁发，再从历史中清除。

**秒哒变量处理决策（按顺序执行，不得自行概括）：**

1. 如果变量名是以下三项之一，则它是秒哒客户端公开构建配置，必须保留在项目根目录 `.env` 并随代码提交：
   - `TARO_APP_SUPABASE_URL`
   - `TARO_APP_SUPABASE_ANON_KEY`
   - `TARO_APP_APP_ID`
2. 上述白名单中虽然包含单词 `KEY`，也不得按“API Key/密钥不得进前端”的通用规则删除、遮盖、移入 Edge Function 或加入 `.gitignore`。`TARO_APP_SUPABASE_ANON_KEY` 是公开 Anon Key，权限边界由 Supabase RLS 保证。
3. `INTEGRATIONS_API_KEY`、Supabase Service Role Key、第三方 Secret/Token、密码和私钥属于服务端秘密，禁止进入前端与已提交的 `.env`：
   - Edge Function 仅通过 `Deno.env.get("INTEGRATIONS_API_KEY")` 读取。
   - 生成期仅通过 `process.env["INTEGRATIONS_API_KEY"]` 读取。
4. 不认识的变量先检查其使用位置与平台定义；不得仅根据变量名中出现 `KEY` 就删除文件或修改 `.gitignore`。
5. 规则冲突时，本节的秒哒三项白名单优先于“前端不持有密钥”“`.env` 不提交”等通用规则。

## AI / LLM 功能安全

如果你的应用调用了大模型——聊天机器人、摘要、Agent、RAG——它就继承了新的攻击面。对应 [OWASP LLM Top 10（2025）](https://genai.owasp.org/llm-top-10/)：

- **将所有模型输出视为不可信输入（LLM05: 不当输出处理）。** 绝不将 LLM 输出直接传入 `eval`、SQL、Shell、`innerHTML` 或文件路径。像处理原始用户输入一样校验和编码它。
- **假设 Prompt 可被劫持（LLM01: Prompt 注入）。** 上下文窗口中的不可信文本——用户消息、抓取的网页、PDF——可能携带指令。系统提示不是安全边界；在代码中强制执行权限，而不是在 Prompt 中。
- **将密钥和其他用户数据排除在 Prompt 之外（LLM02 / LLM07）。** 上下文中的任何内容都可能被模型复述。不要将 API Key、跨租户数据或完整系统提示放入模型可访问的位置。
- **限制工具和 Agent 的权限（LLM06: 过度授权）。** 将工具权限限制到最小，对破坏性或不可逆操作要求确认，并校验每个工具参数。
- **限制消耗（LLM10: 无限消耗）。** 限制 Token 数量、请求速率和循环/递归深度，防止精心构造的输入耗尽费用或挂起系统。
- **隔离检索数据（LLM08: 向量和嵌入弱点）。** 在 RAG 中，将向量库视为信任边界：按租户分区嵌入，防止一个用户检索到另一个用户的数据；索引前验证文档，防止投毒内容误导答案。

**秒哒平台 AI 安全要点：**
- 用户通过 Miaoda 插件调用大模型时，系统 Prompt 中不得包含其他用户的数据
- 插件服务端凭证 `INTEGRATIONS_API_KEY` 通过网关注入，前端不得直接持有；这不包括允许进入客户端的 `TARO_APP_SUPABASE_ANON_KEY`
- AI 生成的内容用于展示时，必须经过 XSS 净化

```typescript
// 错误：信任模型输出作为命令或标记
const sql = await llm.generate(`为此问题生成 SQL：${userQuestion}`);
await db.query(sql); // 任意查询执行
container.innerHTML = await llm.reply(userMessage); // 通过模型实现 XSS

// 正确：模型输出是数据——防御性解析，然后校验，然后编码
let intent;
try {
  intent = CommandSchema.parse(JSON.parse(await llm.replyJson(userMessage)));
} catch {
  throw new ValidationError('模型输出格式异常');
}
await runAllowlistedAction(intent.action, intent.params);
container.textContent = await llm.reply(userMessage);
```

## 国内合规要点

### 个人信息保护法（PIPL）

| 要求 | 实践 |
|------|------|
| 告知同意 | 收集个人信息前获取明确同意，说明用途 |
| 最小必要原则 | 只收集业务必需的最少个人信息 |
| 数据主体权利 | 支持用户查阅、更正、删除其个人信息 |
| 跨境传输 | 向境外传输个人信息需通过安全评估或标准合同 |
| 数据泄露上报 | 发生数据泄露后 **72 小时内** 向主管部门报告 |
| 敏感信息额外保护 | 生物特征、医疗、金融等敏感信息需单独同意，加强保护 |

### 等保 2.0（GB/T 22239-2019）

等保三级关键控制点（Web 应用层）：

| 控制域 | 关键要求 |
|--------|---------|
| 身份鉴别 | 双因素认证、登录失败锁定、密码复杂度策略 |
| 访问控制 | 最小权限、角色隔离、定期权限复查 |
| 安全审计 | 记录用户操作、管理员操作、安全事件，日志不可删改，保留 ≥ 6 个月 |
| 入侵防范 | WAF、异常行为检测、漏洞扫描 |
| 数据完整性 | 传输和存储数据的完整性校验 |
| 数据保密性 | 传输加密（TLS 1.2+）、敏感数据存储加密 |

## 安全审查清单

```markdown
### 认证
- [ ] 密码用 bcrypt/scrypt/argon2 哈希（salt rounds ≥ 12）
- [ ] 会话 Token 使用 httpOnly、secure、sameSite
- [ ] 登录接口有限流
- [ ] 密码重置 Token 有过期时间

### 授权
- [ ] 每个接口检查用户权限
- [ ] 用户只能访问自己的资源
- [ ] 管理员操作需验证管理员角色

### 输入
- [ ] 所有用户输入在边界处校验
- [ ] SQL 查询已参数化
- [ ] HTML 输出已编码/转义
- [ ] 服务端 URL 请求已白名单（无 SSRF 到内部服务）

### 数据
- [ ] 代码和版本控制中无真实秘密；秒哒 `.env` 只包含允许进入客户端包的 `TARO_APP_*` 公开构建配置
- [ ] 敏感字段已从 API 响应中排除
- [ ] 个人信息（PII）静态加密（如适用）

### 基础设施
- [ ] 独立部署：服务器响应头已配置 CSP、HSTS 等；秒哒：确认未在 `index.html` 写安全头 `<meta http-equiv>`，沿用平台响应头
- [ ] CORS 限制为已知来源
- [ ] 依赖已审计漏洞
- [ ] 错误消息不暴露内部细节

### 供应链
- [ ] Lockfile 已提交；CI 使用 `npm ci` 安装
- [ ] 新依赖已审查（维护状态、下载量、postinstall 脚本）

### 国内合规（PIPL / 等保）
- [ ] 收集个人信息前有明确告知和同意
- [ ] 只收集业务必需的最少个人信息
- [ ] 用户可行使查阅、更正、删除权利
- [ ] 不向境外传输个人信息（或已通过安全评估）
- [ ] 操作日志保留 ≥ 6 个月，不可删改
- [ ] 敏感信息传输使用 TLS 1.2+，存储已加密

### AI / 大模型（如有）
- [ ] 模型输出视为不可信（无 eval/SQL/innerHTML/Shell）
- [ ] 密钥和其他用户数据不进入 Prompt
- [ ] 工具/Agent 权限已限制；破坏性操作需确认
- [ ] 用户输入的 Token 数量有上限限制
```

## 另请参阅

详细安全清单和提交前验证步骤，参见 `references/security-checklist.md`。

## 常见借口与现实

| 借口 | 现实 |
|---|---|
| "这是内部工具，安全无所谓" | 内部工具也会被攻破。攻击者专门针对最薄弱的环节。 |
| "我们以后再加安全措施" | 安全改造的成本是从一开始就内置的 10 倍。现在就加。 |
| "没人会尝试利用这个" | 自动扫描器会发现它。安全靠隐晦不是安全。 |
| "框架会处理安全" | 框架提供工具，不提供保证。你仍需正确使用它们。 |
| "只是个原型" | 原型会变成生产环境。从第一天起就养成安全习惯。 |
| "威胁建模太麻烦了" | 五分钟的"我会怎么攻击它？"能防止任何控制措施都无法修补的设计缺陷。 |
| "只是 LLM 输出，只是文本" | 那段"文本"可能是 SQL 语句、script 标签或 Shell 命令。像处理不可信输入一样处理它。 |
| "等保要求太严格了，等快上线了再说" | 等保不合规的后果是系统下线整改，上线后再补代价更高。 |

## 红色警报

- 用户输入直接传入数据库查询、Shell 命令或 HTML 渲染
- 真实秘密在源代码或提交历史中；或误删秒哒小程序构建必需的公开 `.env`
- API 接口无认证或授权检查
- CORS 配置缺失或使用通配符（`*`）来源
- 认证接口无限流
- 向用户暴露堆栈跟踪或内部错误
- 已知高危漏洞的依赖
- 服务端直接 fetch 用户提供的 URL（SSRF）
- LLM/模型输出传入查询、DOM、Shell 或 `eval`
- 密钥、个人信息或完整系统提示放入 LLM 上下文
- 收集个人信息前未获用户同意（违反 PIPL）
- 日志中包含用户个人信息明文

## 上线前验证

- [ ] `npm audit` 显示无 critical 或 high 漏洞
- [ ] 源代码和 git 历史中无真实秘密；秒哒 H5/WeApp 工程已提交仅含公开 `TARO_APP_*` 配置的 `.env`
- [ ] 所有用户输入在系统边界处已校验
- [ ] 每个受保护接口已检查认证和授权
- [ ] 发布态响应头中存在平台/服务器下发的安全头（用浏览器 DevTools 的 Network 面板检查）；秒哒应用源码中无安全头 `<meta http-equiv>`
- [ ] 错误响应不暴露内部细节
- [ ] 认证接口有限流
- [ ] 服务端 URL 请求已经过白名单校验（无 SSRF）
- [ ] LLM/模型输出在使用前已校验和编码（如有 AI 功能）
- [ ] 已检查是否收集个人信息并确保有合规告知（PIPL）
- [ ] 操作日志已开启并满足保留期要求（等保）
