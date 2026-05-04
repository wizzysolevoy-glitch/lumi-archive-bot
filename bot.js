require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');

// ========== НАСТРОЙКИ ==========
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: false }
});
const ADMIN_ID = 8660224775;
let botUsername = process.env.BOT_USERNAME || '';
if (botUsername.startsWith('@')) botUsername = botUsername.slice(1);

// ========== БАЗА ДАННЫХ ==========
const db = new Database('lumi_archive.db');

try { db.exec('ALTER TABLE users ADD COLUMN searches INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN referrals INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN is_premium INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN premium_expires DATETIME'); } catch (e) {}
try { db.exec('UPDATE users SET requests = 3 WHERE requests IS NULL'); } catch (e) {}
try { db.exec('UPDATE users SET searches = 0 WHERE searches IS NULL'); } catch (e) {}
try { db.exec('UPDATE users SET referrals = 0 WHERE referrals IS NULL'); } catch (e) {}
try { db.exec('UPDATE users SET is_premium = 0 WHERE is_premium IS NULL'); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    requests INTEGER DEFAULT 3,
    searches INTEGER DEFAULT 0,
    referrals INTEGER DEFAULT 0,
    is_premium INTEGER DEFAULT 0,
    premium_expires DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    url TEXT,
    date TEXT,
    found INTEGER,
    searched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER,
    referred_id INTEGER UNIQUE,
    rewarded INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
  createUser: db.prepare('INSERT OR IGNORE INTO users (user_id, username, first_name, requests) VALUES (?, ?, ?, ?)'),
  updateUser: db.prepare('UPDATE users SET username = ?, first_name = ? WHERE user_id = ?'),
  useRequest: db.prepare('UPDATE users SET requests = requests - 1 WHERE user_id = ?'),
  addRequests: db.prepare('UPDATE users SET requests = requests + ? WHERE user_id = ?'),
  addHistory: db.prepare('INSERT INTO search_history (user_id, url, date, found) VALUES (?, ?, ?, ?)'),
  getHistory: db.prepare('SELECT * FROM search_history WHERE user_id = ? ORDER BY searched_at DESC LIMIT 10'),
  addReferral: db.prepare('INSERT OR IGNORE INTO referrals (referrer_id, referred_id) VALUES (?, ?)'),
  rewardReferral: db.prepare('UPDATE referrals SET rewarded = 1 WHERE referrer_id = ? AND referred_id = ?'),
  getReferralCount: db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ? AND rewarded = 1'),
  getStats: db.prepare('SELECT COUNT(*) as total_users, SUM(requests) as total_requests FROM users'),
  getAllUsers: db.prepare('SELECT user_id, username, first_name, requests, referrals, is_premium, created_at FROM users ORDER BY created_at DESC')
};

// ========== СОСТОЯНИЯ ==========
const userStates = new Map();
function setState(userId, state) { userStates.set(userId, state); }
function getState(userId) { return userStates.get(userId); }
function clearState(userId) { userStates.delete(userId); }

// ========== УТИЛИТЫ ==========
function getOrCreateUser(ctx) {
  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || 'Пользователь';
  stmts.createUser.run(userId, username, firstName, 3);
  stmts.updateUser.run(username, firstName, userId);
  return stmts.getUser.get(userId);
}

function isAdmin(ctx) { return ctx.from.id === ADMIN_ID; }

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isValidUrl(url) {
  try { new URL(url); return true; } catch { return false; }
}

