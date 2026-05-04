require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ========== НАСТРОЙКИ ==========
const bot = new Telegraf(process.env.BOT_TOKEN);
const botUsername = process.env.BOT_USERNAME || 'lumi_archive';
const ADMIN_ID = process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : null;

// Папка для архивов
const ARCHIVES_DIR = path.join(__dirname, 'archives');
if (!fs.existsSync(ARCHIVES_DIR)) {
  fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
}

// ========== БАЗА ДАННЫХ ==========
const db = new Database('lumi_archive.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    requests INTEGER DEFAULT 2,
    referrals INTEGER DEFAULT 0,
    subscription_type TEXT DEFAULT 'free',
    subscription_expires DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    url TEXT,
    title TEXT,
    file_path TEXT,
    file_size INTEGER,
    saved_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS referrals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id INTEGER,
    referred_id INTEGER UNIQUE,
    rewarded INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ========== STATEMENTS ==========
const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
  createUser: db.prepare('INSERT OR IGNORE INTO users (user_id, username, first_name, requests) VALUES (?, ?, ?, ?)'),
  updateUser: db.prepare('UPDATE users SET username = ?, first_name = ?, last_active = CURRENT_TIMESTAMP WHERE user_id = ?'),
  getArchives: db.prepare('SELECT * FROM archives WHERE user_id = ? ORDER BY saved_at DESC LIMIT 20'),
  addArchive: db.prepare('INSERT INTO archives (user_id, url, title, file_path, file_size) VALUES (?, ?, ?, ?, ?)'),
  addReferral: db.prepare('INSERT OR IGNORE INTO referrals (referrer_id, referred_id) VALUES (?, ?)'),
  rewardReferral: db.prepare('UPDATE referrals SET rewarded = 1 WHERE referrer_id = ? AND referred_id = ?'),
  getReferralCount: db.prepare('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ? AND rewarded = 1'),
  addRequests: db.prepare('UPDATE users SET requests = requests + ? WHERE user_id = ?'),
  useRequest: db.prepare('UPDATE users SET requests = requests - 1 WHERE user_id = ?'),
  getStats: db.prepare('SELECT COUNT(*) as total_users, SUM(requests) as total_requests FROM users'),
  getTotalArchives: db.prepare('SELECT COUNT(*) as count FROM archives'),
  getTodayArchives: db.prepare("SELECT COUNT(*) as count FROM archives WHERE DATE(saved_at) = DATE('now')"),
  getAllUsers: db.prepare('SELECT user_id, username, first_name, requests, subscription_type, created_at FROM users ORDER BY created_at DESC'),
  updateSubscription: db.prepare('UPDATE users SET subscription_type = ?, subscription_expires = ?, requests = requests + ? WHERE user_id = ?')
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
  
  stmts.createUser.run(userId, username, firstName, 2);
  stmts.updateUser.run(username, firstName, userId);
  
  return stmts.getUser.get(userId);
}

function isAdmin(ctx) {
  return ADMIN_ID && ctx.from.id === ADMIN_ID;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ========== КЛАВИАТУРЫ ==========
const keyboards = {
  main: Markup.inlineKeyboard([
    [Markup.button.callback('💾 Сохранить страницу', 'save_url')],
    [Markup.button.callback('📜 Мои архивы', 'history'), Markup.button.callback('💰 Баланс', 'balance')],
    [Markup.button.callback('👥 Рефералка', 'referral'), Markup.button.callback('📊 Тарифы', 'tariffs')]
  ]),

  save: Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Вставить ссылку', 'input_url')],
    [Markup.button.callback('🔙 Назад', 'main_menu')]
  ]),

  tariffs: Markup.inlineKeyboard([
    [Markup.button.callback('📅 Неделя — 100₽', 'tariff_week')],
    [Markup.button.callback('📆 Месяц — 300₽', 'tariff_month')],
    [Markup.button.callback('📀 Год — 1000₽', 'tariff_year')],
    [Markup.button.callback('🔙 Назад', 'main_menu')]
  ]),

  back: Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Назад', 'main_menu')]
  ]),

  admin: Markup.inlineKeyboard([
    [Markup.button.callback('📊 Статистика', 'admin_stats')],
    [Markup.button.callback('👥 Список пользователей', 'admin_users')],
    [Markup.button.callback('🎁 Выдать запросы', 'admin_give')],
    [Markup.button.callback('🔙 Главное меню', 'main_menu')]
  ])
};

