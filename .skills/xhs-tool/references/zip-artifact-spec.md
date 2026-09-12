# 小工具 ZIP 静态包构建规范

> 小工具是基于离线 H5 的 app 形式，**纯本地、不联网**，所有资源须打包在 zip 内。窗口样式、导航栏、下拉刷新等外壳行为由**容器**统一控制，无需在包内声明。

## 目录

- §1 目录结构与打包
- §2 支持的文件类型
- §3 资源加载规则（容器 CSP）
- §4 路径与引用规则
- §5 index.html 模板
- §6 打包前自检

---

## 1. 目录结构与打包

**唯一硬性要求：`index.html` 位于 zip 根目录作为入口。** 其余文件 / 文件夹随你组织 —— 可平铺，也可按需分目录（`assets/`、`images/`、`audios/` 等），用相对路径引用即可。

平铺示例：

```
tool.zip
├── index.html        # 必需 — 入口，必须在根目录
├── main.js
├── style.css
└── logo.png
```

分目录示例：

```
tool.zip
├── index.html        # 必需 — 入口，必须在根目录
└── assets/
    ├── style.css
    ├── main.js
    └── images/
        └── ...
```

| 路径 | 要求 | 说明 |
| --- | --- | --- |
| `index.html` | **必须在 zip 根目录** | 唯一入口；不可改名、不可放进子目录 |
| 其余文件 / 文件夹 | 自由 | JS / CSS / 图片 / 字体等，平铺或分目录皆可，相对路径引用；扩展名须在 §2 白名单内 |

### 禁止出现在 zip 内

- `node_modules`、`.git`、`.DS_Store`
- `*.map`、构建配置文件（`vite.config.*`、`webpack.config.*` 等）
- 任何扩展名不在 §2 白名单内的文件（音视频、`.ttf` / `.otf`、`.ico`、`.txt` / `.md`、`.wasm`、源码 / 预处理文件等）
- 把整个项目多包一层目录，导致 `index.html` 不在根（错误：`app/index.html`；正确：根目录就有 `index.html`）

### 打包方式（关键）

**压缩的是「与 `index.html` 同级的那批文件」本身，不是它们所在的文件夹。** 必须先进入该目录再压缩当前目录内容，否则解压后会多套一层目录、`index.html` 不在根，容器无法加载。

```bash
# ✅ 正确：进入目录，压缩目录“内容”（index.html 直接在 zip 根）
cd dist && zip -r ../tool.zip . -x '*.DS_Store'

# ❌ 错误：压缩目录“本身”，解压后多一层 dist/，index.html 变成 dist/index.html
zip -r tool.zip dist
```

解压后顶层应直接看到 `index.html`，而不是先看到一个文件夹再点进去。

---

## 2. 支持的文件类型（白名单，强制）

zip 内**仅允许**以下 12 种扩展名，出现任何其他类型的文件校验即不通过：

```
html  css  js  json  png  jpg  jpeg  gif  webp  svg  woff  woff2
```

| 类型 | 用途 |
| --- | --- |
| `.html` | 入口，有且只有一个 `index.html` |
| `.css` | 样式文件 |
| `.js` | 脚本文件 |
| `.json` | 静态数据 / 配置 |
| `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` / `.svg` | 图片资源 |
| `.woff` / `.woff2` | 字体文件 |

**白名单之外的常见类型都不可打包**，注意以下直接影响功能的几项：

| 不允许 | 后果 / 替代 |
| --- | --- |
| `.mp3` / `.wav` / `.m4a` / `.aac` / `.ogg` / `.mp4` / `.mov` / `.webm` | **音视频文件无法打包，`<audio>` / `<video>` 能力不可用**（外链与 `data:` / `blob:` 媒体同样被禁）。音效 / 背景音乐 / 视频播放类需求须去掉，改用视觉反馈（动画、震动样式）替代 |
| `.ttf` / `.otf` / `.eot` | 自定义字体只能用 `.woff` / `.woff2`；其他格式先转换，或直接用系统字体栈 |
| `.ico` | favicon 无意义（容器不显示），移除 |
| `.txt` / `.md` / `.csv` / `.xml` / `.yaml` | 静态数据统一改用 `.json` 或写死在 `.js` 里 |
| `.wasm` | WebAssembly 本就被禁（见 device-capabilities.md），改纯 JS |
| `.ts` / `.tsx` / `.jsx` / `.vue` / `.scss` / `.less` | 源码 / 预处理文件不进包，只放构建产物 `.js` / `.css` |
| `.map` / 无扩展名文件 / 任何构建配置 | 一律清理（见 §1「禁止出现在 zip 内」） |

