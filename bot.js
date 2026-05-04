require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

// ========== НАСТРОЙКИ ==========
const bot = new Telegraf(process.env.BOT_TOKEN, {
  telegram: { webhookReply: false } // Отключаем webhook для polling
});
const botUsername = process.env.BOT_USERNAME || 'lumi_archive';
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;

// ========== БАЗА ДАННЫХ ==========
const Database = require('better-sqlite3');
const db = new Database('lumi_archive.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    searches INTEGER DEFAULT 0,
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
`);

// ========== STATEMENTS ==========
const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
  createUser: db.prepare('INSERT OR IGNORE INTO users (user_id, username, first_name, searches) VALUES (?, ?, ?, ?)'),
  updateUser: db.prepare('UPDATE users SET username = ?, first_name = ?, searches = searches + 1 WHERE user_id = ?'),
  addHistory: db.prepare('INSERT INTO search_history (user_id, url, date, found) VALUES (?, ?, ?, ?)'),
  getHistory: db.prepare('SELECT * FROM search_history WHERE user_id = ? ORDER BY searched_at DESC LIMIT 10'),
  getStats: db.prepare('SELECT COUNT(*) as total_users, SUM(searches) as total_searches FROM users')
};

// ========== СОСТОЯНИЯ ПОЛЬЗОВАТЕЛЕЙ ==========
const userStates = new Map();

function setState(userId, state) {
  userStates.set(userId, state);
}

function getState(userId) {
  return userStates.get(userId);
}

function clearState(userId) {
  userStates.delete(userId);
}

// ========== УТИЛИТЫ ==========
function getOrCreateUser(ctx) {
  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || 'Пользователь';
  
  stmts.createUser.run(userId, username, firstName, 0);
  stmts.updateUser.run(username, firstName, userId);
  
  return stmts.getUser.get(userId);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function parseUserDate(input) {
  // Парсим дату из разных форматов: 2020, 2020-01, 2020-01-01, 01.01.2020, 01/01/2020
  const patterns = [
    /^(\d{4})-(\d{2})-(\d{2})$/,  // 2020-01-15
    /^(\d{4})-(\d{2})$/,          // 2020-01
    /^(\d{4})$/,                  // 2020
    /^(\d{2})\.(\d{2})\.(\d{4})$/, // 15.01.2020
    /^(\d{2})\/(\d{2})\/(\d{4})$/  // 15/01/2020
  ];
  
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) {
      if (pattern === patterns[0]) {
        return { valid: true, timestamp: `${match[1]}${match[2]}${match[3]}`, display: input };
      } else if (pattern === patterns[1]) {
        return { valid: true, timestamp: `${match[1]}${match[2]}01`, display: input };
      } else if (pattern === patterns[2]) {
        return { valid: true, timestamp: `${match[1]}0101`, display: input };
      } else if (pattern === patterns[3] || pattern === patterns[4]) {
        return { valid: true, timestamp: `${match[3]}${match[2]}${match[1]}`, display: input };
      }
    }
  }
  return { valid: false };
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

// ========== КЛАВИАТУРЫ ==========
const keyboards = {
  main: Markup.inlineKeyboard([
    [Markup.button.callback('🔍 Найти в архиве', 'search_archive')],
    [Markup.button.callback('📜 История поиска', 'history'), Markup.button.callback('👤 Профиль', 'profile')],
    [Markup.button.callback('ℹ️ Как это работает', 'help')]
  ]),

  back: Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Главное меню', 'main_menu')]
  ]),

  search: Markup.inlineKeyboard([
    [Markup.button.callback('📅 Сегодня', 'date_today')],
    [Markup.button.callback('📅 Год назад', 'date_year_ago')]
  ])
};

// ========== WAYBACK MACHINE API ==========
async function searchArchive(url, timestamp) {
  try {
    // Очищаем URL от протокола
    const cleanUrl = url.replace(/^https?:\/\//, '');
    
    // API Wayback Machine
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(cleanUrl)}&timestamp=${timestamp}`;
    
    const response = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.archived_snapshots && data.archived_snapshots.closest && data.archived_snapshots.closest.available) {
      const snapshot = data.archived_snapshots.closest;
      return {
        found: true,
        url: snapshot.url.replace('http://', 'https://'),
        timestamp: snapshot.timestamp,
        status: snapshot.status
      };
    }
    
    return { found: false };
  } catch (error) {
    console.error('Archive API error:', error.message);
    return { found: false, error: error.message };
  }
}

// ========== ОБРАБОТЧИКИ ==========