// ========== АРХИВАЦИЯ ==========
async function archivePage(url, userId) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    clearTimeout(timeout);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : url;
    
    // Сохраняем файл
    const timestamp = Date.now();
    const filename = `${userId}_${timestamp}.html`;
    const filePath = path.join(ARCHIVES_DIR, filename);
    
    fs.writeFileSync(filePath, html, 'utf-8');
    const fileSize = Buffer.byteLength(html, 'utf-8');
    
    return { success: true, title, filePath, fileSize };
  } catch (error) {
    console.error('Archive error:', error.message);
    return { success: false, error: error.message };
  }
}

// ========== ОБРАБОТЧИКИ ==========

// /start
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
          stmts.addRequests.run(4, referrerId);
          
          ctx.reply(
            '🎉 <b>Ты пришёл по реферальной ссылке!</b>\n\n' +
            '✅ Тебе начислено <b>2 бесплатных запроса</b>\n' +
            '✅ Твой друг получил <b>+4 запроса</b>',
            { parse_mode: 'HTML' }
          );
          
          // Уведомление рефереру
          ctx.telegram.sendMessage(
            referrerId,
            `🎁 <b>Новый реферал!</b>\n\n` +
            `Пользователь <b>${escapeHtml(ctx.from.first_name)}</b> присоединился!\n` +
            `🔹 +4 запроса начислено`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
      }
    }
  }
  
  getOrCreateUser(ctx);
  
  ctx.reply(
    '🤖 <b>Lumi Archive</b>\n\n' +
    '💾 Сохраняй веб-страницы в архив!\n\n' +
    '🔹 <b>2 бесплатных запроса</b> при регистрации\n' +
    '🔹 <b>+4 запроса</b> за каждого друга\n' +
    '🔹 Подписки от <b>100₽</b>\n\n' +
    'Выбери действие:',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

// Главное меню
bot.action('main_menu', (ctx) => {
  const user = getOrCreateUser(ctx);
  
  ctx.editMessageText(
    '🤖 <b>Lumi Archive</b>\n\n' +
    `💾 Сохраняй веб-страницы в архив!\n\n` +
    `🔹 Баланс: <b>${user.requests}</b> запросов\n` +
    `🔹 Тариф: <b>${user.subscription_type || 'free'}</b>\n\n` +
    'Выбери действие:',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

// Сохранить URL
bot.action('save_url', (ctx) => {
  ctx.editMessageText(
    '💾 <b>Сохранить страницу</b>\n\n' +
    'Я скачаю страницу, извлеку заголовок и сохраню HTML в архив.\n\n' +
    'Нажми кнопку ниже, чтобы вставить ссылку:',
    { parse_mode: 'HTML', reply_markup: keyboards.save.reply_markup }
  );
});

// Ожидание URL
bot.action('input_url', (ctx) => {
  const userId = ctx.from.id;
  setState(userId, { action: 'waiting_url' });
  
  ctx.editMessageText(
    '📝 <b>Отправь ссылку</b>\n\n' +
    'Пример: <code>https://example.com</code>\n\n' +
    '❗️ Бот скачает страницу и сохранит HTML',
    { parse_mode: 'HTML' }
  );
});

// История
bot.action('history', (ctx) => {
  const userId = ctx.from.id;
  const archives = stmts.getArchives.all(userId);
  
  if (archives.length === 0) {
    return ctx.editMessageText(
      '📜 <b>Мои архивы</b>\n\n' +
      'Пока пусто... Сохрани свою первую страницу!',
      { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
    );
  }
  
  let text = '📜 <b>Мои архивы</b>\n\n';
  archives.forEach((archive, index) => {
    const date = formatDate(archive.saved_at);
    const title = escapeHtml(archive.title || archive.url);
    const size = archive.file_size ? `(${Math.round(archive.file_size / 1024)} KB)` : '';
    text += `${index + 1}. <a href="${archive.url}">${title}</a> ${size}\n`;
    text += `   📅 ${date}\n\n`;
  });
  
  ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboards.back.reply_markup });
});

// Баланс
bot.action('balance', (ctx) => {
  const user = getOrCreateUser(ctx);
  const refCount = stmts.getReferralCount.get(user.id)?.count || 0;
  
  let subText = '';
  if (user.subscription_expires) {
    subText = `\n📅 Подписка до: <b>${formatDate(user.subscription_expires)}</b>\n`;
  }
  
  ctx.editMessageText(
    '💰 <b>Мой баланс</b>\n\n' +
    `🔹 Запросов: <b>${user.requests}</b>\n` +
    `🔹 Рефералов: <b>${refCount}</b>\n` +
    `🔹 Тариф: <b>${user.subscription_type || 'free'}</b>` +
    subText + '\n' +
    '👥 Пригласи друга и получи <b>+4 запроса</b>!',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

// Рефералка
bot.action('referral', (ctx) => {
  const userId = ctx.from.id;
  const refCount = stmts.getReferralCount.get(userId)?.count || 0;
  const link = `https://t.me/${botUsername}?start=ref_${userId}`;
  
  ctx.editMessageText(
    '👥 <b>Реферальная программа</b>\n\n' +
    `🔗 Твоя ссылка:\n<code>${link}</code>\n\n` +
    `🔹 Приглашено: <b>${refCount}</b> чел.\n` +
    `🔹 Бонус: <b>+4 запроса</b> за друга\n\n` +
    '💡 <b>Как пригласить:</b>\n' +
    '1. Скопируй ссылку выше\n' +
    '2. Отправь другу\n' +
    '3. Когда он запустит бота — получишь бонус!',
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

// Тарифы
bot.action('tariffs', (ctx) => {
  ctx.editMessageText(
    '📊 <b>Тарифы</b>\n\n' +
    '<b>📅 Неделя — 100₽</b>\n' +
    '✅ 50 запросов\n\n' +
    '<b>📆 Месяц — 300₽</b>\n' +
    '✅ 200 запросов\n' +
    '✅ Приоритетная поддержка\n\n' +
    '<b>📀 Год — 1000₽</b>\n' +
    '✅ 1000 запросов\n' +
    '✅ Приоритетная поддержка\n' +
    '✅ Ранний доступ к фичам\n\n' +
    '💳 Для покупки напиши: @lumi_support',
    { parse_mode: 'HTML', reply_markup: keyboards.tariffs.reply_markup }
  );
});

// Обработка текстовых сообщений (URL)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const state = getState(userId);
  
  // Админ-команда: выдать запросы
  if (state && state.action === 'admin_give' && isAdmin(ctx)) {
    clearState(userId);
    
    const parts = ctx.text.trim().split(/\s+/);
    if (parts.length !== 2) {
      return ctx.reply(
        '❌ Неверный формат. Используй:\n<code>ID_ПОЛЬЗОВАТЕЛЯ КОЛИЧЕСТВО</code>',
        { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup }
      );
    }
    
    const targetId = parseInt(parts[0]);
    const amount = parseInt(parts[1]);
    
    if (!targetId || !amount) {
      return ctx.reply('❌ Неверные числа', { reply_markup: keyboards.admin.reply_markup });
    }
    
    const target = stmts.getUser.get(targetId);
    if (!target) {
      return ctx.reply('❌ Пользователь не найден', { reply_markup: keyboards.admin.reply_markup });
    }
    
    stmts.addRequests.run(amount, targetId);
    
    ctx.reply(
      `✅ Выдано <b>${amount}</b> запросов пользователю <b>${escapeHtml(target.first_name || targetId)}</b>\n` +
      `Новый баланс: <b>${target.requests + amount}</b>`,
      { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup }
    );
    
    // Уведомляем пользователя
    ctx.telegram.sendMessage(
      targetId,
      `🎁 <b>Бонус от администратора!</b>\n\n` +
      `Тебе начислено <b>${amount}</b> запросов!\n` +
      `Новый баланс: <b>${target.requests + amount}</b>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
    
    return;
  }
  
  // Обычный ввод URL
  if (!state || state.action !== 'waiting_url') {
    return ctx.reply(
      'Используй кнопки ниже 👇',
      { reply_markup: keyboards.main.reply_markup }
    );
  }
  
  clearState(userId);
  
  const url = ctx.text.trim();
  
  // Валидация URL
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return ctx.reply(
      '❌ <b>Некорректная ссылка</b>\n\n' +
      'Отправь полный URL:\n<code>https://example.com</code>',
      { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
    );
  }
  
  const user = getOrCreateUser(ctx);
  
  // Проверка лимита
  if (user.requests <= 0) {
    return ctx.reply(
      '❌ <b>Баланс исчерпан!</b>\n\n' +
      '📊 Купи подписку или пригласи друга:\n' +
      '📅 Неделя — 100₽\n' +
      '📆 Месяц — 300₽\n' +
      '📀 Год — 1000₽\n\n' +
      '👥 Рефералка: /start → Рефералка',
      { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
    );
  }
  
  // Отправляем "печатает..."
  await ctx.replyWithChatAction('typing');
  
  // Архивируем
  const result = await archivePage(url, userId);
  
  if (!result.success) {
    return ctx.reply(
      `❌ <b>Ошибка архивации</b>\n\n` +
      `Не удалось сохранить страницу:\n<code>${escapeHtml(result.error)}</code>\n\n` +
      'Попробуй другую ссылку.',
      { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
    );
  }
  
  // Списываем запрос
  stmts.useRequest.run(userId);
  
  // Сохраняем в БД
  stmts.addArchive.run(userId, url, result.title, result.filePath, result.fileSize);
  
  const updatedUser = stmts.getUser.get(userId);
  
  ctx.reply(
    `✅ <b>Страница сохранена!</b>\n\n` +
    `📄 <b>${escapeHtml(result.title)}</b>\n` +
    `🔗 <a href="${url}">Открыть оригинал</a>\n` +
    `💾 Размер: <b>${Math.round(result.fileSize / 1024)} KB</b>\n\n` +
    `📊 Осталось запросов: <b>${updatedUser.requests}</b>`,
    { parse_mode: 'HTML', reply_markup: keyboards.main.reply_markup }
  );
});

// ========== АДМИН-ПАНЕЛЬ ==========

bot.command('admin', (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply('⛔️ Доступ запрещён');
  }
  
  ctx.reply(
    '🔐 <b>Админ-панель</b>\n\n' +
    'Выбери действие:',
    { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup }
  );
});

bot.action('admin_stats', (ctx) => {
  if (!isAdmin(ctx)) return;
  
  const stats = stmts.getStats.get();
  const archives = stmts.getTotalArchives.get();
  const today = stmts.getTodayArchives.get();
  
  ctx.editMessageText(
    '📊 <b>Статистика бота</b>\n\n' +
    `👥 Пользователей: <b>${stats.total_users}</b>\n` +
    `💰 Всего запросов на балансах: <b>${stats.total_requests}</b>\n` +
    `💾 Всего архивов: <b>${archives.count}</b>\n` +
    `📅 Архивов сегодня: <b>${today.count}</b>`,
    { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup }
  );
});

bot.action('admin_users', (ctx) => {
  if (!isAdmin(ctx)) return;
  
  const users = stmts.getAllUsers.all();
  
  if (users.length === 0) {
    return ctx.editMessageText('Пользователей пока нет.', { reply_markup: keyboards.admin.reply_markup });
  }
  
  let text = '👥 <b>Пользователи</b>\n\n';
  users.slice(0, 20).forEach((u, i) => {
    const name = escapeHtml(u.first_name || u.username || 'Unknown');
    text += `${i + 1}. <b>${name}</b> (ID: <code>${u.user_id}</code>)\n`;
    text += `   Запросов: ${u.requests} | Тариф: ${u.subscription_type}\n`;
    text += `   Рег: ${formatDate(u.created_at)}\n\n`;
  });
  
  if (users.length > 20) {
    text += `\n... и ещё ${users.length - 20} пользователей`;
  }
  
  ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboards.admin.reply_markup });
});

bot.action('admin_give', (ctx) => {
  if (!isAdmin(ctx)) return;
  
  const userId = ctx.from.id;
  setState(userId, { action: 'admin_give' });
  
  ctx.editMessageText(
    '🎁 <b>Выдать запросы</b>\n\n' +
    'Отправь в формате:\n<code>ID_ПОЛЬЗОВАТЕЛЯ КОЛИЧЕСТВО</code>\n\n' +
    'Пример: <code>123456789 10</code>',
    { parse_mode: 'HTML' }
  );
});

// ========== ЗАПУСК ==========
bot.launch();
console.log('🚀 Lumi Archive Bot запущен!');
console.log('🤖 @' + botUsername);
if (ADMIN_ID) console.log('🔐 Админ ID:', ADMIN_ID);

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