打包后用一条命令核对包内扩展名，出现白名单外的类型即为不合规：

```bash
# 列出 zip 内所有扩展名，逐个比对白名单
unzip -Z1 tool.zip | grep -v '/$' | sed 's/.*\.//' | sort -u
```

---

## 3. 资源加载规则（容器 CSP）

容器对页面**如何加载各类资源**有强制约束。除包内文件外，按类型另允许 `data:` / `blob:` 等内存来源。

| 资源类型 | 允许 | 禁止 |
| --- | --- | --- |
| 脚本 `<script>` | 引用包内脚本 `<script src="./app.js">`（同源外链） | 内联 `<script>...</script>`；行内事件 `onclick="..."`；`javascript:` URI；`eval()` / `new Function()`；WebAssembly；外部域名 / `data:` / `blob:` 脚本 |
| 样式 `<style>` / `<link>` | 内联 `<style>`、行内 `style="..."`、包内样式表 | 外部域名样式表 |
| 图片 `<img>` / CSS 背景图 | 包内图片 `<img src="./a.png">`；`data:` URI（base64 内嵌）；`blob:`（`createObjectURL` 内存对象，如选图预览） | 外部域名图片 |
| 字体 `@font-face` | 包内字体文件 | 外部域名字体 |
| 音视频 `<video>` / `<audio>` | — | 全部禁止：媒体文件格式不在打包白名单（§2），外部域名媒体、`data:` / `blob:` 媒体也被禁 |
| iframe / object | — | 全部禁止 |

关键点：

- **脚本必须外置**：容器 CSP 的 `script-src` 不含 `unsafe-inline`，内联 `<script>...</script>`、行内事件 `onclick="..."`、`javascript:` URI 均不可用。JS 写进包内 `.js` 用 `<script src>` 引入，事件用 `addEventListener` 绑定。
- **脚本必须是经典脚本**：只用 `<script src="./app.js">`，**不要 `type="module"`**，JS 里也不要 `import` / `export`。zip 离线加载、无目录服务，module 的相对 `import` 解析不可靠，典型症状是「页面渲染出来但 JS 完全不执行」。要拆多个 JS 文件时按依赖顺序写多个 `<script src>`，靠 `window` 命名空间协作，并避免 top-level `await`。
- **样式可内联**：`<style>` 与 `style="..."` 都能用，无需外置。
- **无音视频**：`<audio>` / `<video>` 在小工具里不可用（媒体文件不在打包白名单，`data:` / `blob:` 与外链媒体也被禁）。需要"音效"的交互改用动画 / 高亮等视觉反馈。
- **选图预览**：`<img src>` 配 `data:`（`FileReader.readAsDataURL`）或 `blob:`（`URL.createObjectURL`）均可显示。
- 外部 CDN 一律加载不到，所有资源全部打包进小工具。

---

## 4. 路径与引用规则

| 规则 | 正确 | 错误 |
| --- | --- | --- |
| 资源引用 | `./assets/main.js` | `/assets/main.js`（绝对路径） |
| 入口 | 根目录 `index.html` | `src/index.html` |
| base | 不使用 | `<base href="...">` |
| 外部资源 | 下载后打进 zip 再相对引用 | 任何 `https://...` 在线引用 |
| 单页 | 一个 `index.html`，视图 JS 切换 | 多 HTML 页面站点 |

---

## 5. index.html 模板

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport"
        content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <title>应用标题</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                   "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
      -webkit-tap-highlight-color: transparent;
      -webkit-user-select: none;
      user-select: none;
    }
  </style>
  <link rel="stylesheet" href="./assets/style.css" />