// ========== CDX API — список дат ==========
async function getArchiveDates(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    // Убираем протокол и www для поиска по домену
    let cleanUrl = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
    // Берём только домен (без пути)
    try {
      const u = new URL('https://' + cleanUrl);
      cleanUrl = u.hostname;
    } catch (e) {}

    // matchType=domain — ищем по всему домену
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(cleanUrl)}&matchType=domain&output=json&collapse=timestamp:6&limit=30&fl=timestamp,original`;
    console.log(`[CDX] ${cdxUrl}`);
    
    const res = await fetch(cdxUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    clearTimeout(timeout);
    
    console.log(`[CDX] Status: ${res.status}`);
    if (!res.ok) {
      console.log(`[CDX] HTTP error: ${res.status}`);
      return null;
    }
    
    const data = await res.json();
    console.log(`[CDX] Rows: ${data.length}`);
    
    if (!Array.isArray(data) || data.length < 2) {
      console.log(`[CDX] Empty or invalid response`);
      return null;
    }
    
    const dates = [];
    const seen = new Set();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const ts = row[0]; // fl=timestamp,original → ts в индексе 0
      if (!ts || ts.length < 6) continue;
      const year = ts.substring(0, 4);
      const month = ts.substring(4, 6);
      const ym = `${year}-${month}`;
      if (!seen.has(ym)) {
        seen.add(ym);
        dates.push({ ts: ts.substring(0, 6), display: `${year}-${month}` });
      }
    }
    console.log(`[CDX] Found ${dates.length} unique months`);
    return dates.slice(0, 20);
  } catch (e) {
    clearTimeout(timeout);
    console.error('[CDX ERROR]', e.message);
    return null;
  }
}

// ========== ПОИСК СНАПШОТА ==========
async function searchArchiveSingle(cleanUrl, timestamp) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const apiUrl = timestamp
      ? `https://archive.org/wayback/available?url=${encodeURIComponent(cleanUrl)}&timestamp=${timestamp}`
      : `https://archive.org/wayback/available?url=${encodeURIComponent(cleanUrl)}`;
    const res = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.archived_snapshots?.closest?.available) {
      const s = data.archived_snapshots.closest;
      return { found: true, url: s.url.replace('http://', 'https://'), timestamp: s.timestamp, status: s.status };
    }
    return { found: false };
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') return { found: false, error: 'timeout' };
    return { found: false, error: e.message };
  }
}

