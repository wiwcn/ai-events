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
// 覆盖综合新闻 / 时政 / 科技 / 数码 / 商业 / 汽车 / 生活 / 技术，多源并发抓取、失败自动降级。
const DEFAULT_HOT_SOURCES = [
  'https://www.chinanews.com.cn/rss/scroll-news.xml', // 中新网·综合新闻
  'https://www.people.com.cn/rss/politics.xml',       // 人民网·时政
  'https://www.ifanr.com/feed',                       // 爱范儿·科技消费
  'https://www.36kr.com/feed',                        // 36氪·科技商业
  'https://sspai.com/feed',                           // 少数派·科技生活
  'https://www.ithome.com/rss/',                      // IT之家·数码
  'https://www.leiphone.com/feed',                    // 雷峰网·汽车科技
  'https://www.geekpark.net/rss',                     // 极客公园·科技
  'https://feed.cnblogs.com/blog/sitehome/rss',       // 博客园·技术社区
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
    hotTopicMax: clampInt(env.HOT_TOPIC_MAX || fileCfg.hotTopicMax, 1, 30, 20),
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
// 四、热点抓取（RSS/Atom，容错）
// ============================================================
// 从 RSS/Atom XML 中稳健提取标题：兼容 CDATA 包裹、HTML 实体、嵌套标签。
function extractTitles(xml) {
  const titles = [];
  const re = /<title[^>]*>([\s\S]*?)<\/title>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    let t = m[1]
      .replace(/<!\[CDATA\[|\]\]>/g, '')   // 去掉 CDATA 包裹
      .replace(/<[^>]+>/g, '')             // 去掉残留 HTML 标签
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&#x27;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))) // 十六进制数字实体
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))          // 十进制数字实体
      .trim();
    if (t) titles.push(t);
  }
  return titles;
}

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
        // 跳过首个标题（通常是源站名，如"中新网即时新闻"/"时政频道"）
        const titles = extractTitles(xml).slice(1);
        for (const t of titles) {
          if (topics.length >= cfg.hotTopicMax) return;
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
    ? `\n以下是今日真实热点新闻标题（每条都必须取材）：
${hotTopics.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
    : '\n（本次未提供热点，请自由发挥。）';

  const system = `你是游戏《设身处地》的剧情策划。该游戏模拟中国地方官员（镇长/县长/市长）治理城市的全过程，核心指标包括：财政(treasury，单位万)、人口(population)、幸福度(happiness 0-100)、声誉(reputation 0-100)、腐败(corruption 0-100)、监察风险(inspection 0-100)、教育指数、医疗指数、失业率、GDP乘数、功绩。

请为游戏设计一批突发事件。要求：
1. 每个事件必须取材于用户消息中提供的某条真实热点新闻，把该新闻"本地化"改编成玩家城市里发生的地方治理事件（如某地灾后复产→"{city}灾后复产"、某行业新规→"{city}落实该新规"），让玩家产生"新闻照进现实"的会心一笑。严禁照抄真实人物姓名，只做虚构化改编。
2. 事件标题/描述中在提到城市处使用占位符 {city}（游戏端会自动替换为玩家城市名），例如"{city}突降暴雨，城区内涝告急"。
3. 题材贴合地方治理场景（自然灾害、经济波动、民生诉求、公共事件、产业动态、舆论热点、基层治理、公共服务等），有真实感和戏剧性。
4. 描述要丰满有细节：3-4 句，60-180 字，交代事件起因、现场情况、影响范围、涉及群体，避免空泛套话；让玩家读起来像本地新闻通稿。
5. 每个事件 3-4 个选项（分别对应积极/折中/消极处置，或各有取舍），选项文本 8-30 字，要体现具体处置动作而非口号。
6. 选项的 effects 只能使用以下白名单字段，且数值必须在范围内，单位与描述一致：
${effectFields}
7. 数值要有取舍感（不能所有选项都是正收益），整体量级与"单月财政收支、城市人口"匹配。
8. 输出必须是严格的 JSON 数组，不要输出任何其他文字或代码块标记。`;

  const user = `请生成 ${cfg.batchSize} 个突发事件。${hotSection}
每个事件必须从上述热点中选一条作为灵感来源，并在 hotTopic 字段填写该热点标题原文；事件内容要与该热点明显相关（标题或描述中体现），并尽量使用 {city} 占位符指代玩家城市。注意：同一批内各事件取材的热点尽量不同，避免题材扎堆重复。
输出格式（JSON 数组，每个元素）：
{
  "type": "danger|warn|success|corruption|info",
  "tag": "2-4字分类标签",
  "title": "事件标题（≤20字，可用{city}）",
  "desc": "事件描述（3-4句，60-180字，可用{city}，要有起因/现场/影响等细节）",
  "weight": 1-5,
  "hotTopic": "取材的热点标题（必填，不得为空）",
  "choices": [
    { "text": "具体处置动作", "effects": {"字段": 数值}, "color": "green|blue|yellow|orange|red|gray" },
    { "text": "具体处置动作", "effects": {"字段": 数值}, "color": "green|blue|yellow|orange|red|gray" },
    { "text": "具体处置动作", "effects": {"字段": 数值}, "color": "green|blue|yellow|orange|red|gray" }
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
// 七.五、去重工具（标题归一化 + 近似重复检测 + 跨天历史去重）
// ============================================================
// 归一化标题：去掉 {city} 占位符、标点、空白，统一小写，用于精确去重
function normalizeKey(title) {
  return String(title || '')
    .replace(/\{city\}/g, '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    .toLowerCase();
}

// 字符二元组（bigram）集合，用于计算标题相似度
function bigrams(str) {
  const s = normalizeKey(str);
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

// Jaccard 相似度：两个标题的 bigram 集合交集 / 并集
function titleSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

// 相似度阈值：高于此值视为近似重复（同一事件换了个说法）
const DUP_SIM_THRESHOLD = 0.7;

// 读取历史事件标题，用于跨天去重（避免每天重复生成相同事件）
function loadHistoricalKeys() {
  const keys = new Set();
  const dir = path.resolve(__dirname, '..', 'events');
  if (!fs.existsSync(dir)) return keys;
  const files = fs.readdirSync(dir)
    .filter(f => /^ai-events-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-30); // 最近 30 天
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Array.isArray(data.events)) {
        for (const ev of data.events) {
          if (ev && ev.title) keys.add(normalizeKey(ev.title));
        }
      }
    } catch (e) { /* 忽略损坏文件 */ }
  }
  return keys;
}

// 判断是否与已收集事件重复（精确 + 近似）
function isDuplicate(title, seenKeys, seenTitles) {
  const key = normalizeKey(title);
  if (seenKeys.has(key)) return true; // 精确重复（含跨天）
  for (const t of seenTitles) {
    if (titleSimilarity(title, t) >= DUP_SIM_THRESHOLD) return true; // 近似重复
  }
  return false;
}

// Fisher-Yates 洗牌（用于每批热点子集随机化）
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
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

  // 2. 构造 prompt（基础版；每批会基于洗牌后的热点子集重建）
  const { system: baseSystem, user: baseUser } = buildPrompt(cfg, hotTopics);

  // 3. 分批调用 LLM，累积到目标数量（去重 + 校验）
  const events = [];
  const seenKeys = loadHistoricalKeys(); // 跨天历史标题（精确去重，避免每天重复）
  const seenTitles = [];                 // 本次会话标题（近似去重）
  let globalIndex = 0; // 全局事件编号（用于生成唯一 ID）
  let dupSkipped = 0;  // 被去重跳过的数量
  const maxBatches = Math.ceil(cfg.eventCount / cfg.batchSize) * 2 + 2; // 给去重留冗余批次
  for (let b = 1; b <= maxBatches && events.length < cfg.eventCount; b++) {
    // 每批洗牌热点并取子集，避免跨批次题材扎堆、提高去重后产量
    const batchHot = shuffle(hotTopics).slice(0, Math.min(10, hotTopics.length));
    const { system, user } = hotTopics.length ? buildPrompt(cfg, batchHot) : { system: baseSystem, user: baseUser };
    console.log(`[AI-Events] 第 ${b}/${maxBatches} 批：调用 LLM 生成 ${cfg.batchSize} 个事件（本批热点 ${batchHot.length} 条）...`);
    const rawEvents = await callLLM(cfg, system, user);
    if (!Array.isArray(rawEvents)) {
      console.warn(`[AI-Events] 第 ${b} 批返回非数组，跳过`);
      continue;
    }
    let batchOk = 0;
    for (let i = 0; i < rawEvents.length; i++) {
      // 用全局单调递增计数器生成 ID，避免跨批次因校验/去重跳过导致编号重复
      const ev = validateEvent(rawEvents[i], globalIndex, dateStr);
      if (!ev) continue;
      if (isDuplicate(ev.title, seenKeys, seenTitles)) { dupSkipped++; continue; } // 精确/近似/跨天去重
      seenKeys.add(normalizeKey(ev.title));
      seenTitles.push(ev.title);
      globalIndex++;
      events.push(ev);
      batchOk++;
    }
    console.log(`[AI-Events] 第 ${b} 批校验通过 ${batchOk} 个，累计 ${events.length}/${cfg.eventCount}（去重跳过累计 ${dupSkipped}）`);
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
  module.exports = {
    loadConfig, buildPrompt, fetchHotTopics, extractJSON, validateEvent, callLLM,
    EFFECT_RULES, extractTitles, normalizeKey, titleSimilarity, isDuplicate, loadHistoricalKeys,
  };
}