// /start
bot.start((ctx) => {
  getOrCreateUser(ctx);
  
  ctx.reply(
    '🕰️ <b>Lumi Archive</b>\n\n' +
    '<i>Машина времени для интернета</i>\n\n' +
    '🔍 <b>Что я умею:</b>\n' +
    '• Находить старые версии сайтов\n' +
    '• Показывать, как страница выглядела раньше\n' +
    '• Работать с Wayback Machine\n\n' +
    '<b>Пример:</b>\n' +
    'Введи ссылку и дату — я найду, как сайт выглядел в тот день!\n\n' +
    '👇 Выбери действие:',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

// Главное меню
bot.action('main_menu', (ctx) => {
  const user = getOrCreateUser(ctx);
  
  ctx.editMessageText(
    '🕰️ <b>Lumi Archive</b>\n\n' +
    '<i>Машина времени для интернета</i>\n\n' +
    `🔹 Поисков: <b>${user.searches}</b>\n\n` +
    'Выбери действие:',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

// Поиск в архиве
bot.action('search_archive', (ctx) => {
  const userId = ctx.from.id;
  setState(userId, { step: 'waiting_url' });
  
  ctx.editMessageText(
    '🔍 <b>Поиск в архиве</b>\n\n' +
    'Отправь мне ссылку на сайт:\n\n' +
    '<code>https://example.com</code>\n\n' +
    '<i>Или просто скопируй URL из браузера</i>',
    { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
  );
});

// История
bot.action('history', (ctx) => {
  const userId = ctx.from.id;
  const history = stmts.getHistory.all(userId);
  
  if (history.length === 0) {
    return ctx.editMessageText(
      '📜 <b>История поиска</b>\n\n' +
      'Пока пусто... Сделай первый поиск!',
      { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
    );
  }
  
  let text = '📜 <b>История поиска</b>\n\n';
  history.forEach((item, i) => {
    const icon = item.found ? '✅' : '❌';
    const date = formatDate(item.searched_at);
    text += `${icon} <a href="${item.url}">${escapeHtml(item.url.substring(0, 40))}${item.url.length > 40 ? '...' : ''}</a>\n`;
    text += `   📅 Дата: ${item.date} | Найден: ${item.found ? 'Да' : 'Нет'}\n`;
    text += `   🕐 ${date}\n\n`;
  });
  
  ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup });
});

// Профиль
bot.action('profile', (ctx) => {
  const user = getOrCreateUser(ctx);
  const history = stmts.getHistory.all(user.id);
  const foundCount = history.filter(h => h.found).length;
  
  ctx.editMessageText(
    '👤 <b>Твой профиль</b>\n\n' +
    `🔹 Поисков всего: <b>${user.searches}</b>\n` +
    `🔹 Найдено архивов: <b>${foundCount}</b>\n` +
    `🔹 В базе с: <b>${formatDate(user.created_at)}</b>\n\n` +
    '🎯 Используй бота чаще — помогаю находить утраченный контент!',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

// Помощь
bot.action('help', (ctx) => {
  ctx.editMessageText(
    'ℹ️ <b>Как это работает</b>\n\n' +
    '🕰️ <b>Lumi Archive</b> использует <b>Wayback Machine</b> — largest archive of web pages.\n\n' +
    '<b>Как искать:</b>\n' +
    '1. Нажми "🔍 Найти в архиве"\n' +
    '2. Отправь ссылку на сайт\n' +
    '3. Отправь дату (год, месяц или день)\n' +
    '4. Получи ссылку на архивную версию!\n\n' +
    '<b>Форматы даты:</b>\n' +
    '• <code>2020</code> — любой день 2020 года\n' +
    '• <code>2020-06</code> — июнь 2020\n' +
    '• <code>2020-06-15</code> — конкретный день\n' +
    '• <code>15.06.2020</code> — тоже работает\n\n' +
    '<b>Примеры:</b>\n' +
    '• Как выглядел VK в 2010?\n' +
    '• Какой был YouTube в 2007?\n' +
    '• Что было на сайте до редизайна?\n\n' +
    '🔙 Нажми "Назад" чтобы начать!',
    { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup }
  );
});

// Обработка текста
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = getState(userId);
  const text = ctx.text.trim();
  
  // Если нет состояния — показываем меню
  if (!state) {
    return ctx.reply(
      'Используй кнопки ниже 👇',
      { reply_markup: keyboards.main.reply_markup }
    );
  }
  
  // Шаг 1: Ожидание URL
  if (state.step === 'waiting_url') {
    // Проверка URL
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
    
    setState(userId, { step: 'waiting_date', url: url });
    
    return ctx.reply(
      '📅 <b>Какую дату ищем?</b>\n\n' +
      'Отправь дату в любом формате:\n\n' +
      '<code>2020</code> — любой день 2020\n' +
      '<code>2020-06</code> — июнь 2020\n' +
      '<code>2020-06-15</code> — конкретный день\n' +
      '<code>15.06.2020</code> — тоже ок\n\n' +
      'Или выбери быстро:',
      { parse_mode: 'HTML', reply_markup: keyboards.search.reply_markup }
    );
  }
  
  // Шаг 2: Ожидание даты
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
    
    // Отправляем "печатает..."
    await ctx.replyWithChatAction('typing');
    
    // Поиск в архиве
    const result = await searchArchive(url, parsed.timestamp);
    
    // Сохраняем в историю
    stmts.addHistory.run(userId, url, parsed.display, result.found ? 1 : 0);
    
    if (result.found) {
      const archiveDate = result.timestamp.substring(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      
      ctx.reply(
        '✅ <b>Архив найден!</b>\n\n' +
        `🔗 <b>Оригинал:</b> <a href="${url}">${escapeHtml(url)}</a>\n` +
        `📅 <b>Дата архива:</b> ${archiveDate}\n` +
        `🕰️ <b>Статус:</b> ${result.status === '200' ? '✅ OK' : '⚠️ ' + result.status}\n\n` +
        `👇 <b>Смотри архив:</b>\n` +
        `<a href="${result.url}">Открыть в Wayback Machine</a>\n\n` +
        '<i>Нажми на ссылку выше!</i>',
        { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup, disable_web_page_preview: true }
      );
    } else {
      ctx.reply(
        '❌ <b>Архив не найден</b>\n\n' +
        `🔗 Ссылка: <a href="${url}">${escapeHtml(url)}</a>\n` +
        `📅 Дата: ${parsed.display}\n\n` +
        '😕 Возможно:\n' +
        '• Страница никогда не архивировалась\n' +
        '• Дата слишком ранняя (сайт не существовал)\n' +
        '• Сайт заблокирован от архивации\n\n' +
        '💡 Попробуй другую дату или сайт!',
        { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
      );
    }
    
    return;
  }
  
  // По умолчанию — меню
  ctx.reply('Используй кнопки ниже 👇', {
    reply_markup: keyboards.main.reply_markup
  });
});

// Быстрые даты
bot.action('date_today', (ctx) => {
  const userId = ctx.from.id;
  const state = getState(userId);
  
  if (!state || state.step !== 'waiting_date') {
    return ctx.answerCbQuery('Сначала отправь ссылку!');
  }
  
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  
  setState(userId, { step: 'waiting_date', url: state.url });
  ctx.editMessageText(
    `📅 Ищем архив на <b>${dateStr}</b>...\n\n<i>Подожди секунду...</i>`,
    { parse_mode: 'HTML' }
  );
  
  // Эмулируем ввод даты
  ctx.telegram.sendMessage(userId, dateStr);
});

bot.action('date_year_ago', (ctx) => {
  const userId = ctx.from.id;
  const state = getState(userId);
  
  if (!state || state.step !== 'waiting_date') {
    return ctx.answerCbQuery('Сначала отправь ссылку!');
  }
  
  const yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const dateStr = yearAgo.toISOString().split('T')[0];
  
  setState(userId, { step: 'waiting_date', url: state.url });
  ctx.editMessageText(
    `📅 Ищем архив на <b>${dateStr}</b> (год назад)...\n\n<i>Подожди секунду...</i>`,
    { parse_mode: 'HTML' }
  );
  
  ctx.telegram.sendMessage(userId, dateStr);
});

// ========== АДМИН-ПАНЕЛЬ ==========
bot.command('admin', (ctx) => {
  if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) {
    return ctx.reply('⛔️ Доступ запрещён');
  }
  
  const stats = stmts.getStats.get();
  
  ctx.reply(
    '🔐 <b>Админ-панель</b>\n\n' +
    `👥 Пользователей: <b>${stats.total_users || 0}</b>\n` +
    `🔍 Поисков всего: <b>${stats.total_searches || 0}</b>`,
    { parse_mode: 'HTML' }
  );
});

// ========== ЗАПУСК ==========
bot.launch({ dropPendingUpdates: true });
console.log('🚀 Lumi Archive Bot запущен!');
console.log('🤖 @' + botUsername);
if (ADMIN_ID) console.log('🔐 Админ ID:', ADMIN_ID);

// Graceful shutdown
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
