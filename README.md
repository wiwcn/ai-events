# AI 事件生成器

为《设身处地》游戏提供 AI 随机事件的**独立生成服务**。本仓库只包含生成管线，与游戏本体完全解耦：

- 每天北京时间 0:00 由 GitHub Actions 调用大模型生成一批随机事件
- 生成结果写入 `events/` 目录并通过 GitHub Pages 发布
- 游戏端从配置的地址拉取 `events/latest.json`（固定格式），不参与生成

## 目录结构

```
scripts/generate-events.js      生成脚本（Node 18+，零依赖，OpenAI 兼容接口）
scripts/config.example.json     本地配置模板
.github/workflows/              定时生成 + 推送工作流
events/                         生成结果（latest.json / 批次归档 / index.json）
```

## 部署配置

在仓库 `Settings → Secrets and variables → Actions` 配置：

**Secrets（加密）：**

| 名称 | 说明 |
| --- | --- |
| `AI_BASE_URL` | OpenAI 兼容接口地址，如 `https://api.openai.com/v1` |
| `AI_API_KEY` | API 密钥 |
| `AI_MODEL` | 模型名，如 `gpt-4o-mini` |

**Variables（可选）：**

| 名称 | 默认 | 说明 |
| --- | --- | --- |
| `AI_EVENT_COUNT` | `5` | 每批事件数量 |
| `AI_TEMPERATURE` | `0.9` | 生成随机性 |
| `HOT_TOPIC_ENABLED` | `true` | 热点联动开关 |
| `HOT_TOPIC_SOURCES` | 见配置 | 热点 RSS 源 |

然后在 `Settings → Pages` 选择从 `main` 分支发布，即可通过 `https://<用户名>.github.io/<仓库名>/events/latest.json` 访问事件数据。

详细说明见 [AI-EVENTS.md](AI-EVENTS.md)。