async function searchArchiveSmart(url, timestamp) {
  const cleanUrl = url.replace(/^https?:\/\//, '');
  const variants = [{ url: cleanUrl, ts: timestamp }, { url: cleanUrl, ts: null }];
  if (cleanUrl.startsWith('www.')) variants.push({ url: cleanUrl.replace('www.', ''), ts: timestamp });
  try {
    const u = new URL(url);
    if (u.pathname !== '/' && u.pathname !== '') {
      variants.push({ url: u.hostname, ts: timestamp });
      variants.push({ url: u.hostname, ts: null });
    }
  } catch (e) {}
  for (const v of variants) {
    const r = await searchArchiveSingle(v.url, v.ts);
    if (r.found) return r;
  }
  return { found: false };
}

// ========== КЛАВИАТУРЫ ==========
const keyboards = {
  main: Markup.inlineKeyboard([
    [Markup.button.callback('🕷️ Найти в архиве', 'search_archive')],
    [Markup.button.callback('🕸️ История', 'history'), Markup.button.callback('💰 Баланс', 'balance')],
    [Markup.button.callback('👥 Рефералка', 'referral'), Markup.button.callback('💎 Премиум', 'premium')],
    [Markup.button.callback('🕷️ Как это работает', 'help'), Markup.button.callback('🔐 Админ', 'admin_login')]
  ]),
  back: Markup.inlineKeyboard([[Markup.button.callback('🕸️ Главное меню', 'main_menu')]]),
  premium: Markup.inlineKeyboard([
    [Markup.button.callback('💎 Неделя — 2 USDT', 'pay_week')],
    [Markup.button.callback('💎 Месяц — 5 USDT', 'pay_month')],
    [Markup.button.callback('💎 Год — 15 USDT', 'pay_year')],
    [Markup.button.callback('🕸️ Назад', 'main_menu')]
  ]),
  admin: Markup.inlineKeyboard([
    [Markup.button.callback('📊 Статистика', 'admin_stats')],
    [Markup.button.callback('👥 Пользователи', 'admin_users'), Markup.button.callback('🧪 Тест API', 'admin_testapi')],
    [Markup.button.callback('📢 Рассылка', 'admin_broadcast'), Markup.button.callback('🗑️ Удалить юзера', 'admin_delete')],
    [Markup.button.callback('🎁 Выдать запросы', 'admin_give')],
    [Markup.button.callback('🕸️ Назад', 'main_menu')]
  ])
};

// ========== ОБРАБОТЧИКИ ==========

bot.start((ctx) => {
  const userId = ctx.from.id;
  const payload = ctx.startPayload;
  if (payload && payload.startsWith('ref_')) {
    const referrerId = parseInt(payload.split('ref_')[1]);
    if (referrerId && referrerId !== userId) {
      const referrer = stmts.getUser.get(referrerId);
      if (referrer) {
        const existing = db.prepare('SELECT * FROM referrals WHERE referrer_id = ? AND referred_id = ?').get(referrerId, userId);
        if (!existing) {
          stmts.addReferral.run(referrerId, userId);
          stmts.rewardReferral.run(referrerId, userId);
          stmts.addRequests.run(5, referrerId);
          ctx.reply('🕷️ <b>Ты пришёл по реферальной ссылке!</b> 🕸️\n\n✅ Тебе начислено <b>3 бесплатных запроса</b>\n✅ Твой друг получил <b>+5 запросов</b>', { parse_mode: 'HTML' });
          ctx.telegram.sendMessage(referrerId, `🕸️ <b>Новый реферал!</b> 🕷️\n\nПользователь <b>${escapeHtml(ctx.from.first_name)}</b> присоединился!\n🔹 +5 запросов начислено`, { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    }
  }
  getOrCreateUser(ctx);
  ctx.reply(
    '🕷️ <b>Lumi Archive</b> 🕸️\n\n<i>Путешествие во времени по интернету</i>\n\n🕸️ <b>Что я умею:</b>\n• Находить старые версии любых сайтов\n• Показывать исторические снимки\n• Работать с нашей базой архивов\n\n<b>Как искать:</b>\n1. Нажми "🕷️ Найти в архиве"\n2. Отправь ссылку на сайт\n3. Выбери дату из списка\n4. Получи ссылку на архив!\n\n🕷️ Выбери действие:',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

bot.action('main_menu', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const user = getOrCreateUser(ctx);
  ctx.editMessageText(
    '🕷️ <b>Lumi Archive</b> 🕸️\n\n<i>Путешествие во времени по интернету</i>\n\n🕸️ Запросов: <b>' + user.requests + '</b>\n🕷️ Рефералов: <b>' + (user.referrals || 0) + '</b>\n\nВыбери действие:',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  ).catch(() => {});
});

bot.action('search_archive', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  setState(ctx.from.id, { step: 'waiting_url' });
  ctx.editMessageText(
    '🕷️ <b>Поиск в архиве</b> 🕸️\n\nОтправь ссылку на сайт:\n\n<code>https://vk.com</code>\n<code>https://youtube.com</code>\n<code>https://example.com</code>\n\n<i>Бот найдёт все доступные даты и покажет кнопками!</i>',
    { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
  ).catch(() => {});
});

bot.action('history', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const history = stmts.getHistory.all(ctx.from.id);
  if (history.length === 0) {
    return ctx.editMessageText('🕸️ <b>История поиска</b>\n\nПока пусто... Сделай первый поиск!', { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup });
  }
  let text = '🕸️ <b>История поиска</b> 🕷️\n\n';
  history.forEach((item) => {
    const icon = item.found ? '✅' : '❌';
    text += icon + ' <a href="' + item.url + '">' + escapeHtml(item.url.substring(0, 35)) + (item.url.length > 35 ? '...' : '') + '</a>\n';
    text += '   📅 ' + item.date + ' | 🕐 ' + formatDate(item.searched_at) + '\n\n';
  });
  ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup });
});

bot.action('balance', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const user = getOrCreateUser(ctx);
  const refCount = stmts.getReferralCount.get(user.id)?.count || 0;
  ctx.editMessageText(
    '💰 <b>Мой баланс</b> 🕸️\n\n🕷️ Запросов: <b>' + user.requests + '</b>\n🕸️ Рефералов: <b>' + refCount + '</b>\n💎 Премиум: <b>' + (user.is_premium ? 'Активен' : 'Нет') + '</b>\n\n👥 Пригласи друга и получи <b>+5 запросов</b>!\n💎 Купи премиум для безлимита!',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

bot.action('referral', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const refCount = stmts.getReferralCount.get(userId)?.count || 0;
  const link = 'https://t.me/' + botUsername + '?start=ref_' + userId;
  ctx.editMessageText(
    '👥 <b>Реферальная программа</b> 🕸️\n\n🕷️ Приглашено: <b>' + refCount + '</b> чел.\n🕸️ Бонус: <b>+5 запросов</b> за друга\n\n💡 <b>Как пригласить:</b>\n1. Нажми кнопку "Поделиться" ниже\n2. Или скопируй ссылку и отправь другу\n3. Когда он запустит бота — получишь бонус!',
    {
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url('📤 Поделиться', 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('🕷️ Нашёл крутого бота для поиска старых версий сайтов! 3 бесплатных запроса!'))],
        [Markup.button.callback('🕸️ Главное меню', 'main_menu')]
      ]).reply_markup
    }
  );
});

bot.action('premium', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText(
    '💎 <b>Премиум доступ</b> 🕸️\n\n🕷️ <b>Что даёт премиум:</b>\n• Безлимитный поиск\n• Приоритетная скорость\n• Доступ к редким архивам\n• Поддержка 24/7\n\n💎 <b>Тарифы (USDT):</b>\n\n🕷️ Неделя — <b>2 USDT</b>\n🕸️ Месяц — <b>5 USDT</b>\n🕷️ Год — <b>15 USDT</b>\n\n💳 Оплата через @CryptoBot',
    { parse_mode: 'HTML', reply_markup: keyboards.premium.reply_markup }
  );
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText(
    '🕷️ <b>Как это работает</b> 🕸️\n\nНаша система хранит миллиарды снимков веб-страниц с 1996 года.\n\n<b>Как искать:</b>\n1. Нажми "🕷️ Найти в архиве"\n2. Отправь ссылку на сайт\n3. Выбери дату из списка кнопками\n4. Получи ссылку на историческую версию!\n\n<b>Примеры:</b>\n• vk.com — какой был VK в 2010?\n• youtube.com — какой был YouTube в 2007?\n\n🕸️ Нажми "Назад" чтобы начать!',
    { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
  );
});

// Оплата
bot.action('pay_week', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText('💎 <b>Неделя — 2 USDT</b> 🕷️\n\n1. Открой @CryptoBot\n2. Отправь 2 USDT админу\n3. Пришли скриншот сюда\n\n🕸️ Или напиши: @lumi_support', { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup });
});

bot.action('pay_month', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText('💎 <b>Месяц — 5 USDT</b> 🕸️\n\n1. Открой @CryptoBot\n2. Отправь 5 USDT админу\n3. Пришли скриншот сюда\n\n🕷️ Или напиши: @lumi_support', { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup });
});

