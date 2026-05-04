require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');

// ========== НАСТРОЙКИ ==========
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: false }
});
const ADMIN_ID = 8660224775;

// Получаем реальное имя бота динамически
let botUsername = process.env.BOT_USERNAME || '';
if (botUsername.startsWith('@')) botUsername = botUsername.slice(1);

// ========== БАЗА ДАННЫХ ==========
const db = new Database('lumi_archive.db');

// Миграция: добавляем недостающие колонки
// Миграция: добавляем недостающие колонки
try { db.exec('ALTER TABLE users ADD COLUMN searches INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN referrals INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN is_premium INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN premium_expires DATETIME'); } catch (e) {}

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
  const timeout = setTimeout(() => controller.abort(), 15000); // 15 секунд

  try {
    const cleanUrl = url.replace(/^https?:\/\//, '');
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(cleanUrl)}&timestamp=${timestamp}`;
    
    console.log(`[SEARCH] URL: ${cleanUrl}, timestamp: ${timestamp}`);
    
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (LumiArchive/2.0)' }
    });
    clearTimeout(timeout);
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    console.log(`[SEARCH] Response:`, JSON.stringify(data).substring(0, 200));
    
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
    console.error(`[SEARCH ERROR] ${error.name}: ${error.message}`);
    if (error.name === 'AbortError') return { found: false, error: 'timeout' };
    return { found: false, error: error.message };
  }
}

// ========== CRYPTOBOT API ==========
const CRYPTO_BOT_API = process.env.CRYPTO_BOT_TOKEN || '';

async function createCryptoInvoice(amount, description) {
  if (!CRYPTO_BOT_API) return null;
  try {
    const res = await fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Crypto-Pay-API-Token': CRYPTO_BOT_API
      },
      body: JSON.stringify({
        asset: 'USDT',
        amount: amount.toString(),
        description,
        hidden_message: 'Спасибо за покупку премиума!',
        payload: `premium_${Date.now()}`,
        paid_btn_name: 'openBot',
        paid_btn_url: `https://t.me/${botUsername}`
      })
    });
    const data = await res.json();
    return data.ok ? data.result : null;
  } catch (e) {
    console.error('CryptoBot error:', e);
    return null;
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
  const tgLink = `tg://resolve?domain=${botUsername}&start=ref_${userId}`;
  
  ctx.editMessageText(
    '👥 <b>Реферальная программа</b> 🕸️\n\n' +
    `🕷️ Приглашено: <b>${refCount}</b> чел.\n` +
    `🕸️ Бонус: <b>+5 запросов</b> за друга\n\n` +
    '💡 <b>Как пригласить:</b>\n' +
    '1. Нажми кнопку "Поделиться" ниже\n' +
    '2. Или скопируй ссылку и отправь другу\n' +
    '3. Когда он запустит бота — получишь бонус!',
    { 
      parse_mode: 'HTML',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.url('📤 Поделиться ссылкой', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🕷️ Нашёл крутого бота для поиска старых версий сайтов! Попробуй — 3 бесплатных запроса при регистрации!')}`)],
        [Markup.button.callback('🕸️ Главное меню', 'main_menu')]
      ]).reply_markup
    }
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

// Оплата через CryptoBot
bot.action('pay_week', async (ctx) => {
  const invoice = await createCryptoInvoice(2, 'Lumi Archive — Премиум на неделю');
  if (invoice) {
    ctx.editMessageText(
      '💎 <b>Неделя — 2 USDT</b> 🕷️\n\n' +
      'Нажми кнопку ниже для оплаты через CryptoBot:\n\n' +
      '🕸️ После оплаты премиум активируется автоматически',
      { 
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.url('💳 Оплатить 2 USDT', invoice.pay_url)],
          [Markup.button.callback('🕸️ Назад', 'main_menu')]
        ]).reply_markup
      }
    );
  } else {
    ctx.editMessageText(
      '💎 <b>Неделя — 2 USDT</b> 🕷️\n\n' +
      'Для оплаты напиши администратору:\n' +
      '🕸️ @lumi_support',
      { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
    );
  }
});
  
bot.action('pay_month', async (ctx) => {
  const invoice = await createCryptoInvoice(5, 'Lumi Archive — Премиум на месяц');
  if (invoice) {
    ctx.editMessageText(
      '💎 <b>Месяц — 5 USDT</b> 🕷️\n\n' +
      'Нажми кнопку ниже для оплаты через CryptoBot:\n\n' +
      '🕸️ После оплаты премиум активируется автоматически',
      { 
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.url('💳 Оплатить 5 USDT', invoice.pay_url)],
          [Markup.button.callback('🕸️ Назад', 'main_menu')]
        ]).reply_markup
      }
    );
  } else {
    ctx.editMessageText(
      '💎 <b>Месяц — 5 USDT</b> 🕷️\n\n' +
      'Для оплаты напиши администратору:\n' +
      '🕷️ @lumi_support',
      { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
    );
  }
});

bot.action('pay_year', async (ctx) => {
  const invoice = await createCryptoInvoice(15, 'Lumi Archive — Премиум на год');
  if (invoice) {
    ctx.editMessageText(
      '💎 <b>Год — 15 USDT</b> 🕷️\n\n' +
      'Нажми кнопку ниже для оплаты через CryptoBot:\n\n' +
      '🕸️ После оплаты премиум активируется автоматически',
      { 
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.url('💳 Оплатить 15 USDT', invoice.pay_url)],
          [Markup.button.callback('🕸️ Назад', 'main_menu')]
        ]).reply_markup
      }
    );
  } else {
    ctx.editMessageText(
      '💎 <b>Год — 15 USDT</b> 🕷️\n\n' +
      'Для оплаты напиши администратору:\n' +
      '🕸️ @lumi_support',
      { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
    );
  }
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
async function startBot() {
  try {
    const me = await bot.telegram.getMe();
    botUsername = me.username;
    console.log('🕷️ Lumi Archive Bot запущен!');
    console.log('🕸️ @' + botUsername);
    console.log('🔐 Админ ID:', ADMIN_ID);
  } catch (e) {
    console.error('❌ Не удалось получить info бота:', e.message);
    console.log('🕷️ Lumi Archive Bot запущен!');
    console.log('🕸️ @' + botUsername);
  }
}

bot.launch({ dropPendingUpdates: true });
startBot();

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
