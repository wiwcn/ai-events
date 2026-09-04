#!/usr/bin/env node
/**
 * AI 事件微调数据集构建器
 * ---------------------------------------------------------------
 * 用途：在 GitHub Actions 每日生成事件后运行，把当日事件 + 玩家点赞/点踩反馈
 *       汇总成适合大模型微调（SFT / DPO）的 JSONL 数据集。
 *
 * 数据集格式（OpenAI 兼容 chat 格式，逐行 JSON）：
 *   {"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
 *
 * 反馈处理：
 *  - 点赞事件：作为正样本（重复 2 次加权）
 *  - 点踩事件：额外生成一条带 "rejected" 的样本（供 DPO 使用），并降低正样本权重
 *  - 无反馈事件：普通正样本 1 条
 *
 * 输出：
 *  - training/ai-events-train-YYYY-MM-DD.jsonl  当日数据集
 *  - training/ai-events-train.jsonl             累计合并数据集（最近 30 天）
 *  - training/feedback-summary.json             反馈统计（便于查看）
 *
 * 用法：
 *  GH_REPO=wiwcn/ai-events \
 *  GH_TOKEN=ghp_xxx（可选，公开仓库读 Issues 可不填） \
 *  node scripts/build-dataset.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = process.env.GH_REPO || 'wiwcn/ai-events';
const GH_TOKEN = process.env.GH_TOKEN || '';
const EVENTS_DIR = path.resolve(__dirname, '..', 'events');
const TRAIN_DIR = path.resolve(__dirname, '..', 'training');
const MAX_DAYS = 30;

// ============ 工具 ============
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 读取事件 ============
function loadEvents() {
  const files = fs.readdirSync(EVENTS_DIR)
    .filter(f => /^ai-events-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-MAX_DAYS);
  const all = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, f), 'utf8'));
      if (Array.isArray(data.events)) {
        for (const ev of data.events) all.push({ file: f, date: data.date, event: ev });
      }
    } catch (e) {
      console.warn(`[dataset] 读取 ${f} 失败: ${e.message}`);
    }
  }
  return all;
}

// ============ 拉取反馈（GitHub Issues） ============
async function fetchFeedback() {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'AIEventBot/1.0' };
  if (GH_TOKEN) headers['Authorization'] = 'Bearer ' + GH_TOKEN;
  const feedback = {}; // event_id -> {likes, dislikes}
  let page = 1;
  for (let i = 0; i < 5; i++) { // 最多 5 页
    const url = `https://api.github.com/repos/${REPO}/issues?state=all&labels=feedback&per_page=100&page=${page}`;
    let resp;
    try {
      resp = await fetch(url, { headers });
    } catch (e) {
      console.warn(`[dataset] 反馈拉取失败: ${e.message}`);
      break;
    }
    if (!resp.ok) {
      console.warn(`[dataset] 反馈拉取 HTTP ${resp.status}，跳过`);
      break;
    }
    const issues = await resp.json();
    if (!Array.isArray(issues) || issues.length === 0) break;
    for (const issue of issues) {
      if (issue.pull_request) continue;
      try {
        const body = JSON.parse(issue.body || '{}');
        const id = body.event_id || (issue.title || '').replace(/^\[反馈\]\s*/, '').trim();
        if (!id) continue;
        const rating = body.rating === 1 ? 1 : -1;
        if (!feedback[id]) feedback[id] = { likes: 0, dislikes: 0, title: body.title || '', city: body.city || '' };
        if (rating === 1) feedback[id].likes++;
        else feedback[id].dislikes++;
      } catch (e) { /* 跳过无法解析的 issue */ }
    }
    page++;
    await sleep(300); // 限流保护
  }
  return feedback;
}

// ============ 构造训练样本 ============
const SYSTEM_PROMPT = '你是游戏《设身处地》的剧情策划。该游戏模拟中国地方官员治理城市的全过程。请根据用户提供的一条真实热点新闻，将其本地化改编成玩家城市里发生的地方治理事件，标题/描述中用 {city} 占位符指代玩家城市，并给出 3 个各有取舍的处置选项（含受控数值效果）。输出必须是严格的 JSON 对象。';

