#!/usr/bin/env node
/**
 * AI 随机事件生成器（Phase 1）
 * ---------------------------------------------------------------
 * 用途：在 GitHub Actions 凌晨定时任务中调用 OpenAI 兼容接口，
 *       生成一批《设身处地》可用的随机事件 JSON，推送到 GitHub Pages。
 *
 * 特性：
 *  - 供应商可配置：通过环境变量或 scripts/config.json 指定 baseUrl / apiKey / model，
 *    兼容 OpenAI / DeepSeek / 通义（DashScope 兼容模式）等任意 OpenAI 兼容端点。
 *  - 每日大批量生成：默认 300 条（可配 50-500），按批次调用模型并跨批次去重。
 *  - 数值受控：effects 仅允许白名单字段，且按范围 clamp，防止 AI 生成失衡数值。
 *  - 可选热点联动：从 RSS 源抓取热点标题作为生成上下文（可关闭，内置默认源）。
 *  - 零外部依赖：仅使用 Node 18+ 原生 fetch / fs。
 *
 * 输出：
 *  - events/ai-events-YYYY-MM-DD.json  当日批次
 *  - events/latest.json                游戏端实际拉取的最新批次
 *  - events/index.json                 批次索引（历史归档）
 *
 * 用法：
 *  AI_BASE_URL=https://api.openai.com/v1 \
 *  AI_API_KEY=sk-xxx \
 *  AI_MODEL=gpt-4o-mini \
 *  node scripts/generate-events.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// 一、配置加载（环境变量优先，其次 scripts/config.json）
// ============================================================
// 默认热点源：当环境变量与 config.json 均未配置时使用（保证 Actions 开箱即用）
const DEFAULT_HOT_SOURCES = [
  'https://www.chinanews.com.cn/rss/scroll-news.xml',
  'https://feed.cnblogs.com/blog/sitehome/rss',
  'https://www.ifanr.com/feed',
];

function loadConfig() {
  const env = process.env;
  const configPath = path.join(__dirname, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(configPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.warn('[config] scripts/config.json 解析失败，忽略：' + e.message);
    }
  }

  const hotSourcesEnv = (env.HOT_TOPIC_SOURCES || '').split(',').filter(Boolean);
  const hotSourcesFile = Array.isArray(fileCfg.hotTopicSources) ? fileCfg.hotTopicSources : [];
  const hotSources = hotSourcesEnv.length ? hotSourcesEnv : (hotSourcesFile.length ? hotSourcesFile : DEFAULT_HOT_SOURCES);

  return {
    baseUrl: (env.AI_BASE_URL || fileCfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: env.AI_API_KEY || fileCfg.apiKey || '',
    model: env.AI_MODEL || fileCfg.model || 'gpt-4o-mini',
    eventCount: clampInt(env.AI_EVENT_COUNT || fileCfg.eventCount, 50, 500, 300),
    batchSize: clampInt(env.AI_BATCH_SIZE || fileCfg.batchSize, 5, 100, 15),
    temperature: clampNum(env.AI_TEMPERATURE || fileCfg.temperature, 0, 2, 0.9),
    language: env.EVENT_LANGUAGE || fileCfg.language || 'zh-CN',
    seed: env.EVENT_SEED || fileCfg.seed || '',
    hotTopicEnabled: parseBool(env.HOT_TOPIC_ENABLED, fileCfg.hotTopicEnabled, true),
    hotTopicSources: hotSources,
    hotTopicMax: clampInt(env.HOT_TOPIC_MAX || fileCfg.hotTopicMax, 1, 15, 8),
    hotTopicTimeoutMs: clampInt(env.HOT_TOPIC_TIMEOUT || fileCfg.hotTopicTimeoutMs, 1000, 30000, 12000),
    outputDir: path.resolve(__dirname, '..', 'events'),
    maxRetries: clampInt(env.AI_MAX_RETRIES || fileCfg.maxRetries, 0, 5, 2),
    // 关闭模型思考（reasoning）：部分供应商（如商汤 SenseNova）的推理模型会先输出
    // 大量思维链，偶发把 token 预算耗尽导致 content 为空。开启后请求体附带
    // thinking:{type:'disabled'}，把全部预算留给正文，显著提升稳定性。
    disableThinking: parseBool(env.AI_DISABLE_THINKING, fileCfg.disableThinking, true),
  };
}

function parseBool(envVal, fileVal, def) {
  if (envVal !== undefined) return envVal !== 'false' && envVal !== '0';
  if (fileVal !== undefined) return !!fileVal;
  return def;
}
function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}
function clampNum(v, min, max, def) {
  const n = parseFloat(v);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// ============================================================
// 二、效果白名单与数值范围（防失衡核心）
// ============================================================
// 与游戏端 applyEffects() 支持的字段一一对应。数值范围参考内置事件量级。
const EFFECT_RULES = {
  treasury:        { min: -2000, max: 2000, step: 50,  desc: '财政（单位：万）' },
  privateAccount:  { min: -500,  max: 500,  step: 10,  desc: '私人账户（万）' },
  corruption:      { min: -15,   max: 15,   step: 1,   desc: '腐败指数' },
  reputation:      { min: -15,   max: 15,   step: 1,   desc: '声誉' },
  happiness:       { min: -15,   max: 15,   step: 1,   desc: '幸福度' },
  population:      { min: -2000, max: 2000, step: 50,  desc: '人口' },
  inspection:      { min: 0,     max: 20,   step: 1,   desc: '监察风险' },
  gdpMult:         { min: 0.9,   max: 1.1,  step: 0.01, desc: 'GDP 乘数' },
  educationIndex:  { min: -10,   max: 10,   step: 1,   desc: '教育指数' },
  healthcare:      { min: -10,   max: 10,   step: 1,   desc: '医疗指数' },
  unemployment:    { min: -0.05, max: 0.05, step: 0.01, desc: '失业率' },
  merit:           { min: -5,    max: 5,    step: 1,   desc: '功绩' },
};

const VALID_TYPES = ['danger', 'warn', 'success', 'corruption', 'info'];
const VALID_COLORS = ['green', 'blue', 'yellow', 'orange', 'red', 'gray'];

function clampEffect(effects) {
  const out = {};
  for (const [key, val] of Object.entries(effects || {})) {
    const rule = EFFECT_RULES[key];
    if (!rule) continue; // 白名单之外一律丢弃
    if (typeof val !== 'number' || !isFinite(val)) continue;
    let v = Math.round(val / rule.step) * rule.step;
    v = Math.max(rule.min, Math.min(rule.max, v));
    if (v !== 0) out[key] = v;
  }
  return out;
}

// ============================================================
// 三、事件校验器（返回 null 表示非法）
// ============================================================
function validateEvent(raw, index, dateStr) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const desc = typeof raw.desc === 'string' ? raw.desc.trim() : '';
  if (!title || title.length > 40) return null;
  if (!desc || desc.length < 10 || desc.length > 200) return null;

  const type = VALID_TYPES.includes(raw.type) ? raw.type : 'info';
  const tag = typeof raw.tag === 'string' && raw.tag.trim() ? raw.tag.trim().slice(0, 8) : 'AI生成';
  const weight = clampInt(raw.weight, 1, 5, 3);

  if (!Array.isArray(raw.choices) || raw.choices.length < 2 || raw.choices.length > 4) return null;

  const choices = [];
  for (const c of raw.choices) {
    if (!c || typeof c !== 'object') return null;
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    if (!text || text.length > 30) return null;
    const effects = clampEffect(c.effects);
    if (Object.keys(effects).length === 0) return null; // 至少一个有效效果
    choices.push({
      text,
      effects,
      color: VALID_COLORS.includes(c.color) ? c.color : 'blue',
    });
  }

  return {
    id: `ai_${dateStr.replace(/-/g, '')}_${String(index + 1).padStart(4, '0')}`,
    type,
    tag,
    title,
    desc,
    condition: null,
    weight,
    choices,
    postEffect: null,
    source: 'ai',
    // 清洗模型可能照抄的编号前缀（如 "1. xxx"）
    hotTopic: typeof raw.hotTopic === 'string' && raw.hotTopic.trim()
      ? raw.hotTopic.trim().replace(/^\s*\d+[\.、]\s*/, '').slice(0, 30)
      : '',
    generatedAt: dateStr,
    schemaVersion: 1,
  };
}

