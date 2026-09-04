# AI 随机事件系统（v4.0.0b · Phase 2）

为《设身处地》引入 AI 生成的随机事件：每天凌晨由 GitHub Actions 调用大模型预生成一批事件，推送到 GitHub Pages；游戏启动时自动拉取并注入事件池，玩家可在事件弹窗内对 AI 事件「赞 / 踩」反馈。

## 功能概览

- 供应商可配置：任意 OpenAI 兼容接口（OpenAI / DeepSeek / 通义 / Moonshot 等），默认 OpenAI。
- 实时热点联动：从 **9 个 RSS 源**（综合新闻/时政/科技/数码/商业/汽车/生活/技术）并发抓取热点标题，**强制每个事件取材一条真实热点并本地化到玩家城市**（可关闭）。
- 事件更丰满：描述要求 3-4 句（60-180 字），交代起因/现场/影响，读起来像本地新闻通稿；每个事件 3-4 个具体处置选项。
- 智能去重：标题归一化 + 字符二元组相似度判重（近似重复也能识别）+ 跨天历史去重（避免每天重复相同事件）。
- 城市名注入：事件文本使用 `{city}` 占位符，游戏端展示时替换为玩家城市名，产生「新闻照进现实」的效果。
- 数值受控：AI 生成的效果字段走白名单 + 范围 clamp，防止失衡数值破坏存档。
- 自动发布：GitHub Actions 每天北京时间 0:00 定时生成并推送，支持手动触发。
- 质量反馈：AI 事件弹窗内提供「赞 / 踩」，本地存储 + 可选上报 GitHub Issues。
- 微调数据集：每日生成后自动把「事件 + 反馈」汇总为 SFT/DPO 可用的 JSONL 数据集。
- 个性化预留：已内置脱敏存档快照函数，为后续「上传脱敏数据生成个性化事件」预留接口。

## 架构与数据流

生成与游戏本体完全解耦：游戏端只从「可配置的页面地址」抓取固定格式数据，自身不参与生成、不持有任何 API 密钥。

```
[GitHub Actions] 每天 0:00 (北京时间)          ← 生成侧（独立，与游戏无关）
   │  1. 抓取热点 RSS（可选）
   │  2. 调用 OpenAI 兼容接口生成事件（强制关联热点 + {city} 占位符）
   │  3. 校验 + 数值 clamp
   │  4. build-dataset.js：汇总事件 + GitHub Issues 反馈 → 微调数据集
   ▼
[仓库 events/ + training/ 目录]
   ├── events/latest.json            ← 游戏端实际拉取
   ├── events/ai-events-YYYY-MM-DD.json（当日批次归档）
   ├── events/index.json             （批次索引，保留 60 天）
   ├── training/ai-events-train-YYYY-MM-DD.jsonl（当日数据集）
   ├── training/ai-events-train.jsonl（累计合并数据集）
   └── training/feedback-summary.json（反馈统计）
   │
   ▼  git push → GitHub Pages 发布
[玩家浏览器]                                   ← 消费侧（只读抓取）
   ├── js/systems/ai-events.js  拉取 latest.json → 校验 → {city} 替换 → 注入 AI_EVENT_POOL
   ├── event-system.js          合并内置池 + AI 池 → 随机抽取 → 弹窗（含赞/踩）
   ├── localStorage             赞/踩反馈持久化
   └── GitHub Issues API        赞/踩上报（可选，需配置 token）
```

### 游戏端拉取地址配置

游戏端拉取地址按以下优先级解析（游戏只读该地址，不参与生成）：

1. `localStorage['cityPlanner_aiEventUrl']`：玩家 / 部署方配置，可用控制台 `setAIEventURL('https://...')` 写入并立即生效
2. `window.AI_EVENT_URL`：页面内联覆盖（在 `index.html` 引入 `ai-events.js` 前设置），便于同一份游戏部署到多个事件源
3. 默认相对路径 `events/latest.json`：与生成脚本输出目录一致，GitHub Pages 下自动解析

```html
<!-- 方式二示例：部署到独立事件源 -->
<script>
  window.AI_EVENT_URL = 'https://cdn.example.com/ai-events.json';
</script>
<script src="js/systems/ai-events.js"></script>
```

```js
// 方式一示例：运行时切换事件源（写入 localStorage 并立即重新拉取）
setAIEventURL('https://cdn.example.com/ai-events.json');
```

## 涉及文件

| 文件 | 作用 |
| --- | --- |
| `scripts/generate-events.js` | 事件生成脚本（Node 18+，零依赖） |
| `scripts/config.example.json` | 本地配置模板（复制为 `config.json` 使用） |
| `.github/workflows/generate-ai-events.yml` | 定时生成 + 推送工作流 |
| `js/systems/ai-events.js` | 游戏端加载器 + 反馈 + 脱敏快照 |
| `js/systems/event-system.js` | 事件池合并、弹窗反馈 UI（已接入） |
| `js/game/app.js` | 启动时调用 `initAIEvents()`（已接入） |
| `index.html` | 引入 `ai-events.js`（已接入） |

## 部署步骤

### 1. 配置 GitHub Secrets / Variables

在仓库 `Settings → Secrets and variables → Actions` 中配置：

**Secrets（加密，必填）：**

| 名称 | 说明 |
| --- | --- |
| `AI_BASE_URL` | 接口地址，如 `https://api.openai.com/v1` |
| `AI_API_KEY` | API 密钥 |
| `AI_MODEL` | 模型名，如 `gpt-4o-mini` |