</head>
<body>
  <!-- 内容 -->
  <script src="./assets/main.js"></script>
</body>
</html>
```

| 规则 | 原因 |
| --- | --- |
| viewport 含 `width=device-width, initial-scale=1.0, viewport-fit=cover` | 真机 + 模拟器布局与安全区 |
| 资源全为相对路径 `./assets/...` | 离线 zip 根为 `/` |
| 脚本外置 `<script src>`，用 `addEventListener` 绑事件 | 容器禁止内联脚本与行内事件 |
| 不用 `<base href>` | 破坏真机路径 |
| 不引用任何外部资源（图片 / CSS / JS / 字体） | 外部资源加载不到，须全部打进 zip |
| 不自建 CSP `<meta>` | 安全策略由容器统一管理 |

- `<title>` 仅影响文档标题；导航栏标题由容器 UI 配置。

---

## 6. 打包前自检

### 包结构

- [ ] `index.html` 在 zip 根目录（不在任何子目录里）
- [ ] 解压后顶层直接是文件，**未多套一层目录**（压缩的是目录内容而非目录本身）
- [ ] 包内扩展名全部落在白名单 12 项内（`html css js json png jpg jpeg gif webp svg woff woff2`），用 §2 的 `unzip -Z1 ... | sed 's/.*\.//' | sort -u` 核对
- [ ] 无音视频文件（`.mp3` / `.mp4` / `.wav` / `.webm` 等）、无 `.ttf` / `.otf`、无 `.ico`、无 `.txt` / `.md`、无 `.wasm`
- [ ] 无开发垃圾与源码文件（`node_modules` / `*.map` / 构建配置 / `.ts` / `.scss` 等）

### index.html 与资源

- [ ] `<!DOCTYPE html>` + `lang="zh-CN"` + `charset=UTF-8`
- [ ] viewport 含 `width=device-width, initial-scale=1.0, viewport-fit=cover`
- [ ] 全部资源为相对路径，无 `http(s)://` 外部引用（图片、第三方库、字体等已打进 zip）
- [ ] 脚本全部外置：无内联 `<script>`、无 `onclick=` 等行内事件、无 `javascript:` / `eval` / `new Function`
- [ ] 脚本为经典脚本：无 `type="module"`，JS 内无 `import` / `export`
- [ ] 图片可用包内文件 / `data:` / `blob:`；字体仅用包内 `.woff` / `.woff2`；**无 `<audio>` / `<video>`**
- [ ] 无 `<base href>`、无 `<iframe>` / `<object>`、无自建 CSP `<meta>`

### 端能力（见 [device-capabilities.md](./device-capabilities.md)）

- [ ] 未使用不可用能力（网络请求、定位、剪贴板、传感器、Worker、WebRTC 等）
- [ ] 相机 / 麦克风 / 选图用法符合「用户手势触发 + 授权」
- [ ] 若使用 JSBridge：仅调用 [jsbridge-api.md](./jsbridge-api.md) 列出的 API，参数符合 schema

### 正确性（静态自查）

- [ ] 被禁能力**无调用 / 残留**（按 device-capabilities.md 扫描清单逐项 grep）
- [ ] JS 无语法错误；关键逻辑通读无明显运行时报错（如调用未定义函数、引用 `null` DOM）
- [ ] 多文件 JS 依赖关系 / 加载顺序正确
- [ ] 页面引用的每个资源（脚本 / 样式 / 图片 / 字体）都已打进 zip，且路径正确
- [ ] 改写场景：仅替换被禁能力，未顺手改动其余业务逻辑与 UI
- [ ] 核心交互在代码层面自洽：事件有绑定、依赖的 DOM 存在、回调闭环完整

### 体积

- [ ] 总包（zip）不超过 10MB（上限）；为获得更好的加载体验，建议控制在 2MB 以内
- [ ] 明显超出建议值时应进行优化（压缩 JS、压缩图片等），在功能完整与加载体验之间取得平衡