function buildUserPrompt(ev) {
  const hot = ev.hotTopic ? `取材热点：${ev.hotTopic}` : '（无指定热点，自由发挥）';
  return `请为游戏《设身处地》生成一个突发事件。${hot}\n城市名用 {city} 占位符。`;
}

function buildAssistant(ev) {
  // 只保留模型可学习的内容，剔除运行时字段
  return JSON.stringify({
    type: ev.type,
    tag: ev.tag,
    title: ev.title,
    desc: ev.desc,
    weight: ev.weight,
    hotTopic: ev.hotTopic,
    choices: ev.choices.map(c => ({ text: c.text, effects: c.effects, color: c.color })),
  }, null, 0);
}

function makeSample(ev) {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(ev) },
      { role: 'assistant', content: buildAssistant(ev) },
    ],
  };
}

// ============ 主流程 ============
async function main() {
  const dateStr = todayStr();
  const events = loadEvents();
  console.log(`[dataset] 读取事件 ${events.length} 条（近 ${MAX_DAYS} 天）`);

  const feedback = await fetchFeedback();
  console.log(`[dataset] 拉取反馈 ${Object.keys(feedback).length} 条`);

  const samples = [];
  const summary = { date: dateStr, totalEvents: events.length, feedbackCount: Object.keys(feedback).length, liked: 0, disliked: 0, samples: 0 };
  const seenIds = new Set();

  for (const { event: ev } of events) {
    const id = ev.id;
    if (seenIds.has(id)) continue; // 跨天去重（同一天多次生成只取一次）
    seenIds.add(id);
    const fb = feedback[id];
    const base = makeSample(ev);
    if (!fb) {
      samples.push(base); // 无反馈：1 条
      summary.samples++;
    } else if (fb.likes > 0 && fb.dislikes === 0) {
      samples.push(base, base); // 点赞：加权 2 条
      summary.liked++;
      summary.samples += 2;
    } else if (fb.dislikes > 0 && fb.likes === 0) {
      // 点踩：1 条正样本 + 1 条带 rejected 的 DPO 样本
      samples.push(base);
      samples.push({ messages: base.messages, rejected: true, reason: '玩家点踩' });
      summary.disliked++;
      summary.samples += 2;
    } else {
      samples.push(base); // 有赞有踩：中性处理
      summary.samples++;
    }
  }

  ensureDir(TRAIN_DIR);
  const dailyFile = path.join(TRAIN_DIR, `ai-events-train-${dateStr}.jsonl`);
  const mergedFile = path.join(TRAIN_DIR, 'ai-events-train.jsonl');
  const lines = samples.map(s => JSON.stringify(s));
  fs.writeFileSync(dailyFile, lines.join('\n') + '\n', 'utf8');

  // 合并历史（保留最近 MAX_DAYS 天的 daily 文件）
  const dailyFiles = fs.readdirSync(TRAIN_DIR)
    .filter(f => /^ai-events-train-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .slice(-MAX_DAYS);
  const merged = [];
  for (const f of dailyFiles) {
    const content = fs.readFileSync(path.join(TRAIN_DIR, f), 'utf8').trim();
    if (content) merged.push(content);
  }
  fs.writeFileSync(mergedFile, merged.join('\n') + '\n', 'utf8');

  writeJSON(path.join(TRAIN_DIR, 'feedback-summary.json'), summary);

  console.log(`[dataset] 生成样本 ${summary.samples} 条 → ${path.basename(dailyFile)}`);
  console.log(`[dataset] 合并样本 ${merged.length} 条 → ${path.basename(mergedFile)}`);
  console.log(`[dataset] 反馈统计：点赞 ${summary.liked}，点踩 ${summary.disliked}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[dataset] 失败：' + e.message);
    process.exit(1);
  });
}

module.exports = { loadEvents, fetchFeedback, buildUserPrompt, buildAssistant, makeSample };