**Variables（明文，可选）：**

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `AI_EVENT_COUNT` | `5` | 每批事件数量（3-20） |
| `AI_TEMPERATURE` | `0.9` | 生成随机性（0-2） |
| `HOT_TOPIC_ENABLED` | `true` | 是否启用热点联动 |
| `HOT_TOPIC_SOURCES` | 见 config.example | 热点 RSS 源，逗号分隔（默认 9 个源，覆盖综合/时政/科技/数码/商业/汽车/生活/技术） |

### 2. 开启 GitHub Pages

`Settings → Pages → Source` 选择 `Deploy from a branch`，分支选 `main`，目录 `/ (root)`。事件文件随每次 push 自动发布。

### 3. 验证

- Actions 页面手动点一次 `Run workflow`，确认生成成功。
- 访问 `https://<你的用户名>.github.io/<仓库名>/events/latest.json` 能看到事件 JSON。

## 供应商配置

脚本通过 `baseUrl` 指向任意 OpenAI 兼容端点，`/chat/completions` 接口即可，无需改代码：

| 供应商 | baseUrl | 示例模型 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问（兼容模式） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |

> 本地调试时也可把 `baseUrl` 指向本地服务（如 Ollama 的 OpenAI 兼容端点 `http://localhost:11434/v1`）。

## 本地调试

```bash
cd scripts
cp config.example.json config.json   # 填入你的 baseUrl / apiKey / model

# 方式一：用 config.json
node generate-events.js

# 方式二：环境变量覆盖（优先级更高）
AI_BASE_URL=https://api.deepseek.com/v1 \
AI_API_KEY=sk-xxx \
AI_MODEL=deepseek-chat \
HOT_TOPIC_ENABLED=false \
node generate-events.js
```

生成结果写入 `events/` 目录。游戏本地用 `file://` 打开时不会加载 AI 事件（fetch 跨域限制），需通过本地静态服务器或部署到 Pages 后生效：

```bash
cd sscd && python3 -m http.server 8080   # 然后访问 http://localhost:8080
```

## 数据格式

`events/latest.json` 结构：

```json
{
  "date": "2026-09-04",
  "generatedAt": "2026-09-04T00:00:00.000Z",
  "schemaVersion": 1,
  "model": "gpt-4o-mini",
  "hotTopics": ["热点标题..."],
  "count": 5,
  "events": [
    {
      "id": "ai_20260904_001",
      "type": "danger|warn|success|corruption|info",
      "tag": "汛情",
      "title": "事件标题（≤20字）",
      "desc": "事件描述（2-3句）",
      "weight": 3,
      "hotTopic": "关联热点",
      "choices": [
        { "text": "选项文本", "effects": { "treasury": -800 }, "color": "green" }
      ]
    }
  ]
}
```

**效果白名单与范围**（AI 只能影响这些字段，越界自动 clamp）：

| 字段 | 范围 | 说明 |
| --- | --- | --- |
| `treasury` | -2000 ~ 2000 | 财政（万） |
| `privateAccount` | -500 ~ 500 | 私人账户（万） |
| `corruption` | -15 ~ 15 | 腐败指数 |
| `reputation` | -15 ~ 15 | 声誉 |
| `happiness` | -15 ~ 15 | 幸福度 |
| `population` | -2000 ~ 2000 | 人口 |
| `inspection` | 0 ~ 20 | 监察风险 |
| `gdpMult` | 0.9 ~ 1.1 | GDP 乘数 |
| `educationIndex` | -10 ~ 10 | 教育指数 |
| `healthcare` | -10 ~ 10 | 医疗指数 |
| `unemployment` | -0.05 ~ 0.05 | 失业率 |
| `merit` | -5 ~ 5 | 功绩 |

## 游戏内行为

- 启动时静默从配置地址拉取事件 JSON（默认 `events/latest.json`，可配置），失败（离线 / 未部署）自动降级，不影响正常游戏。
- 游戏端只读取固定格式数据，不调用任何生成接口、不持有 API 密钥。
- AI 事件与内置事件合并进同一抽取池，按 `weight` 加权随机；AI 事件无条件限制。
- AI 事件弹窗底部显示「这个事件怎么样？👍 不错 / 👎 一般」，反馈存 `localStorage`（键 `cityPlanner_aiEventRatings`）。
- 事件对存档产生实质影响：选项效果直接作用于财政、人口、幸福度等核心指标，并进入 `pendingEvents` 限期处理。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| Actions 报 `未配置 AI_API_KEY` | 检查 Secrets 中 `AI_API_KEY` 是否已配置 |
| Actions 报 HTTP 401/403 | 检查 `AI_BASE_URL` 与密钥是否匹配该供应商 |
| 生成 0 个事件 | 模型输出不合规，可调低 `AI_TEMPERATURE` 或更换模型 |
| 游戏内无 AI 事件 | 确认已部署 Pages 且 `events/latest.json` 可访问；本地 `file://` 打开不会加载 |
| 热点抓取失败 | 不影响生成，仅日志提示；可更换 `HOT_TOPIC_SOURCES` |

## 后续规划（Phase 2/3）

- 点赞数据回传：收集玩家「赞 / 踩」用于优化生成 prompt 与事件权重。
- 个性化事件：通过 `buildAnonymizedSnapshot()` 生成脱敏存档快照，上传后由 AI 生成贴合当前存档状态的事件。