// ============================================================
// 四、热点抓取（RSS，容错）
// ============================================================
async function fetchHotTopics(cfg) {
  if (!cfg.hotTopicEnabled || !cfg.hotTopicSources.length) return [];
  const seen = new Set();
  const topics = [];

  const tasks = cfg.hotTopicSources.map(async (url) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), cfg.hotTopicTimeoutMs);
        const resp = await fetch(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIEventBot/1.0)' },
        });
        clearTimeout(timer);
        if (!resp.ok) return;
        const xml = await resp.text();
        // 极简 RSS/Atom 标题提取（跳过首个标题：通常是源站名，如"中新网即时新闻"）
        const titleRe = /<title[^>]*>([^<]+)<\/title>/gi;
        let m;
        let first = true;
        while ((m = titleRe.exec(xml)) !== null && topics.length < cfg.hotTopicMax) {
          if (first) { first = false; continue; }
          const t = m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
          if (t && !seen.has(t)) {
            seen.add(t);
            topics.push(t);
          }
        }
        return; // 成功即返回
      } catch (e) {
        console.warn(`[hot] 抓取失败（第 ${attempt + 1} 次）: ${url} → ${e.message}`);
        if (attempt === 0) await new Promise(r => setTimeout(r, 800));
      }
    }
  });

  await Promise.all(tasks);
  return topics.slice(0, cfg.hotTopicMax);
}