bot.action('pay_year', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  ctx.editMessageText('💎 <b>Год — 15 USDT</b> 🕷️\n\n1. Открой @CryptoBot\n2. Отправь 15 USDT админу\n3. Пришли скриншот сюда\n\n🕸️ Или напиши: @lumi_support', { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup });
});

// ========== ВЫБОР ДАТЫ КНОПКАМИ ==========
bot.action(/^date_(\d{4,6})$/, async (ctx) => {
  await ctx.answerCbQuery('🕷️ Ищем архив...').catch(() => {});
  const userId = ctx.from.id;
  const state = getState(userId);
  if (!state || state.step !== 'waiting_date_selection') {
    return ctx.reply('🕸️ Сессия истекла. Начни заново.', { reply_markup: keyboards.main.reply_markup });
  }
  
  const timestamp = ctx.match[1];
  const url = state.url;
  const user = getOrCreateUser(ctx);
  const requestsLeft = user.requests || 0;
  
  if (requestsLeft <= 0 && !user.is_premium) {
    return ctx.reply('❌ <b>Запросы закончились!</b> 🕸️\n\n💎 Купи премиум или пригласи друга!', { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup });
  }
  
  await ctx.replyWithChatAction('typing');
  const result = await searchArchiveSmart(url, timestamp);
  
  if (!user.is_premium) stmts.useRequest.run(userId);
  stmts.addHistory.run(userId, url, timestamp, result.found ? 1 : 0);
  
  if (result.found) {
    const archiveDate = result.timestamp.substring(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    ctx.reply(
      '🕷️ <b>Архив найден!</b> 🕸️\n\n🔗 <b>Оригинал:</b> <a href="' + url + '">' + escapeHtml(url) + '</a>\n📅 <b>Дата архива:</b> ' + archiveDate + '\n🕸️ <b>Статус:</b> ' + (result.status === '200' ? '✅ Сохранён' : '⚠️ ' + result.status) + '\n\n👇 <b>Открыть архив:</b>\n<a href="' + result.url + '">🕷️ Смотреть историческую версию</a>',
      { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup, disable_web_page_preview: true }
    );
  } else {
    ctx.reply(
      '🕸️ <b>Архив не найден</b> 🕷️\n\n🔗 Ссылка: <a href="' + url + '">' + escapeHtml(url) + '</a>\n📅 Дата: ' + timestamp + '\n\n😕 К сожалению, снапшот за эту дату недоступен.\n\n💡 Попробуй другую дату!',
      { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
    );
  }
});

bot.action('date_any', async (ctx) => {
  await ctx.answerCbQuery('🕷️ Ищем любой архив...').catch(() => {});
  const userId = ctx.from.id;
  const state = getState(userId);
  if (!state || state.step !== 'waiting_date_selection') {
    return ctx.reply('🕸️ Сессия истекла. Начни заново.', { reply_markup: keyboards.main.reply_markup });
  }
  const url = state.url;
  const user = getOrCreateUser(ctx);
  const requestsLeft = user.requests || 0;
  if (requestsLeft <= 0 && !user.is_premium) {
    return ctx.reply('❌ <b>Запросы закончились!</b> 🕸️\n\n💎 Купи премиум или пригласи друга!', { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup });
  }
  await ctx.replyWithChatAction('typing');
  const result = await searchArchiveSmart(url, null);
  if (!user.is_premium) stmts.useRequest.run(userId);
  stmts.addHistory.run(userId, url, 'any', result.found ? 1 : 0);
  if (result.found) {
    const archiveDate = result.timestamp.substring(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    ctx.reply(
      '🕷️ <b>Архив найден!</b> 🕸️\n\n🔗 <b>Оригинал:</b> <a href="' + url + '">' + escapeHtml(url) + '</a>\n📅 <b>Дата архива:</b> ' + archiveDate + '\n🕸️ <b>Статус:</b> ' + (result.status === '200' ? '✅ Сохранён' : '⚠️ ' + result.status) + '\n\n👇 <b>Открыть архив:</b>\n<a href="' + result.url + '">🕷️ Смотреть историческую версию</a>',
      { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup, disable_web_page_preview: true }
    );
  } else {
    ctx.reply(
      '🕸️ <b>Архив не найден</b> 🕷️\n\n🔗 Ссылка: <a href="' + url + '">' + escapeHtml(url) + '</a>\n\n😕 К сожалению, для этого сайта нет архивов.\n\n💡 Попробуй другой сайт!',
      { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
    );
  }
});

// ========== ОБРАБОТКА ТЕКСТА ==========
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const text = ctx.text.trim();
  
  // Админ: пароль
  if (state?.action === 'admin_password') {
    clearState(userId);
    if (text === '8660224775') {
      return ctx.reply('🔓 <b>Доступ разрешён!</b> 🕸️\n\nВыбери действие:', { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup });
    } else {
      return ctx.reply('🕸️ ⛔️ Неверный пароль 🕷️', { reply_markup: keyboards.main.reply_markup });
    }
  }
  
  // Админ: выдать запросы
  if (state?.action === 'admin_give' && isAdmin(ctx)) {
    clearState(userId);
    const parts = text.split(/\s+/);
    if (parts.length !== 2) return ctx.reply('❌ Формат: <code>ID КОЛИЧЕСТВО</code>', { parse_mode: 'HTML' });
    const targetId = parseInt(parts[0]);
    const amount = parseInt(parts[1]);
    if (!targetId || !amount) return ctx.reply('❌ Неверные числа');
    const target = stmts.getUser.get(targetId);
    if (!target) return ctx.reply('❌ Пользователь не найден');
    stmts.addRequests.run(amount, targetId);
    ctx.reply('✅ Выдано <b>' + amount + '</b> запросов', { parse_mode: 'HTML' });
    ctx.telegram.sendMessage(targetId, '🕸️ <b>Бонус!</b>\n\nТебе начислено <b>' + amount + '</b> запросов!', { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  
  // Админ: рассылка
  if (state?.action === 'admin_broadcast' && isAdmin(ctx)) {
    clearState(userId);
    const users = stmts.getAllUsers.all();
    let sent = 0, failed = 0;
    for (const u of users) {
      try { await ctx.telegram.sendMessage(u.user_id, text, { parse_mode: 'HTML' }); sent++; } catch (e) { failed++; }
    }
    return ctx.reply('📢 <b>Рассылка завершена!</b> 🕸️\n\n✅ Отправлено: <b>' + sent + '</b>\n❌ Не удалось: <b>' + failed + '</b>', { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup });
  }
  
  // Админ: удалить
  if (state?.action === 'admin_delete' && isAdmin(ctx)) {
    clearState(userId);
    const targetId = parseInt(text);
    if (!targetId) return ctx.reply('❌ Неверный ID');
    try {
      db.prepare('DELETE FROM users WHERE user_id = ?').run(targetId);
      db.prepare('DELETE FROM search_history WHERE user_id = ?').run(targetId);
      db.prepare('DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?').run(targetId, targetId);
      return ctx.reply('🗑️ Пользователь <b>' + targetId + '</b> удалён', { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup });
    } catch (e) {
      return ctx.reply('❌ Ошибка: ' + e.message);
    }
  }
  
  if (!state) {
    return ctx.reply('🕷️ Используй кнопки ниже 👇', { reply_markup: keyboards.main.reply_markup });
  }
  
  if (state.step === 'waiting_url') {
    let url = text;
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
    if (!isValidUrl(url)) {
      return ctx.reply('❌ <b>Некорректная ссылка</b>\n\nОтправь valid URL:\n<code>https://example.com</code>', { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup });
    }
    
    await ctx.replyWithChatAction('typing');
    const dates = await getArchiveDates(url);
    
    if (dates && dates.length > 0) {
      setState(userId, { step: 'waiting_date_selection', url });
      const buttons = dates.map(d => Markup.button.callback('📅 ' + d.display, 'date_' + d.ts));
      const rows = [];
      for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2));
      }
      rows.push([Markup.button.callback('🕷️ Любая дата', 'date_any'), Markup.button.callback('🕸️ Назад', 'main_menu')]);
      
      return ctx.reply(
        '🕷️ <b>Найдено ' + dates.length + ' архивов для:</b>\n<code>' + escapeHtml(url) + '</code>\n\nВыбери дату:',
        { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(rows).reply_markup }
      );
    } else {
      // Fallback: популярные годы кнопками
      setState(userId, { step: 'waiting_date_selection', url });
      const fallbackYears = ['2024', '2023', '2022', '2021', '2020', '2019', '2018', '2017', '2016', '2015', '2014', '2013', '2012', '2011', '2010'];
      const buttons = fallbackYears.map(y => Markup.button.callback('📅 ' + y, 'date_' + y));
      const rows = [];
      for (let i = 0; i < buttons.length; i += 3) {
        rows.push(buttons.slice(i, i + 3));
      }
      rows.push([Markup.button.callback('🕷️ Любая дата', 'date_any'), Markup.button.callback('🕸️ Назад', 'main_menu')]);
      
      return ctx.reply(
        '🕷️ <b>Выбери год для поиска:</b>\n<code>' + escapeHtml(url) + '</code>\n\n<i>(Не удалось загрузить точные даты, показываю популярные годы)</i>',
        { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard(rows).reply_markup }
      );
    }
  }
  
  // Ручной ввод даты (fallback)
  if (state.step === 'waiting_date_manual') {
    clearState(userId);
    const url = state.url;
    const ts = text.replace(/-/g, '').replace(/\./g, '').substring(0, 8);
    if (!/^\d{4,8}$/.test(ts)) {
      return ctx.reply('❌ <b>Непонятная дата</b>\n\n<code>2020</code>, <code>2020-06</code>, <code>2020-06-15</code>', { parse_mode: 'HTML' });
    }
    const user = getOrCreateUser(ctx);
    if ((user.requests || 0) <= 0 && !user.is_premium) {
      return ctx.reply('❌ <b>Запросы закончились!</b> 🕸️\n\n💎 Купи премиум или пригласи друга!', { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup });
    }
    await ctx.replyWithChatAction('typing');
    const result = await searchArchiveSmart(url, ts);
    if (!user.is_premium) stmts.useRequest.run(userId);
    stmts.addHistory.run(userId, url, text, result.found ? 1 : 0);
    if (result.found) {
      const archiveDate = result.timestamp.substring(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      ctx.reply('🕷️ <b>Архив найден!</b> 🕸️\n\n🔗 <b>Оригинал:</b> <a href="' + url + '">' + escapeHtml(url) + '</a>\n📅 <b>Дата:</b> ' + archiveDate + '\n\n👇 <a href="' + result.url + '">🕷️ Смотреть историческую версию</a>', { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup, disable_web_page_preview: true });
    } else {
      ctx.reply('🕸️ <b>Архив не найден</b> 🕷️\n\n😕 Попробуй другую дату или сайт!', { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup });
    }
    return;
  }
  
  ctx.reply('🕷️ Используй кнопки ниже 👇', { reply_markup: keyboards.main.reply_markup });
});

// ========== АДМИН-ПАНЕЛЬ ==========
bot.action('admin_login', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  setState(ctx.from.id, { action: 'admin_password' });
  ctx.editMessageText('🔐 <b>Админ-панель</b> 🕸️\n\nВведите пароль:', { parse_mode: 'HTML' }).catch(() => {});
});

bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('🕸️ ⛔️ Доступ запрещён 🕷️');
  ctx.reply('🔐 <b>Админ-панель</b> 🕸️\n\nВыбери действие:', { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup });
});

