require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');

// ========== НАСТРОЙКИ ==========
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: false }
});
const botUsername = process.env.BOT_USERNAME || 'lumi_archive';
const ADMIN_ID = 8660224775;

// ========== БАЗА ДАННЫХ ==========
const db = new Database('lumi_archive.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    requests INTEGER DEFAULT 3,
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
  addSearch: db.prepare('UPDATE users SET searches = searches + 1 WHERE user_id = ?'),
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

function parseUserDate(input) {
  const patterns = [
    { regex: /^(\d{4})-(\d{2})-(\d{2})$/, fmt: (m) => ({ ts: `${m[1]}${m[2]}${m[3]}`, display: `${m[1]}-${m[2]}-${m[3]}` }) },
    { regex: /^(\d{4})-(\d{2})$/, fmt: (m) => ({ ts: `${m[1]}${m[2]}01`, display: `${m[1]}-${m[2]}` }) },
    { regex: /^(\d{4})$/, fmt: (m) => ({ ts: `${m[1]}0101`, display: m[1] }) },
    { regex: /^(\d{2})\.(\d{2})\.(\d{4})$/, fmt: (m) => ({ ts: `${m[3]}${m[2]}${m[1]}`, display: `${m[1]}.${m[2]}.${m[3]}` }) },
    { regex: /^(\d{2})\/(\d{2})\/(\d{4})$/, fmt: (m) => ({ ts: `${m[3]}${m[2]}${m[1]}`, display: `${m[1]}/${m[2]}/${m[3]}` }) }
  ];
  for (const p of patterns) {
    const match = input.match(p.regex);
    if (match) return { valid: true, ...p.fmt(match) };
  }
  return { valid: false };
}

// ========== ПОИСК В АРХИВЕ (собственная база) ==========
async function searchArchive(url, timestamp) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const cleanUrl = url.replace(/^https?:\/\//, '');
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(cleanUrl)}&timestamp=${timestamp}`;
    
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (LumiArchive/2.0)' }
    });
    clearTimeout(timeout);
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    
    if (data.archived_snapshots?.closest?.available) {
      const snap = data.archived_snapshots.closest;
      return {
        found: true,
        url: snap.url.replace('http://', 'https://'),
        timestamp: snap.timestamp,
        status: snap.status
      };
    }
    return { found: false };
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') return { found: false, error: 'timeout' };
    return { found: false, error: error.message };
  }
}

// ========== КЛАВИАТУРЫ ==========
const keyboards = {
  main: Markup.inlineKeyboard([
    [Markup.button.callback('🕷️ Найти в архиве', 'search_archive')],
    [Markup.button.callback('🕸️ История', 'history'), Markup.button.callback('💰 Баланс', 'balance')],
    [Markup.button.callback('👥 Рефералка', 'referral'), Markup.button.callback('💎 Премиум', 'premium')],
    [Markup.button.callback('🕷️ Как это работает', 'help')]
  ]),

  back: Markup.inlineKeyboard([
    [Markup.button.callback('🕸️ Главное меню', 'main_menu')]
  ]),

  premium: Markup.inlineKeyboard([
    [Markup.button.callback('💎 Неделя — 2 USDT', 'pay_week')],
    [Markup.button.callback('💎 Месяц — 5 USDT', 'pay_month')],
    [Markup.button.callback('💎 Год — 15 USDT', 'pay_year')],
    [Markup.button.callback('🕸️ Назад', 'main_menu')]
  ]),

  admin: Markup.inlineKeyboard([
    [Markup.button.callback('📊 Статистика', 'admin_stats')],
    [Markup.button.callback('👥 Пользователи', 'admin_users')],
    [Markup.button.callback('🎁 Выдать запросы', 'admin_give')],
    [Markup.button.callback('🕸️ Назад', 'main_menu')]
  ])
};

// ========== ОБРАБОТЧИКИ ==========

bot.start((ctx) => {
  const userId = ctx.from.id;
  const payload = ctx.startPayload;
  
  // Реферальная система
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
          
          ctx.reply(
            '🕷️ <b>Ты пришёл по реферальной ссылке!</b> 🕸️\n\n' +
            '✅ Тебе начислено <b>3 бесплатных запроса</b>\n' +
            '✅ Твой друг получил <b>+5 запросов</b>',
            { parse_mode: 'HTML' }
          );
          
          ctx.telegram.sendMessage(
            referrerId,
            `🕸️ <b>Новый реферал!</b> 🕷️\n\n` +
            `Пользователь <b>${escapeHtml(ctx.from.first_name)}</b> присоединился!\n` +
            `🔹 +5 запросов начислено`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }
    }
  }
  
  getOrCreateUser(ctx);
  
  ctx.reply(
    '🕷️ <b>Lumi Archive</b> 🕸️\n\n' +
    '<i>Путешествие во времени по интернету</i>\n\n' +
    '🕸️ <b>Что я умею:</b>\n' +
    '• Находить старые версии любых сайтов\n' +
    '• Показывать, как страница выглядела в прошлом\n' +
    '• Работать с нашей базой архивов\n\n' +
    '<b>Пример:</b>\n' +
    'Отправь ссылку и дату — я найду историческую версию!\n\n' +
    '🕷️ Выбери действие:',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

bot.action('main_menu', (ctx) => {
  const user = getOrCreateUser(ctx);
  ctx.editMessageText(
    '🕷️ <b>Lumi Archive</b> 🕸️\n\n' +
    '<i>Путешествие во времени по интернету</i>\n\n' +
    `🕸️ Запросов: <b>${user.requests}</b>\n` +
    `🕷️ Рефералов: <b>${user.referrals || 0}</b>\n\n` +
    'Выбери действие:',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

bot.action('search_archive', (ctx) => {
  setState(ctx.from.id, { step: 'waiting_url' });
  ctx.editMessageText(
    '🕷️ <b>Поиск в архиве</b> 🕸️\n\n' +
    'Отправь ссылку на сайт:\n\n' +
    '<code>https://example.com</code>\n\n' +
    '<i>Или просто скопируй URL из браузера</i>',
    { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
  );
});

bot.action('history', (ctx) => {
  const history = stmts.getHistory.all(ctx.from.id);
  
  if (history.length === 0) {
    return ctx.editMessageText(
      '🕸️ <b>История поиска</b>\n\n' +
      'Пока пусто... Сделай первый поиск!',
      { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
    );
  }
  
  let text = '🕸️ <b>История поиска</b> 🕷️\n\n';
  history.forEach((item, i) => {
    const icon = item.found ? '✅' : '❌';
    text += `${icon} <a href="${item.url}">${escapeHtml(item.url.substring(0, 35))}${item.url.length > 35 ? '...' : ''}</a>\n`;
    text += `   📅 ${item.date} | 🕐 ${formatDate(item.searched_at)}\n\n`;
  });
  
  ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup });
});

bot.action('balance', (ctx) => {
  const user = getOrCreateUser(ctx);
  const refCount = stmts.getReferralCount.get(user.id)?.count || 0;
  
  ctx.editMessageText(
    '💰 <b>Мой баланс</b> 🕸️\n\n' +
    `🕷️ Запросов: <b>${user.requests}</b>\n` +
    `🕸️ Рефералов: <b>${refCount}</b>\n` +
    `💎 Премиум: <b>${user.is_premium ? 'Активен' : 'Нет'}</b>\n\n` +
    '👥 Пригласи друга и получи <b>+5 запросов</b>!\n' +
    '💎 Купи премиум для безлимита!',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

bot.action('referral', (ctx) => {
  const userId = ctx.from.id;
  const refCount = stmts.getReferralCount.get(userId)?.count || 0;
  const link = `https://t.me/${botUsername}?start=ref_${userId}`;
  
  ctx.editMessageText(
    '👥 <b>Реферальная программа</b> 🕸️\n\n' +
    `🔗 Твоя ссылка:\n<code>${link}</code>\n\n` +
    `🕷️ Приглашено: <b>${refCount}</b> чел.\n` +
    `🕸️ Бонус: <b>+5 запросов</b> за друга\n\n` +
    '💡 <b>Как пригласить:</b>\n' +
    '1. Скопируй ссылку выше\n' +
    '2. Отправь другу\n' +
    '3. Когда он запустит бота — получишь бонус!',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

bot.action('premium', (ctx) => {
  ctx.editMessageText(
    '💎 <b>Премиум доступ</b> 🕸️\n\n' +
    '🕷️ <b>Что даёт премиум:</b>\n' +
    '• Безлимитный поиск\n' +
    '• Приоритетная скорость\n' +
    '• Доступ к редким архивам\n' +
    '• Поддержка 24/7\n\n' +
    '💎 <b>Тарифы (USDT):</b>\n\n' +
    '🕷️ Неделя — <b>2 USDT</b>\n' +
    '🕸️ Месяц — <b>5 USDT</b>\n' +
    '🕷️ Год — <b>15 USDT</b>\n\n' +
    '💳 Оплата через @CryptoBot',
    { parse_mode: 'HTML', reply_markup: keyboards.premium.reply_markup }
  );
});

bot.action('help', (ctx) => {
  ctx.editMessageText(
    '🕷️ <b>Как это работает</b> 🕸️\n\n' +
    'Наша система хранит миллиарды снимков веб-страниц с 1996 года.\n\n' +
    '<b>Как искать:</b>\n' +
    '1. Нажми "🕷️ Найти в архиве"\n' +
    '2. Отправь ссылку на сайт\n' +
    '3. Отправь дату (год, месяц или день)\n' +
    '4. Получи ссылку на историческую версию!\n\n' +
    '<b>Форматы даты:</b>\n' +
    '• <code>2020</code> — любой день 2020 года\n' +
    '• <code>2020-06</code> — июнь 2020\n' +
    '• <code>2020-06-15</code> — конкретный день\n' +
    '• <code>15.06.2020</code> — тоже работает\n\n' +
    '<b>Идеи для поиска:</b>\n' +
    '• Как выглядел VK в 2010?\n' +
    '• Какой был YouTube в 2007?\n' +
    '• Что было на сайте до редизайна?\n\n' +
    '🕸️ Нажми "Назад" чтобы начать!',
    { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
  );
});

// Оплата
bot.action('pay_week', (ctx) => {
  ctx.editMessageText(
    '💎 <b>Неделя — 2 USDT</b> 🕷️\n\n' +
    'Для оплаты через @CryptoBot:\n\n' +
    '1. Открой @CryptoBot\n' +
    '2. Отправь 2 USDT на адрес админа\n' +
    '3. Пришли скриншот сюда\n\n' +
    '🕸️ Или напиши: @lumi_support',
    { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
  );
});

bot.action('pay_month', (ctx) => {
  ctx.editMessageText(
    '💎 <b>Месяц — 5 USDT</b> 🕸️\n\n' +
    'Для оплаты через @CryptoBot:\n\n' +
    '1. Открой @CryptoBot\n' +
    '2. Отправь 5 USDT на адрес админа\n' +
    '3. Пришли скриншот сюда\n\n' +
    '🕷️ Или напиши: @lumi_support',
    { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
  );
});

bot.action('pay_year', (ctx) => {
  ctx.editMessageText(
    '💎 <b>Год — 15 USDT</b> 🕷️\n\n' +
    'Для оплаты через @CryptoBot:\n\n' +
    '1. Открой @CryptoBot\n' +
    '2. Отправь 15 USDT на адрес админа\n' +
    '3. Пришли скриншот сюда\n\n' +
    '🕸️ Или напиши: @lumi_support',
    { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
  );
});

// Обработка текста
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const text = ctx.text.trim();
  
  // Админ: выдать запросы
  if (state?.action === 'admin_give' && isAdmin(ctx)) {
    clearState(userId);
    const parts = text.split(/\s+/);
    if (parts.length !== 2) {
      return ctx.reply('❌ Формат: <code>ID КОЛИЧЕСТВО</code>', { parse_mode: 'HTML' });
    }
    const targetId = parseInt(parts[0]);
    const amount = parseInt(parts[1]);
    if (!targetId || !amount) return ctx.reply('❌ Неверные числа');
    
    const target = stmts.getUser.get(targetId);
    if (!target) return ctx.reply('❌ Пользователь не найден');
    
    stmts.addRequests.run(amount, targetId);
    ctx.reply(`✅ Выдано <b>${amount}</b> запросов`, { parse_mode: 'HTML' });
    ctx.telegram.sendMessage(targetId, `🕸️ <b>Бонус!</b>\n\nТебе начислено <b>${amount}</b> запросов!`, { parse_mode: 'HTML' }).catch(() => {});
    return;
  }
  
  if (!state) {
    return ctx.reply('🕷️ Используй кнопки ниже 👇', { reply_markup: keyboards.main.reply_markup });
  }
  
  if (state.step === 'waiting_url') {
    let url = text;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    
    if (!isValidUrl(url)) {
      return ctx.reply(
        '❌ <b>Некорректная ссылка</b>\n\n' +
        'Отправь valid URL:\n<code>https://example.com</code>',
        { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
      );
    }
    
    setState(userId, { step: 'waiting_date', url });
    
    return ctx.reply(
      '🕷️ <b>Ссылка принята!</b> 🕸️\n\n' +
      '📅 <b>Какую дату ищем?</b>\n\n' +
      'Отправь дату в любом формате:\n\n' +
      '<code>2020</code> — любой день 2020\n' +
      '<code>2020-06</code> — июнь 2020\n' +
      '<code>2020-06-15</code> — конкретный день\n' +
      '<code>15.06.2020</code> — тоже ок',
      { parse_mode: 'HTML' }
    );
  }
  
  if (state.step === 'waiting_date') {
    clearState(userId);
    
    const parsed = parseUserDate(text);
    if (!parsed.valid) {
      return ctx.reply(
        '❌ <b>Непонятная дата</b>\n\n' +
        'Используй формат:\n' +
        '<code>2020</code>, <code>2020-06</code>, <code>15.06.2020</code>\n\n' +
        'Попробуй ещё раз:',
        { parse_mode: 'HTML' }
      );
    }
    
    const url = state.url;
    const user = getOrCreateUser(ctx);
    
    if (user.requests <= 0 && !user.is_premium) {
      return ctx.reply(
        '❌ <b>Запросы закончились!</b> 🕸️\n\n' +
        '💎 Купи премиум или пригласи друга:\n' +
        '🕷️ Неделя — 2 USDT\n' +
        '🕸️ Месяц — 5 USDT\n' +
        '🕷️ Год — 15 USDT\n\n' +
        '👥 Рефералка: +5 запросов за друга',
        { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
      );
    }
    
    await ctx.replyWithChatAction('typing');
    
    const result = await searchArchive(url, parsed.ts);
    
    if (!user.is_premium) {
      stmts.useRequest.run(userId);
    }
    stmts.addHistory.run(userId, url, parsed.display, result.found ? 1 : 0);
    
    if (result.found) {
      const archiveDate = result.timestamp.substring(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      
      ctx.reply(
        '🕷️ <b>Архив найден!</b> 🕸️\n\n' +
        `🔗 <b>Оригинал:</b> <a href="${url}">${escapeHtml(url)}</a>\n` +
        `📅 <b>Дата архива:</b> ${archiveDate}\n` +
        `🕸️ <b>Статус:</b> ${result.status === '200' ? '✅ Сохранён' : '⚠️ ' + result.status}\n\n` +
        `👇 <b>Открыть архив:</b>\n` +
        `<a href="${result.url}">🕷️ Смотреть историческую версию</a>\n\n` +
        '<i>Нажми на ссылку выше!</i>',
        { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup, disable_web_page_preview: true }
      );
    } else {
      const reason = result.error === 'timeout' 
        ? '⏱️ Запрос занял слишком много времени. Попробуй ещё раз или выбери другую дату.'
        : '😕 Страница не найдена в нашем архиве.\n\n' +
          'Возможно:\n' +
          '• Сайт никогда не архивировался\n' +
          '• Дата слишком ранняя\n' +
          '• Сайт заблокирован от сохранения';
      
      ctx.reply(
        '🕸️ <b>Архив не найден</b> 🕷️\n\n' +
        `🔗 Ссылка: <a href="${url}">${escapeHtml(url)}</a>\n` +
        `📅 Дата: ${parsed.display}\n\n` +
        reason + '\n\n' +
        '💡 Попробуй другую дату или сайт!',
        { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
      );
    }
    return;
  }
  
  ctx.reply('🕷️ Используй кнопки ниже 👇', { reply_markup: keyboards.main.reply_markup });
});

// ========== АДМИН-ПАНЕЛЬ ==========
bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('🕸️ ⛔️ Доступ запрещён 🕷️');
  }
  
  ctx.reply(
    '🔐 <b>Админ-панель</b> 🕸️\n\n' +
    'Выбери действие:',
    { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup }
  );
});

bot.action('admin_stats', (ctx) => {
  if (!isAdmin(ctx)) return;
  const stats = stmts.getStats.get();
  ctx.editMessageText(
    '🕸️ <b>Статистика</b> 🕷️\n\n' +
    `👥 Пользователей: <b>${stats.total_users || 0}</b>\n` +
    `💰 Запросов в системе: <b>${stats.total_requests || 0}</b>`,
    { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup }
  );
});

bot.action('admin_users', (ctx) => {
  if (!isAdmin(ctx)) return;
  const users = stmts.getAllUsers.all();
  
  if (users.length === 0) {
    return ctx.editMessageText('🕸️ Пользователей пока нет.', { reply_markup: keyboards.admin.reply_markup });
  }
  
  let text = '🕸️ <b>Пользователи</b> 🕷️\n\n';
  users.slice(0, 15).forEach((u, i) => {
    const name = escapeHtml(u.first_name || u.username || 'Unknown');
    text += `${i + 1}. <b>${name}</b> (ID: <code>${u.user_id}</code>)\n`;
    text += `   🕷️ ${u.requests} запросов | 👥 ${u.referrals} реф | 💎 ${u.is_premium ? 'Да' : 'Нет'}\n`;
    text += `   🕐 ${formatDate(u.created_at)}\n\n`;
  });
  
  if (users.length > 15) text += `\n... и ещё ${users.length - 15}`;
  
  ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup });
});

bot.action('admin_give', (ctx) => {
  if (!isAdmin(ctx)) return;
  setState(ctx.from.id, { action: 'admin_give' });
  ctx.editMessageText(
    '🎁 <b>Выдать запросы</b> 🕸️\n\n' +
    'Отправь:\n<code>ID_ПОЛЬЗОВАТЕЛЯ КОЛИЧЕСТВО</code>\n\n' +
    'Пример: <code>123456789 10</code>',
    { parse_mode: 'HTML' }
  );
});

// ========== ЗАПУСК ==========
bot.launch({ dropPendingUpdates: true });
console.log('🕷️ Lumi Archive Bot запущен!');
console.log('🕸️ @' + botUsername);
console.log('🔐 Админ ID:', ADMIN_ID);

process.once('SIGINT', () => {
  bot.stop('SIGINT');
  db.close();
  console.log('✅ Бот остановлен');
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  db.close();
  console.log('✅ Бот остановлен');
});