// ============================================================
// 五、Prompt 构造
// ============================================================
function buildPrompt(cfg, hotTopics) {
  const effectFields = Object.entries(EFFECT_RULES)
    .map(([k, r]) => `  - ${k}：${r.desc}，范围 [${r.min}, ${r.max}]`)
    .join('\n');

  const hotSection = hotTopics.length
    ? `\n请参考以下近期热点（可选，用于增强真实感；若与游戏场景无关可忽略，不要涉及敏感政治议题）：\n${hotTopics.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
    : '\n（本次不提供热点，请自由发挥。）';

  const system = `你是游戏《设身处地》的剧情策划。该游戏模拟中国地方官员（镇长/县长/市长）治理城市的全过程，核心指标包括：财政(treasury，单位万)、人口(population)、幸福度(happiness 0-100)、声誉(reputation 0-100)、腐败(corruption 0-100)、监察风险(inspection 0-100)、教育指数、医疗指数、失业率、GDP乘数、功绩。

请为游戏设计一批突发事件。要求：
1. 题材贴合地方治理场景（自然灾害、经济波动、民生诉求、公共事件、产业动态、舆论热点等），有真实感和戏剧性。
2. 每个事件 2-3 句描述，3 个选项（分别对应积极/折中/消极处置，或各有取舍），选项文本不超过 30 字。
3. 选项的 effects 只能使用以下白名单字段，且数值必须在范围内，单位与描述一致：
${effectFields}
4. 数值要有取舍感（不能所有选项都是正收益），整体量级与"单月财政收支、城市人口"匹配。
5. 输出必须是严格的 JSON 数组，不要输出任何其他文字或代码块标记。`;

  const user = `请生成 ${cfg.batchSize} 个突发事件。${hotSection}
输出格式（JSON 数组，每个元素）：
{
  "type": "danger|warn|success|corruption|info",
  "tag": "2-4字分类标签",
  "title": "事件标题（≤20字）",
  "desc": "事件描述（2-3句）",
  "weight": 1-5,
  "hotTopic": "关联热点（无则空字符串）",
  "choices": [
    { "text": "选项文本", "effects": {"字段": 数值}, "color": "green|blue|yellow|orange|red|gray" },
    { "text": "选项文本", "effects": {"字段": 数值}, "color": "green|blue|yellow|orange|red|gray" },
    { "text": "选项文本", "effects": {"字段": 数值}, "color": "green|blue|yellow|orange|red|gray" }
  ]
}`;

  return { system, user };
}

// ============================================================
// 六、LLM 调用（带重试 + JSON 容错）
// ============================================================
function extractJSON(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // 1) 直接解析
  try { return JSON.parse(trimmed); } catch (e) {}
  // 2) 提取 ```json ... ``` 代码块
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch (e) {}
  }
  // 3) 提取第一个 [ 到最后一个 ]
  const first = trimmed.indexOf('[');
  const last = trimmed.lastIndexOf(']');
  if (first >= 0 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch (e) {}
  }
  // 4) 截断恢复：模型可能中途停止导致 JSON 不完整，从末尾逐个 } 截断，抢救完整对象
  if (first >= 0) {
    const salvaged = salvageArray(trimmed, first);
    if (salvaged) return salvaged;
  }
  return null;
}

// 从截断的 JSON 数组中恢复尽可能多的完整事件对象
function salvageArray(text, firstBracket) {
  let idx = text.lastIndexOf('}');
  while (idx > firstBracket) {
    const candidate = text.slice(firstBracket, idx + 1) + ']';
    try {
      const arr = JSON.parse(candidate);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    } catch (e) { /* 继续向前截断 */ }
    idx = text.lastIndexOf('}', idx - 1);
  }
  return null;
}

async function callLLM(cfg, system, user) {
  if (!cfg.apiKey) {
    throw new Error('未配置 AI_API_KEY（环境变量）或 config.json 中的 apiKey');
  }

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let lastErr = null;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) {
      console.warn(`[llm] 第 ${attempt} 次重试...`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
    try {
      const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: cfg.temperature,
          max_tokens: 8000,
          ...(cfg.disableThinking ? { thinking: { type: 'disabled' } } : {}),
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      }

      const data = await resp.json();
      const msg = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message
        : null;
      // 部分供应商（如商汤 SenseNova）偶发把正文放进 reasoning 字段而 content 为空，
      // 这里对 content 与 reasoning 都尝试解析，保证事件不丢失。
      const content = msg ? (msg.content || '') : '';
      const reasoning = msg && typeof msg.reasoning === 'string' ? msg.reasoning : '';
      let parsed = extractJSON(content);
      if (!parsed && reasoning) {
        parsed = extractJSON(reasoning);
        if (parsed) console.log('[llm] content 为空，已从 reasoning 字段解析出 JSON');
      }
      if (parsed) return parsed;
      console.warn(`[llm] 内容无法解析，content 片段: ${String(content).slice(0, 120).replace(/\n/g, ' ')}`);
      throw new Error('模型返回内容无法解析为 JSON');
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] 调用失败（第 ${attempt + 1} 次）: ${e.message}`);
    }
  }
  throw lastErr || new Error('LLM 调用失败');
}