bot.action('admin_stats', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔️').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const stats = stmts.getStats.get();
  ctx.editMessageText('🕸️ <b>Статистика</b> 🕷️\n\n👥 Пользователей: <b>' + (stats.total_users || 0) + '</b>\n💰 Запросов: <b>' + (stats.total_requests || 0) + '</b>', { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup });
});

bot.action('admin_users', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔️').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  const users = stmts.getAllUsers.all();
  if (users.length === 0) return ctx.editMessageText('🕸️ Пользователей пока нет.', { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup });
  let text = '🕸️ <b>Пользователи</b> 🕷️\n\n';
  users.slice(0, 15).forEach((u, i) => {
    text += (i + 1) + '. <b>' + escapeHtml(u.first_name || u.username || 'Unknown') + '</b> (ID: <code>' + u.user_id + '</code>)\n';
    text += '   🕷️ ' + (u.requests || 0) + ' запросов | 👥 ' + (u.referrals || 0) + ' реф | 💎 ' + (u.is_premium ? 'Да' : 'Нет') + '\n';
    text += '   🕐 ' + formatDate(u.created_at) + '\n\n';
  });
  if (users.length > 15) text += '\n... и ещё ' + (users.length - 15);
  ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup });
});

bot.action('admin_testapi', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔️').catch(() => {});
  await ctx.answerCbQuery('🧪 Тестируем...').catch(() => {});
  try {
    const test = await searchArchiveSmart('https://example.com', '20200101');
    ctx.reply('🧪 <b>Тест API</b>\n\n' + (test.found ? '✅ Работает!' : '❌ Не найдено (но API отвечает)'), { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup }).catch(() => {});
  } catch (e) {
    ctx.reply('❌ API не отвечает: ' + e.message, { reply_markup: keyboards.admin.reply_markup }).catch(() => {});
  }
});