// ============================================================
// 七、文件输出
// ============================================================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ============================================================
// 八、主流程
// ============================================================
async function main() {
  const cfg = loadConfig();
  const dateStr = todayStr();
  console.log(`[AI-Events] 供应商: ${cfg.baseUrl} | 模型: ${cfg.model} | 目标数量: ${cfg.eventCount}`);

  // 1. 抓热点
  let hotTopics = [];
  if (cfg.hotTopicEnabled && cfg.hotTopicSources.length) {
    console.log('[AI-Events] 抓取热点...');
    hotTopics = await fetchHotTopics(cfg);
    console.log(`[AI-Events] 获取热点 ${hotTopics.length} 条`);
  } else {
    console.log('[AI-Events] 热点联动已关闭或未配置数据源');
  }

  // 2. 构造 prompt
  const { system, user } = buildPrompt(cfg, hotTopics);

  // 3. 分批调用 LLM，累积到目标数量（去重 + 校验）
  const events = [];
  const seenTitles = new Set();
  const maxBatches = Math.ceil(cfg.eventCount / cfg.batchSize) + 2; // 允许少量冗余批次
  for (let b = 1; b <= maxBatches && events.length < cfg.eventCount; b++) {
    console.log(`[AI-Events] 第 ${b}/${maxBatches} 批：调用 LLM 生成 ${cfg.batchSize} 个事件...`);
    const rawEvents = await callLLM(cfg, system, user);
    if (!Array.isArray(rawEvents)) {
      console.warn(`[AI-Events] 第 ${b} 批返回非数组，跳过`);
      continue;
    }
    let batchOk = 0;
    for (let i = 0; i < rawEvents.length; i++) {
      const ev = validateEvent(rawEvents[i], events.length + i, dateStr);
      if (!ev) continue;
      const key = ev.title;
      if (seenTitles.has(key)) continue; // 跨批次去重
      seenTitles.add(key);
      events.push(ev);
      batchOk++;
    }
    console.log(`[AI-Events] 第 ${b} 批校验通过 ${batchOk} 个，累计 ${events.length}/${cfg.eventCount}`);
    if (batchOk === 0 && b > 1) {
      console.warn('[AI-Events] 连续批次无有效事件，提前结束');
      break;
    }
    if (b < maxBatches && events.length < cfg.eventCount) {
      await new Promise(r => setTimeout(r, 600)); // 批次间隔，避免触发限流
    }
  }
  if (events.length === 0) {
    throw new Error('所有生成的事件均未通过校验，本次不发布');
  }
  console.log(`[AI-Events] 校验通过 ${events.length} 个事件（目标 ${cfg.eventCount}）`);

  // 4. 写文件
  const batchFile = `ai-events-${dateStr}.json`;
  const batch = {
    date: dateStr,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    model: cfg.model,
    hotTopics,
    count: events.length,
    events,
  };
  writeJSON(path.join(cfg.outputDir, batchFile), batch);

  const latest = {
    date: dateStr,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    model: cfg.model,
    hotTopics,
    count: events.length,
    events,
  };
  writeJSON(path.join(cfg.outputDir, 'latest.json'), latest);

  // 5. 更新索引
  const indexPath = path.join(cfg.outputDir, 'index.json');
  let index = { batches: [] };
  if (fs.existsSync(indexPath)) {
    try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (e) {}
    if (!Array.isArray(index.batches)) index.batches = [];
  }
  const existing = index.batches.findIndex(b => b.date === dateStr);
  const entry = { date: dateStr, file: batchFile, count: events.length, generatedAt: latest.generatedAt };
  if (existing >= 0) index.batches[existing] = entry;
  else index.batches.unshift(entry);
  index.batches = index.batches.slice(0, 60); // 保留最近 60 天
  writeJSON(indexPath, index);

  console.log(`[AI-Events] 完成：${batchFile}（${events.length} 个事件）`);
  console.log(`[AI-Events] 已更新 latest.json 与 index.json`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[AI-Events] 失败：' + e.message);
    process.exit(1);
  });
}

// 供本地测试复用内部函数（直接运行本脚本时不受影响）
if (typeof module !== 'undefined' && require.main !== module) {
  module.exports = { loadConfig, buildPrompt, fetchHotTopics, extractJSON, validateEvent, callLLM, EFFECT_RULES };
}