bot.action('admin_broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔️').catch(() => {});
  await ctx.answerCbQuery('📢').catch(() => {});
  setState(ctx.from.id, { action: 'admin_broadcast' });
  ctx.editMessageText('📢 <b>Рассылка</b> 🕸️\n\nОтправь текст:', { parse_mode: 'HTML' }).catch(() => {});
});

bot.action('admin_delete', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔️').catch(() => {});
  await ctx.answerCbQuery('🗑️').catch(() => {});
  setState(ctx.from.id, { action: 'admin_delete' });
  ctx.editMessageText('🗑️ <b>Удалить пользователя</b> 🕸️\n\nОтправь ID:', { parse_mode: 'HTML' }).catch(() => {});
});

bot.action('admin_give', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('⛔️').catch(() => {});
  await ctx.answerCbQuery('🎁').catch(() => {});
  setState(ctx.from.id, { action: 'admin_give' });
  ctx.editMessageText('🎁 <b>Выдать запросы</b> 🕸️\n\n<code>ID КОЛИЧЕСТВО</code>\nПример: <code>123456789 10</code>', { parse_mode: 'HTML' }).catch(() => {});
});

// ========== ЗАЩИТА ОТ ПАДЕНИЙ ==========
bot.catch((err, ctx) => {
  console.error(`[ERROR] ${ctx.updateType}:`, err.message);
  try { ctx.reply('🕸️ Упс, что-то пошло не так...').catch(() => {}); } catch (e) {}
});

// ========== ЗАПУСК ==========
async function startBot() {
  try {
    console.log('[START] Getting bot info...');
    const me = await bot.telegram.getMe();
    botUsername = me.username;
    console.log('🕷️ Lumi Archive Bot запущен!');
    console.log('🕸️ @' + botUsername);
    console.log('🔐 Админ ID:', ADMIN_ID);
  } catch (e) {
    console.error('❌ [START ERROR]:', e.message);
    console.log('🕷️ Lumi Archive Bot запущен (fallback)!');
  }
}

try {
  bot.launch({ dropPendingUpdates: true });
  startBot();
} catch (e) {
  console.error('❌ [FATAL]:', e.message);
}

process.once('SIGINT', () => { bot.stop('SIGINT'); db.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); db.close(); });
